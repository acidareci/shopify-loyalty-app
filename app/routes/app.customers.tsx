import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

function toNumericId(id: string): string {
  return id.startsWith("gid://") ? id.split("/").pop()! : id;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() ?? "";

  // Aggregate from our DB — no bulk customer listing needed
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

  // Batch-fetch customer info from Shopify using nodes query (individual customer IDs — PCD Level 1)
  const top50 = customers.slice(0, 50);
  if (top50.length > 0) {
    try {
      const gids = top50.map((c) => `gid://shopify/Customer/${c.numericId}`);
      const resp = await admin.graphql(
        `#graphql
        query CustomerNodes($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Customer {
              id
              firstName
              lastName
              defaultEmailAddress { emailAddress }
            }
          }
        }`,
        { variables: { ids: gids } }
      );
      // Extract nodes even when admin.graphql() throws due to graphQLErrors (partial success)
      let nodes: any[] = [];
      try {
        const json: any = await resp.json();
        nodes = json?.data?.nodes ?? [];
      } catch {
        // resp.json() may throw if admin.graphql() already threw — extract from err below
      }

      for (const node of nodes) {
        if (!node?.id) continue;
        const numericId = toNumericId(node.id);
        const stat = statsMap.get(numericId);
        if (!stat) continue;
        const fullName = [node.firstName, node.lastName].filter(Boolean).join(" ");
        if (fullName) stat.name = fullName;
        const email = node.defaultEmailAddress?.emailAddress;
        if (email) stat.email = email;
      }
    } catch (err: any) {
      // admin.graphql() throws on graphQLErrors — try to extract partial data
      const nodes: any[] = err?.body?.data?.nodes ?? err?.response?.data?.nodes ?? [];
      for (const node of nodes) {
        if (!node?.id) continue;
        const numericId = toNumericId(node.id);
        const stat = statsMap.get(numericId);
        if (!stat) continue;
        const fullName = [node.firstName, node.lastName].filter(Boolean).join(" ");
        if (fullName) stat.name = fullName;
        const email = node.defaultEmailAddress?.emailAddress;
        if (email) stat.email = email;
      }
      if (!nodes.length) console.error("Customer nodes fetch failed:", err?.message);
    }
  }

  if (search) {
    const q = search.toLowerCase();
    customers = customers.filter(
      (c) =>
        c.numericId.includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q)
    );
  }

  return {
    customers: customers.slice(0, 100).map((c) => ({
      ...c,
      displayLabel: c.name || c.email || `Müşteri #${c.numericId}`,
    })),
    search,
  };
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
            placeholder="İsim, e-posta veya müşteri ID ile ara…"
            style={{
              width: "100%",
              maxWidth: "400px",
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
                  {["Müşteri", "Toplam Kazanılan Puan", "İşlem Sayısı", ""].map(
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
                {customers.map((c) => (
                  <tr
                    key={c.numericId}
                    style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}
                  >
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ fontWeight: 500 }}>{c.displayLabel}</div>
                      {c.email && c.name && (
                        <div style={{ fontSize: "12px", color: "var(--p-color-text-secondary)" }}>
                          {c.email}
                        </div>
                      )}
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
                      <s-link href={`/app/customers/${c.numericId}`}>Detay →</s-link>
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
