import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

interface CustomerRow {
  id: string;
  numericId: string;
  name: string;
  email: string;
  numberOfOrders: number;
  currentPoints: number;
  totalEarned: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() ?? "";

  let customers: CustomerRow[] = [];
  let error: string | null = null;

  try {
    const response = await admin.graphql(
      `#graphql
      query LoyaltyCustomers($query: String) {
        customers(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              displayName
              email
              numberOfOrders
              loyaltyData: metafield(namespace: "$app", key: "loyalty_data") {
                value
              }
            }
          }
        }
      }`,
      { variables: { query: search ? `email:*${search}* OR name:*${search}*` : null } }
    );

    const json: any = await response.json();

    if (json?.errors?.length) {
      throw new Error(json.errors[0]?.message || "GraphQL error");
    }

    const edges: Array<{
      node: {
        id: string;
        displayName: string;
        email: string | null;
        numberOfOrders: number;
        loyaltyData: { value: string } | null;
      };
    }> = json?.data?.customers?.edges ?? [];

    customers = edges.map(({ node }) => {
      let currentPoints = 0;
      let totalEarned = 0;
      if (node.loyaltyData?.value) {
        try {
          const parsed = JSON.parse(node.loyaltyData.value);
          currentPoints = parsed.current_points ?? 0;
          totalEarned = parsed.total_earned_points ?? 0;
        } catch {
          // ignore malformed metafield
        }
      }

      return {
        id: node.id,
        numericId: node.id.replace("gid://shopify/Customer/", ""),
        name: node.displayName || "—",
        email: node.email || "—",
        numberOfOrders: node.numberOfOrders,
        currentPoints,
        totalEarned,
      };
    });
  } catch (err) {
    console.error("Customers list error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    error = `Müşteri listesi yüklenemedi: ${msg}`;
  }

  return { customers, search, error };
};

export default function CustomersList() {
  const { customers, search, error } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const fmt = (n: number) =>
    new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(n);

  if (error) {
    return (
      <s-page heading="Müşteriler">
        <s-section heading="Sadakat Programındaki Müşteriler">
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-paragraph>{error}</s-paragraph>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Müşteriler">
      <s-section heading="Sadakat Programındaki Müşteriler">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const value = (e.currentTarget.elements.namedItem("q") as HTMLInputElement)
              .value;
            setSearchParams(value ? { q: value } : {});
          }}
          style={{ marginBottom: "16px" }}
        >
          <input
            type="text"
            name="q"
            defaultValue={search}
            placeholder="İsim veya e-posta ile ara…"
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
              Müşteri bulunamadı. Müşteriler ilk siparişlerini verdiğinde
              burada listelenecek.
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
                  {["Müşteri", "E-posta", "Sipariş Sayısı", "Mevcut Puan", "Toplam Kazanılan", ""].map(
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
                    key={c.id}
                    style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}
                  >
                    <td style={{ padding: "10px 14px", fontWeight: 500 }}>{c.name}</td>
                    <td style={{ padding: "10px 14px", color: "var(--p-color-text-secondary)" }}>
                      {c.email}
                    </td>
                    <td style={{ padding: "10px 14px" }}>{c.numberOfOrders}</td>
                    <td style={{ padding: "10px 14px", fontWeight: 700, color: "var(--p-color-text-success)" }}>
                      {fmt(c.currentPoints)}
                    </td>
                    <td style={{ padding: "10px 14px", color: "var(--p-color-text-secondary)" }}>
                      {fmt(c.totalEarned)}
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
