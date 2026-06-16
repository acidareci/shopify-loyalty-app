import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

function toNumericId(id: string): string {
  return id.startsWith("gid://") ? id.split("/").pop()! : id;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() ?? "";

  // Get all events for this shop, then aggregate in JS to handle mixed GID/numeric IDs
  const events = await db.loyaltyEvent.findMany({
    where: { shop },
    select: { customerId: true, email: true, type: true, points: true },
  });

  // Normalize all customer IDs to numeric
  type CustomerStats = {
    numericId: string;
    email: string;
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
        email: ev.email ?? "—",
        totalEarned: ev.type === "earn" ? ev.points : 0,
        eventCount: 1,
      });
    } else {
      if (ev.email && existing.email === "—") existing.email = ev.email;
      if (ev.type === "earn") existing.totalEarned += ev.points;
      existing.eventCount += 1;
    }
  }

  let customers = [...statsMap.values()].sort((a, b) => b.totalEarned - a.totalEarned);

  if (search) {
    const q = search.toLowerCase();
    customers = customers.filter(
      (c) =>
        c.numericId.includes(q) || c.email.toLowerCase().includes(q)
    );
  }

  return { customers: customers.slice(0, 100), search };
};

export default function CustomersList() {
  const { customers, search } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const fmt = (n: number) =>
    new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(n);

  return (
    <s-page heading="Müşteriler">
      <s-section heading="Sadakat Programındaki Müşteriler">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const value = (
              e.currentTarget.elements.namedItem("q") as HTMLInputElement
            ).value;
            setSearchParams(value ? { q: value } : {});
          }}
          style={{ marginBottom: "16px" }}
        >
          <input
            type="text"
            name="q"
            defaultValue={search}
            placeholder="Müşteri ID veya e-posta ile ara…"
            style={{
              width: "100%",
              maxWidth: "360px",
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
        </form>

        {customers.length === 0 ? (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-paragraph>
              Henüz sadakat programını kullanan müşteri yok. Müşteriler
              sipariş verdiğinde burada görünecek.
            </s-paragraph>
          </s-box>
        ) : (
          <s-box borderWidth="base" borderRadius="base">
            <table
              style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--p-color-border)",
                    background: "var(--p-color-bg-surface-secondary)",
                  }}
                >
                  {["Müşteri", "Toplam Kazanılan Puan", "İşlem Sayısı", ""].map((h) => (
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
                  ))}
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr
                    key={c.numericId}
                    style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}
                  >
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ fontWeight: 500 }}>
                        {c.email !== "—" ? c.email : `Müşteri #${c.numericId}`}
                      </div>
                      <div style={{ fontSize: "11px", color: "var(--p-color-text-secondary)" }}>
                        #{c.numericId}
                      </div>
                    </td>
                    <td
                      style={{
                        padding: "10px 14px",
                        fontWeight: 700,
                        color: "var(--p-color-text-success)",
                      }}
                    >
                      {fmt(c.totalEarned)}
                    </td>
                    <td style={{ padding: "10px 14px", color: "var(--p-color-text-secondary)" }}>
                      {c.eventCount}
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <Link to={`/app/customers/${c.numericId}`}>Detay →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
