import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

// ─── Loader ──────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [earnAgg, redeemAgg, activeCouponsCount, recentEvents, settings] =
    await Promise.all([
      db.loyaltyEvent.aggregate({
        where: { shop, type: "earn" },
        _sum: { points: true },
      }),
      db.loyaltyEvent.aggregate({
        where: { shop, type: "redeem" },
        _sum: { points: true },
      }),
      db.loyaltyEvent.count({
        where: {
          shop,
          type: "redeem",
          couponUsed: false,
          expiresAt: { gt: new Date() },
        },
      }),
      db.loyaltyEvent.findMany({
        where: { shop },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      db.shopSettings.upsert({
        where: { shop },
        update: {},
        create: { shop },
      }),
    ]);

  return {
    stats: {
      totalEarned: earnAgg._sum.points ?? 0,
      totalSpent: redeemAgg._sum.points ?? 0,
      activeCoupons: activeCouponsCount,
    },
    settings: {
      pointsRate: settings.pointsRate,
      programName: settings.programName,
    },
    recentEvents: recentEvents.map((e) => ({
      id: e.id,
      customerId: e.customerId,
      email: e.email ?? "—",
      type: e.type,
      points: e.points,
      couponCode: e.couponCode ?? null,
      orderId: e.orderId ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
  };
};

// ─── Action ──────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();

  const pointsRateRaw = parseFloat(String(form.get("pointsRate") ?? "3"));
  const programName = String(form.get("programName") ?? "Sadakat Programı").trim();

  // Rate is stored as a decimal (3% → 0.03); clamp between 0.01 and 0.5
  const pointsRate = Math.min(0.5, Math.max(0.01, pointsRateRaw / 100));

  await db.shopSettings.upsert({
    where: { shop },
    update: { pointsRate, programName },
    create: { shop, pointsRate, programName },
  });

  return { success: true };
};

// ─── Component ───────────────────────────────────────────────────────────────
export default function LoyaltyDashboard() {
  const { stats, settings, recentEvents } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isSaving =
    fetcher.state !== "idle" && fetcher.formMethod === "POST";

  const fmt = (n: number) =>
    new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(n);

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat("tr-TR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));

  const usageRate =
    stats.totalEarned > 0
      ? `%${fmt((stats.totalSpent / stats.totalEarned) * 100)}`
      : "—";

  const ratePercent = (settings.pointsRate * 100).toFixed(1);

  return (
    <s-page heading={settings.programName}>
      {/* ── KPI Kartları ── */}
      <s-section heading="Sistem Geneli Metrikler">
        <s-stack direction="inline" gap="base">
          <StatCard
            label="Dağıtılan Toplam Puan"
            value={`${fmt(stats.totalEarned)} puan`}
            sub="Tüm zamanlar, tüm müşteriler"
          />
          <StatCard
            label="Kupona Dönüştürülen"
            value={`${fmt(stats.totalSpent)} puan`}
            sub="Toplam harcanmış puan değeri"
          />
          <StatCard
            label="Aktif Kupon"
            value={`${stats.activeCoupons} adet`}
            sub="Süresi dolmamış, kullanılmamış"
          />
          <StatCard
            label="Kullanım Oranı"
            value={usageRate}
            sub="Kazanılan puanların kullanım oranı"
          />
        </s-stack>
      </s-section>

      {/* ── Aktivite Akışı ── */}
      <s-section heading="Son Aktiviteler">
        {recentEvents.length === 0 ? (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-paragraph>
              Henüz hiç aktivite yok. Müşteriler sipariş verip Puanlarım
              sayfasını ziyaret ettiğinde burada görünecek.
            </s-paragraph>
          </s-box>
        ) : (
          <s-box borderWidth="base" borderRadius="base">
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "13px",
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--p-color-border)",
                    background: "var(--p-color-bg-surface-secondary)",
                  }}
                >
                  {["Tarih", "Müşteri", "İşlem", "Puan", "Referans"].map(
                    (h) => (
                      <th
                        key={h}
                        style={{
                          padding: "10px 14px",
                          textAlign: "left",
                          fontWeight: 600,
                          color: "var(--p-color-text-secondary)",
                        }}
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {recentEvents.map((ev) => (
                  <tr
                    key={ev.id}
                    style={{
                      borderBottom:
                        "1px solid var(--p-color-border-subdued)",
                    }}
                  >
                    <td
                      style={{
                        padding: "10px 14px",
                        color: "var(--p-color-text-secondary)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {fmtDate(ev.createdAt)}
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ fontWeight: 500 }}>{ev.email}</div>
                      <div
                        style={{
                          fontSize: "11px",
                          color: "var(--p-color-text-secondary)",
                        }}
                      >
                        #{ev.customerId}
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 10px",
                          borderRadius: "99px",
                          fontSize: "12px",
                          fontWeight: 600,
                          background:
                            ev.type === "earn"
                              ? "var(--p-color-bg-fill-success-secondary)"
                              : "var(--p-color-bg-fill-info-secondary)",
                          color:
                            ev.type === "earn"
                              ? "var(--p-color-text-success)"
                              : "var(--p-color-text-info)",
                        }}
                      >
                        {ev.type === "earn"
                          ? "Puan Kazandı"
                          : "Kupona Çevirdi"}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontWeight: 600,
                        color:
                          ev.type === "earn"
                            ? "var(--p-color-text-success)"
                            : "var(--p-color-text-critical)",
                      }}
                    >
                      {ev.type === "earn" ? "+" : "−"}
                      {fmt(ev.points)}
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        color: "var(--p-color-text-secondary)",
                        fontFamily: "monospace",
                        fontSize: "12px",
                      }}
                    >
                      {ev.couponCode ??
                        (ev.orderId ? `#${ev.orderId}` : "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-box>
        )}
      </s-section>

      {/* ── Program Ayarları (Aside) ── */}
      <s-section slot="aside" heading="Program Ayarları">
        <fetcher.Form method="POST">
          <s-stack direction="block" gap="base">
            {/* Program Adı */}
            <s-stack direction="block" gap="small">
              <label
                htmlFor="programName"
                style={{
                  display: "block",
                  fontSize: "13px",
                  fontWeight: 600,
                  marginBottom: "4px",
                  color: "var(--p-color-text)",
                }}
              >
                Program Adı
              </label>
              <input
                id="programName"
                name="programName"
                type="text"
                defaultValue={settings.programName}
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

            {/* Puan Oranı */}
            <s-stack direction="block" gap="small">
              <label
                htmlFor="pointsRate"
                style={{
                  display: "block",
                  fontSize: "13px",
                  fontWeight: 600,
                  marginBottom: "4px",
                  color: "var(--p-color-text)",
                }}
              >
                Puan Oranı (%)
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <input
                  id="pointsRate"
                  name="pointsRate"
                  type="number"
                  min="1"
                  max="50"
                  step="0.1"
                  defaultValue={ratePercent}
                  style={{
                    width: "80px",
                    padding: "8px 12px",
                    border: "1px solid var(--p-color-border)",
                    borderRadius: "8px",
                    fontSize: "14px",
                    color: "var(--p-color-text)",
                    background: "var(--p-color-bg-surface)",
                    fontFamily: "inherit",
                  }}
                />
                <span
                  style={{
                    fontSize: "13px",
                    color: "var(--p-color-text-secondary)",
                  }}
                >
                  Sipariş tutarının bu kadarı puan olarak eklenir
                </span>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: "12px",
                  color: "var(--p-color-text-secondary)",
                }}
              >
                Örnek: %{ratePercent} oranıyla 1.000 TL sipariş → {fmt(1000 * settings.pointsRate)} puan
              </p>
            </s-stack>

            <s-button
              type="submit"
              {...(isSaving ? { loading: true } : {})}
            >
              {isSaving ? "Kaydediliyor..." : "Kaydet"}
            </s-button>

            {fetcher.data?.success && !isSaving && (
              <p
                style={{
                  margin: 0,
                  fontSize: "13px",
                  color: "var(--p-color-text-success)",
                  fontWeight: 500,
                }}
              >
                ✓ Ayarlar kaydedildi
              </p>
            )}
          </s-stack>
        </fetcher.Form>
      </s-section>

      {/* ── Nasıl Çalışır (Aside) ── */}
      <s-section slot="aside" heading="Nasıl Çalışır?">
        <s-paragraph>
          Müşteriler Puanlarım sayfasını ziyaret ettiğinde ödedikleri
          siparişler taranır ve her siparişe otomatik puan eklenir.
        </s-paragraph>
        <s-paragraph>
          1 puan = 1 TL indirim. Kuponlar{" "}
          <strong>30 gün</strong> geçerlidir, müşteriye özel ve tek
          kullanımlıktır.
        </s-paragraph>
        <s-paragraph>
          Theme Editor → sayfanıza{" "}
          <strong>Puanlarım</strong> App Block&apos;unu ekleyerek
          müşterilerin bu sayfaya erişmesini sağlayın.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack direction="block" gap="small">
        <s-text>{label}</s-text>
        <s-heading>{value}</s-heading>
        <s-text tone="neutral">{sub}</s-text>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
