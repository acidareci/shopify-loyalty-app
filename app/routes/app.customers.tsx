import type { HeadersFunction, LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getLoyaltyData, updateLoyaltyData } from "../loyalty.server";
import db from "../db.server";
import { useState } from "react";

function toNumericId(id: string): string {
  return id.startsWith("gid://") ? id.split("/").pop()! : id;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() ?? "";

  const events = await db.loyaltyEvent.findMany({
    where: { shop },
    select: { customerId: true, email: true, type: true, points: true },
  });

  type CustomerStats = {
    numericId: string;
    email: string;
    name: string;
    totalEarned: number;
    eventCount: number;
  };
  const statsMap = new Map<string, CustomerStats>();

  for (const ev of events) {
    const numericId = toNumericId(ev.customerId);
    const existing = statsMap.get(numericId);
    if (!existing) {
      statsMap.set(numericId, {
        numericId,
        email: ev.email ?? "",
        name: "",
        totalEarned: ev.type === "earn" ? ev.points : 0,
        eventCount: 1,
      });
    } else {
      if (ev.email && !existing.email) existing.email = ev.email;
      if (ev.type === "earn") existing.totalEarned += ev.points;
      existing.eventCount += 1;
    }
  }

  let customers = [...statsMap.values()].sort((a, b) => b.totalEarned - a.totalEarned);

  if (search) {
    const q = search.toLowerCase();
    customers = customers.filter(
      (c) =>
        c.numericId.includes(q) ||
        c.email.toLowerCase().includes(q)
    );
  }

  return {
    customers: customers.slice(0, 100).map((c) => ({
      ...c,
      displayLabel: c.email || `Müşteri #${c.numericId}`,
    })),
    search,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "load_detail") {
    const numericId = String(form.get("numericId"));
    const customerId = `gid://shopify/Customer/${numericId}`;

    let customer = null;
    let loyaltyData = await getLoyaltyData(admin.graphql, customerId).catch(() => null);

    try {
      const res = await admin.graphql(
        `#graphql
        query($id: ID!) {
          customer(id: $id) {
            id firstName lastName email phone
            numberOfOrders
            amountSpent { amount currencyCode }
            createdAt
          }
        }`,
        { variables: { id: customerId } }
      );
      const j: any = await res.json();
      customer = j?.data?.customer ?? null;
    } catch (err: any) {
      customer = err?.body?.data?.customer ?? null;
    }

    if (!loyaltyData) {
      loyaltyData = { total_earned_points: 0, total_spent_points: 0, current_points: 0, active_coupons: [], credited_order_ids: [] };
    }

    const gidId = `gid://shopify/Customer/${numericId}`;
    const shopEvents = await db.loyaltyEvent.findMany({
      where: { shop: session.shop, OR: [{ customerId: numericId }, { customerId: gidId }] },
      orderBy: { createdAt: "desc" },
      take: 30,
    });

    return {
      ok: true,
      numericId,
      customer: customer ? {
        name: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || `#${numericId}`,
        email: customer.email || "—",
        phone: customer.phone || "—",
        numberOfOrders: customer.numberOfOrders ?? 0,
        amountSpent: customer.amountSpent?.amount ?? "0",
        currency: customer.amountSpent?.currencyCode ?? "TRY",
      } : null,
      loyaltyData,
      events: shopEvents.map((e) => ({
        id: e.id, type: e.type, points: e.points,
        couponCode: e.couponCode, orderId: e.orderId,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  if (intent === "manual_points") {
    const numericId = String(form.get("numericId"));
    const customerId = `gid://shopify/Customer/${numericId}`;
    const direction = String(form.get("direction") ?? "add");
    const amount = Math.abs(parseFloat(String(form.get("amount") ?? "0")));
    const reason = String(form.get("reason") ?? "").trim();

    if (!amount || amount <= 0) return { ok: false, error: "Geçerli bir puan miktarı girin." };

    const loyaltyData = await getLoyaltyData(admin.graphql, customerId);

    if (direction === "remove") {
      if (amount > (loyaltyData.current_points || 0)) return { ok: false, error: "Müşterinin yeterli puanı yok." };
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

    return { ok: true, saved: true, numericId };
  }

  return { ok: false, error: "Bilinmeyen işlem." };
};

export default function CustomersList() {
  const { customers, search } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(null);
  const detailFetcher = useFetcher<any>();
  const pointsFetcher = useFetcher<any>();

  const fmt = (n: number) =>
    new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(n);
  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat("tr-TR", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

  const handleOpen = (numericId: string) => {
    if (openId === numericId) { setOpenId(null); return; }
    setOpenId(numericId);
    const fd = new FormData();
    fd.append("intent", "load_detail");
    fd.append("numericId", numericId);
    detailFetcher.submit(fd, { method: "POST" });
  };

  const detail = detailFetcher.data?.ok ? detailFetcher.data : null;
  const isSaving = pointsFetcher.state !== "idle";

  return (
    <s-page heading="Müşteriler">
      <s-section heading="Sadakat Programındaki Müşteriler">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const value = (e.currentTarget.elements.namedItem("q") as HTMLInputElement).value;
            setSearchParams(value ? { q: value } : {});
          }}
          style={{ marginBottom: "16px" }}
        >
          <input
            type="text" name="q" defaultValue={search}
            placeholder="E-posta veya müşteri ID ile ara…"
            style={{ width: "100%", maxWidth: "400px", boxSizing: "border-box", padding: "8px 12px", border: "1px solid var(--p-color-border)", borderRadius: "8px", fontSize: "14px", color: "var(--p-color-text)", background: "var(--p-color-bg-surface)", fontFamily: "inherit" }}
          />
        </form>

        {customers.length === 0 ? (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-paragraph>Henüz sadakat programını kullanan müşteri yok.</s-paragraph>
          </s-box>
        ) : (
          <div>
            {customers.map((c) => {
              const isOpen = openId === c.numericId;
              const isLoading = isOpen && detailFetcher.state !== "idle";
              const showDetail = isOpen && detail && detail.numericId === c.numericId;

              return (
                <div key={c.numericId} style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}>
                  {/* Satır */}
                  <div
                    style={{ display: "flex", alignItems: "center", padding: "12px 14px", cursor: "pointer", gap: "16px", background: isOpen ? "var(--p-color-bg-surface-secondary)" : "transparent" }}
                    onClick={() => handleOpen(c.numericId)}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500, fontSize: "13px" }}>{c.displayLabel}</div>
                      <div style={{ fontSize: "11px", color: "var(--p-color-text-secondary)" }}>#{c.numericId}</div>
                    </div>
                    <div style={{ textAlign: "right", minWidth: "100px" }}>
                      <div style={{ fontWeight: 700, color: "var(--p-color-text-success)", fontSize: "13px" }}>{fmt(c.totalEarned)} puan</div>
                      <div style={{ fontSize: "11px", color: "var(--p-color-text-secondary)" }}>{c.eventCount} işlem</div>
                    </div>
                    <div style={{ fontSize: "18px", color: "var(--p-color-text-secondary)", userSelect: "none" }}>
                      {isOpen ? "▲" : "▼"}
                    </div>
                  </div>

                  {/* Detay Panel */}
                  {isOpen && (
                    <div style={{ background: "var(--p-color-bg-surface)", borderTop: "1px solid var(--p-color-border-subdued)", padding: "16px 20px" }}>
                      {isLoading && <p style={{ color: "var(--p-color-text-secondary)", fontSize: "13px" }}>Yükleniyor…</p>}

                      {showDetail && (
                        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
                          {/* Sol: Bilgiler */}
                          <div style={{ flex: "1 1 300px" }}>
                            {/* Müşteri bilgileri */}
                            {detail.customer && (
                              <div style={{ marginBottom: "16px", padding: "12px", background: "var(--p-color-bg-surface-secondary)", borderRadius: "8px", fontSize: "13px" }}>
                                <div style={{ fontWeight: 600, marginBottom: "8px", color: "var(--p-color-text)" }}>Müşteri Bilgileri</div>
                                <div><span style={{ color: "var(--p-color-text-secondary)" }}>İsim: </span>{detail.customer.name}</div>
                                <div><span style={{ color: "var(--p-color-text-secondary)" }}>E-posta: </span>{detail.customer.email}</div>
                                <div><span style={{ color: "var(--p-color-text-secondary)" }}>Sipariş: </span>{detail.customer.numberOfOrders}</div>
                                <div><span style={{ color: "var(--p-color-text-secondary)" }}>Harcama: </span>{fmt(parseFloat(detail.customer.amountSpent))} {detail.customer.currency}</div>
                              </div>
                            )}

                            {/* Puan özeti */}
                            <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
                              {[
                                { l: "Mevcut Puan", v: fmt(detail.loyaltyData.current_points), hi: true },
                                { l: "Toplam Kazanılan", v: fmt(detail.loyaltyData.total_earned_points) },
                                { l: "Toplam Kullanılan", v: fmt(detail.loyaltyData.total_spent_points) },
                              ].map((s) => (
                                <div key={s.l} style={{ flex: "1 1 100px", padding: "10px 12px", background: "var(--p-color-bg-surface-secondary)", borderRadius: "8px", fontSize: "12px" }}>
                                  <div style={{ color: "var(--p-color-text-secondary)", marginBottom: "4px" }}>{s.l}</div>
                                  <div style={{ fontWeight: 700, fontSize: "15px", color: s.hi ? "var(--p-color-text-success)" : "var(--p-color-text)" }}>{s.v}</div>
                                </div>
                              ))}
                            </div>

                            {/* Son olaylar */}
                            {detail.events.length > 0 && (
                              <div>
                                <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "8px" }}>Son Hareketler</div>
                                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                                  <thead>
                                    <tr style={{ borderBottom: "1px solid var(--p-color-border)" }}>
                                      {["Tarih", "İşlem", "Puan", "Ref"].map((h) => (
                                        <th key={h} style={{ padding: "6px 10px", textAlign: "left", color: "var(--p-color-text-secondary)", fontWeight: 600 }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {detail.events.map((ev: any) => (
                                      <tr key={ev.id} style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}>
                                        <td style={{ padding: "6px 10px", color: "var(--p-color-text-secondary)", whiteSpace: "nowrap" }}>{fmtDate(ev.createdAt)}</td>
                                        <td style={{ padding: "6px 10px" }}>{ev.type === "earn" ? "Kazandı" : "Kullandı"}</td>
                                        <td style={{ padding: "6px 10px", fontWeight: 600, color: ev.type === "earn" ? "var(--p-color-text-success)" : "var(--p-color-text-critical)" }}>
                                          {ev.type === "earn" ? "+" : "−"}{fmt(ev.points)}
                                        </td>
                                        <td style={{ padding: "6px 10px", color: "var(--p-color-text-secondary)", fontFamily: "monospace", fontSize: "11px" }}>
                                          {ev.couponCode ?? (ev.orderId ? `#${ev.orderId}` : "—")}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>

                          {/* Sağ: Manuel puan */}
                          <div style={{ flex: "0 0 220px" }}>
                            <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "10px" }}>Manuel Puan İşlemi</div>
                            <pointsFetcher.Form method="POST" onSubmit={() => {}}>
                              <input type="hidden" name="intent" value="manual_points" />
                              <input type="hidden" name="numericId" value={c.numericId} />
                              <div style={{ marginBottom: "10px" }}>
                                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>İşlem</label>
                                <select name="direction" defaultValue="add" style={{ width: "100%", padding: "7px 10px", border: "1px solid var(--p-color-border)", borderRadius: "6px", fontSize: "13px", background: "var(--p-color-bg-surface)", color: "var(--p-color-text)" }}>
                                  <option value="add">Puan Ekle</option>
                                  <option value="remove">Puan Çıkar</option>
                                </select>
                              </div>
                              <div style={{ marginBottom: "10px" }}>
                                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>Miktar</label>
                                <input name="amount" type="number" min="0.01" step="0.01" required placeholder="100" style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", border: "1px solid var(--p-color-border)", borderRadius: "6px", fontSize: "13px", background: "var(--p-color-bg-surface)", color: "var(--p-color-text)" }} />
                              </div>
                              <div style={{ marginBottom: "10px" }}>
                                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>Not</label>
                                <input name="reason" type="text" placeholder="Doğum günü hediyesi" style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", border: "1px solid var(--p-color-border)", borderRadius: "6px", fontSize: "13px", background: "var(--p-color-bg-surface)", color: "var(--p-color-text)" }} />
                              </div>
                              <button type="submit" disabled={isSaving} style={{ width: "100%", padding: "8px", background: "var(--p-color-bg-fill-brand)", color: "#fff", border: "none", borderRadius: "6px", fontSize: "13px", fontWeight: 600, cursor: isSaving ? "not-allowed" : "pointer", opacity: isSaving ? 0.7 : 1 }}>
                                {isSaving ? "Kaydediliyor…" : "Uygula"}
                              </button>
                              {pointsFetcher.data?.saved && !isSaving && (
                                <p style={{ margin: "8px 0 0", fontSize: "12px", color: "var(--p-color-text-success)", fontWeight: 500 }}>✓ Güncellendi</p>
                              )}
                              {pointsFetcher.data?.error && !isSaving && (
                                <p style={{ margin: "8px 0 0", fontSize: "12px", color: "var(--p-color-text-critical)" }}>{pointsFetcher.data.error}</p>
                              )}
                            </pointsFetcher.Form>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
