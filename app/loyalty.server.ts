import type { PrismaClient } from "@prisma/client";

export interface LoyaltyCoupon {
  code: string;
  value: number;
  created_at: string;
  expires_at: string;
  used: boolean;
  discount_id?: string;
}

export interface LoyaltyData {
  total_earned_points: number;
  total_spent_points: number;
  current_points: number;
  active_coupons: LoyaltyCoupon[];
  /** IDs of orders that have already been credited (deduplication) */
  credited_order_ids: string[];
  /** ISO timestamp of the last on-demand sync so we don't re-sync too often */
  last_sync_at?: string;
}

const DEFAULT_LOYALTY_DATA: LoyaltyData = {
  total_earned_points: 0,
  total_spent_points: 0,
  current_points: 0,
  active_coupons: [],
  credited_order_ids: [],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GraphQLClient = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ json: () => Promise<any> }>;

function toGid(customerId: string): string {
  return customerId.startsWith("gid://")
    ? customerId
    : `gid://shopify/Customer/${customerId}`;
}

export async function getLoyaltyData(
  graphql: GraphQLClient,
  customerId: string
): Promise<LoyaltyData> {
  const response = await graphql(
    `#graphql
    query GetCustomerLoyalty($customerId: ID!) {
      customer(id: $customerId) {
        loyaltyData: metafield(namespace: "$app", key: "loyalty_data") {
          value
        }
      }
    }`,
    { variables: { customerId: toGid(customerId) } }
  );

  const json = await response.json();
  const rawValue = json?.data?.customer?.loyaltyData?.value;

  if (!rawValue) return structuredClone(DEFAULT_LOYALTY_DATA);

  try {
    const parsed = JSON.parse(rawValue) as LoyaltyData;
    return {
      ...DEFAULT_LOYALTY_DATA,
      ...parsed,
      active_coupons: Array.isArray(parsed.active_coupons) ? parsed.active_coupons : [],
      credited_order_ids: Array.isArray(parsed.credited_order_ids) ? parsed.credited_order_ids : [],
    };
  } catch {
    return structuredClone(DEFAULT_LOYALTY_DATA);
  }
}

export async function updateLoyaltyData(
  graphql: GraphQLClient,
  customerId: string,
  data: LoyaltyData
): Promise<void> {
  await graphql(
    `#graphql
    mutation SetLoyaltyMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            namespace: "$app",
            key: "loyalty_data",
            ownerId: toGid(customerId),
            value: JSON.stringify(data),
            type: "json",
          },
        ],
      },
    }
  );
}

/**
 * On-demand order sync — called when a customer opens the Puanlarım page.
 *
 * Fetches the customer's paid orders from Shopify Admin API and credits any
 * orders that haven't been credited yet. This replaces the orders/paid webhook
 * and works without Protected Customer Data approval.
 *
 * A sync is skipped if one was performed less than SYNC_INTERVAL_MS ago.
 */
const SYNC_INTERVAL_MS = 60 * 1000; // 1 minute

export async function syncCustomerOrders(
  graphql: GraphQLClient,
  customerId: string,
  loyaltyData: LoyaltyData,
  db: PrismaClient,
  shop: string,
  pointsRate = 0.03
): Promise<{ updated: boolean; pointsAdded: number }> {
  const now = new Date();
  const lastSync = loyaltyData.last_sync_at
    ? new Date(loyaltyData.last_sync_at)
    : new Date(0);

  if (now.getTime() - lastSync.getTime() < SYNC_INTERVAL_MS) {
    return { updated: false, pointsAdded: 0 };
  }

  // Fetch up to 50 most recent paid orders for this customer
  const response = await graphql(
    `#graphql
    query GetCustomerPaidOrders($customerId: ID!) {
      customer(id: $customerId) {
        orders(first: 50, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              displayFinancialStatus
              totalPriceSet {
                shopMoney { amount }
              }
            }
          }
        }
      }
    }`,
    { variables: { customerId: toGid(customerId) } }
  );

  const json = await response.json();
  const edges: Array<{
    node: {
      id: string;
      displayFinancialStatus: string;
      totalPriceSet: { shopMoney: { amount: string } };
    };
  }> = json?.data?.customer?.orders?.edges ?? [];

  const creditedSet = new Set(loyaltyData.credited_order_ids);
  let pointsAdded = 0;
  const newlyCredited: string[] = [];

  for (const { node: order } of edges) {
    if (order.displayFinancialStatus !== "PAID") continue;
    if (creditedSet.has(order.id)) continue;

    const orderTotal = parseFloat(order.totalPriceSet.shopMoney.amount);
    if (orderTotal <= 0) continue;

    const points = calcPoints(orderTotal, pointsRate);
    pointsAdded += points;
    newlyCredited.push(order.id);

    // Log to LoyaltyEvent for the admin dashboard
    await db.loyaltyEvent.create({
      data: {
        shop,
        customerId,
        type: "earn",
        points,
        orderId: order.id,
      },
    });
  }

  if (pointsAdded > 0 || newlyCredited.length > 0 || !loyaltyData.last_sync_at) {
    loyaltyData.total_earned_points =
      (loyaltyData.total_earned_points || 0) + pointsAdded;
    loyaltyData.current_points =
      (loyaltyData.current_points || 0) + pointsAdded;
    loyaltyData.credited_order_ids = [
      ...creditedSet,
      ...newlyCredited,
    ];
  }

  // Always update last_sync_at so we don't re-sync too often
  loyaltyData.last_sync_at = now.toISOString();

  return { updated: true, pointsAdded };
}

export async function createDiscountCode(
  graphql: GraphQLClient,
  params: {
    customerId: string;
    code: string;
    amount: number;
    expiresAt: Date;
  }
): Promise<{ success: true; discountId: string } | { success: false; error: string }> {
  const response = await graphql(
    `#graphql
    mutation CreateLoyaltyDiscount($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          title: `Sadakat Kuponu - ${params.code}`,
          code: params.code,
          startsAt: new Date().toISOString(),
          endsAt: params.expiresAt.toISOString(),
          customerSelection: {
            customers: { add: [toGid(params.customerId)] },
          },
          customerGets: {
            value: {
              discountAmount: {
                amount: String(params.amount),
                appliesOnEachItem: false,
              },
            },
            items: { all: true },
          },
          appliesOncePerCustomer: true,
          usageLimit: 1,
        },
      },
    }
  );

  const json = await response.json();
  const result = json?.data?.discountCodeBasicCreate;

  if (result?.userErrors?.length > 0) {
    return { success: false, error: result.userErrors[0].message };
  }

  return {
    success: true,
    discountId: result?.codeDiscountNode?.id ?? "",
  };
}

export function generateCouponCode(customerId: string): string {
  const suffix = String(customerId).replace(/\D/g, "").slice(-4).padStart(4, "0");
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `LOYAL${suffix}${random}`;
}

export function calcPoints(orderTotal: number, rate = 0.03): number {
  return Math.round(orderTotal * rate * 100) / 100;
}
