import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { getLoyaltyData, updateLoyaltyData } from "../loyalty.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const numericId = params.id as string;
  const customerId = `gid://shopify/Customer/${numericId}`;

  let customer = null;
  let error: string | null = null;
  let loyaltyData = await getLoyaltyData(admin.graphql, customerId).catch(() => null);

  // Only query fields that don't require PCD (name/email fields return null regardless)
  try {
    const customerResponse = await admin.graphql(
      `#graphql
      query LoyaltyCustomer($id: ID!) {
        customer(id: $id) {
          id
          numberOfOrders
          amountSpent { amount currencyCode }
          createdAt
        }
      }`,
      { variables: { id: customerId } }
    );

    const customerJson: any = await customerResponse.json();
    const raw = customerJson?.data?.customer ?? null;
    if (raw) {
      customer = {
        numericId,
        numberOfOrders: raw.numberOfOrders ?? 0,
        amountSpent: raw.amountSpent?.amount ?? "0",
        currency: raw.amountSpent?.currencyCode ?? "TRY",
        createdAt: raw.createdAt ?? null,
      };
    }
  } catch (err: any) {
    const raw = err?.body?.data?.customer ?? err?.response?.data?.customer ?? null;
    if (raw) {
      customer = {
        numericId,
        numberOfOrders: raw.numberOfOrders ?? 0,
        amountSpent: raw.amountSpent?.amount ?? "0",
        currency: raw.amountSpent?.currencyCode ?? "TRY",
        createdAt: raw.createdAt ?? null,
      };
    } else {
      // Non-fatal — still show loyalty data
      console.error("Customer detail error:", err?.message ?? err);
    }
  }

  if (!loyaltyData) {
    loyaltyData = {
      total_earned_points: 0,
      total_spent_points: 0,
      current_points: 0,
      active_coupons: [],
      credited_order_ids: [],
    };
  }

  // Customer IDs in DB can be numeric or GID — match both formats
  const gidId = `gid://shopify/Customer/${numericId}`;
  const shopEvents = await db.loyaltyEvent.findMany({
    where: {
      shop: session.shop,
      OR: [{ customerId: numericId }, { customerId: gidId }],
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return {
    numericId,
    error,
    customer: customer
      ?? null,
    loyaltyData,
    events: shopEvents.map((e) => ({
      id: e.id,
      type: e.type,
      points: e.points,
      couponCode: e.couponCode,
      orderId: e.orderId,
      createdAt: e.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const numericId = params.id as string;
  const customerId = `gid://shopify/Customer/${numericId}`;
  const form = await request.formData();

  const direction = String(form.get("direction") ?? "add"); // "add" | "remove"
  const amount = Math.abs(parseFloat(String(form.get("amount") ?? "0")));
  const reason = String(form.get("reason") ?? "").trim();

  if (!amount || amount <= 0) {
    return { success: false, error: "Geçerli bir puan miktarı girin." };
  }

  const loyaltyData = await getLoyaltyData(admin.graphql, customerId);

  if (direction === "remove") {
    if (amount > (loyaltyData.current_points || 0)) {
      return { success: false, error: "Müşterinin yeterli puanı yok." };
    }
    loyaltyData.current_points -= amount;
    loyaltyData.total_spent_points = (loyaltyData.total_spent_points || 0) + amount;
  } else {
    loyaltyData.current_points = (loyaltyData.current_points || 0) + amount;
    loyaltyData.total_earned_points = (loyaltyData.total_earned_points || 0) + amount;
  }

  await updateLoyaltyData(admin.graphql, customerId, loyaltyData);

  await db.loyaltyEvent.create({
    data: {
      shop: session.shop,
      customerId: numericId,
      type: direction === "remove" ? "redeem" : "earn",
      points: amount,
      couponCode: `MANUEL${reason ? `: ${reason}` : ""}`,
    },
  });

  return { success: true };
};

export default function CustomerDetail() {
  const { numericId, customer, loyaltyData, events, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isSaving = fetcher.state !== "idle" && fetcher.formMethod === "POST";

  const fmt = (n: number) =>
    new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(n);

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat("tr-TR", { dateStyle: "short", timeStyle: "short" }).format(
      new Date(iso)
    );

  return (
    <s-page heading={`Müşteri #${numericId}`}>
      {customer && (
        <s-section heading="Müşteri Bilgileri">
          <s-stack direction="inline" gap="base">
            <InfoCard label="Sipariş Sayısı" value={String(customer.numberOfOrders)} />
            <InfoCard
              label="Toplam Harcama"
              value={`${fmt(parseFloat(customer.amountSpent))} ${customer.currency}`}
            />
            {customer.createdAt && (
              <InfoCard label="Üye Tarihi" value={fmtDate(customer.createdAt)} />
            )}
          </s-stack>
        </s-section>
      )}

      <s-section heading="Sadakat Puanları">
        <s-stack direction="inline" gap="base">
          <StatCard label="Mevcut Puan" value={fmt(loyaltyData.current_points)} highlight />
          <StatCard label="Toplam Kazanılan" value={fmt(loyaltyData.total_earned_points)} />
          <StatCard label="Toplam Kullanılan" value={fmt(loyaltyData.total_spent_points)} />
          <StatCard label="Aktif Kupon" value={String(loyaltyData.active_coupons.filter((c) => !c.used).length)} />
        </s-stack>
      </s-section>

      <s-section heading="Kuponlar">
        {loyaltyData.active_coupons.length === 0 ? (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-paragraph>Bu müşterinin hiç kuponu yok.</s-paragraph>
          </s-box>
        ) : (
          <s-box borderWidth="base" borderRadius="base">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--p-color-border)",
                    background: "var(--p-color-bg-surface-secondary)",
                  }}
                >
                  {["Kod", "Tutar", "Oluşturulma", "Son Kullanma", "Durum"].map((h) => (
                    <th
                      key={h}
                      style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, color: "var(--p-color-text-secondary)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...loyaltyData.active_coupons]
                  .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                  .map((c) => {
                    const expired = new Date(c.expires_at).getTime() <= Date.now();
                    const status = c.used ? "Kullanıldı" : expired ? "Süresi Doldu" : "Aktif";
                    return (
                      <tr key={c.code} style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}>
                        <td style={{ padding: "10px 14px", fontFamily: "monospace", fontWeight: 600 }}>{c.code}</td>
                        <td style={{ padding: "10px 14px" }}>{fmt(c.value)}</td>
                        <td style={{ padding: "10px 14px", color: "var(--p-color-text-secondary)" }}>{fmtDate(c.created_at)}</td>
                        <td style={{ padding: "10px 14px", color: "var(--p-color-text-secondary)" }}>{fmtDate(c.expires_at)}</td>
                        <td style={{ padding: "10px 14px" }}>{status}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </s-box>
        )}
      </s-section>

      <s-section heading="Puan Geçmişi">
        {events.length === 0 ? (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-paragraph>Henüz hiç puan hareketi yok.</s-paragraph>
          </s-box>
        ) : (
          <s-box borderWidth="base" borderRadius="base">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--p-color-border)",
                    background: "var(--p-color-bg-surface-secondary)",
                  }}
                >
                  {["Tarih", "İşlem", "Puan", "Referans"].map((h) => (
                    <th
                      key={h}
                      style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, color: "var(--p-color-text-secondary)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id} style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}>
                    <td style={{ padding: "10px 14px", color: "var(--p-color-text-secondary)", whiteSpace: "nowrap" }}>
                      {fmtDate(ev.createdAt)}
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      {ev.type === "earn" ? "Puan Kazandı" : "Kupona Çevirdi / Kullanıldı"}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontWeight: 600,
                        color: ev.type === "earn" ? "var(--p-color-text-success)" : "var(--p-color-text-critical)",
                      }}
                    >
                      {ev.type === "earn" ? "+" : "−"}
                      {fmt(ev.points)}
                    </td>
                    <td style={{ padding: "10px 14px", color: "var(--p-color-text-secondary)", fontFamily: "monospace", fontSize: "12px" }}>
                      {ev.couponCode ?? (ev.orderId ? `#${ev.orderId}` : "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-box>
        )}
      </s-section>

      <s-section slot="aside" heading="Manuel Puan İşlemi">
        <fetcher.Form method="POST">
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="small">
              <label
                htmlFor="direction"
                style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px", color: "var(--p-color-text)" }}
              >
                İşlem
              </label>
              <select
                id="direction"
                name="direction"
                defaultValue="add"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 12px",
                  border: "1px solid var(--p-color-border)",
                  borderRadius: "8px",
                  fontSize: "14px",
                  color: "var(--p-color-text)",
                  background: "var(--p-color-bg-surface)",
                  fontFamily: "inherit",
                }}
              >
                <option value="add">Puan Ekle</option>
                <option value="remove">Puan Çıkar</option>
              </select>
            </s-stack>

            <s-stack direction="block" gap="small">
              <label
                htmlFor="amount"
                style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px", color: "var(--p-color-text)" }}
              >
                Miktar
              </label>
              <input
                id="amount"
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                required
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 12px",
                  border: "1px solid var(--p-color-border)",
                  borderRadius: "8px",
                  fontSize: "14px",
                  color: "var(--p-color-text)",
                  background: "var(--p-color-bg-surface)",
                  fontFamily: "inherit",
                }}
              />
            </s-stack>

            <s-stack direction="block" gap="small">
              <label
                htmlFor="reason"
                style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px", color: "var(--p-color-text)" }}
              >
                Not (isteğe bağlı)
              </label>
              <input
                id="reason"
                name="reason"
                type="text"
                placeholder="Örn: Doğum günü hediyesi"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 12px",
                  border: "1px solid var(--p-color-border)",
                  borderRadius: "8px",
                  fontSize: "14px",
                  color: "var(--p-color-text)",
                  background: "var(--p-color-bg-surface)",
                  fontFamily: "inherit",
                }}
              />
            </s-stack>

            <s-button type="submit" {...(isSaving ? { loading: true } : {})}>
              {isSaving ? "Kaydediliyor..." : "Uygula"}
            </s-button>

            {fetcher.data?.success === true && !isSaving && (
              <p style={{ margin: 0, fontSize: "13px", color: "var(--p-color-text-success)", fontWeight: 500 }}>
                ✓ Puan güncellendi
              </p>
            )}
            {fetcher.data?.success === false && !isSaving && (
              <p style={{ margin: 0, fontSize: "13px", color: "var(--p-color-text-critical)", fontWeight: 500 }}>
                {fetcher.data.error}
              </p>
            )}
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section slot="aside" heading="">
        <s-link href="/app/customers">← Müşteri listesine dön</s-link>
      </s-section>
    </s-page>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="small">
        <s-text>{label}</s-text>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="small">
        <s-text>{label}</s-text>
        <s-heading>
          <span style={highlight ? { color: "var(--p-color-text-success)" } : undefined}>{value}</span>
        </s-heading>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
