/**
 * App Proxy route — handles storefront requests from the Theme App Extension.
 *
 * Store URL:  https://{store}.myshopify.com/apps/loyalty
 * App URL:    https://{app-domain}/proxy
 *
 * GET  /proxy  → sync orders & return customer loyalty data as JSON
 * POST /proxy  → convert points to a new discount code
 *
 * Authentication strategy:
 *   1. authenticate.public.appProxy() verifies the Shopify HMAC signature.
 *   2. If it can't find an offline session (returns admin: undefined) we fall
 *      back to unauthenticated.admin(shop) which uses the stored offline token
 *      directly — safe because the HMAC was already verified in step 1.
 */
/**
 * Resource route: no default component export so React Router treats this as
 * a pure API endpoint and returns the loader/action Response directly.
 *
 * In React Router v7 Vite dev mode, returning a typed Response (not plain data)
 * from the loader bypasses HTML rendering entirely.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import {
  getLoyaltyData,
  updateLoyaltyData,
  syncCustomerOrders,
  createDiscountCode,
  generateCouponCode,
  type LoyaltyCoupon,
} from "../loyalty.server";

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-Requested-With",
  };
}

/** Resolve admin graphql client + shop from proxy context, falling back to
 *  unauthenticated.admin when the proxy context doesn't carry an offline session. */
async function resolveClient(
  request: Request
): Promise<{ gql: (q: string, o?: object) => Promise<{ json: () => Promise<unknown> }>; shop: string } | null> {
  const ctx = await authenticate.public.appProxy(request);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = ctx as any;
  const shop: string =
    c?.session?.shop ??
    new URL(request.url).searchParams.get("shop") ??
    "";

  if (!shop) return null;

  // Happy path: proxy context already has an admin client
  if (c?.admin?.graphql) {
    return { gql: c.admin.graphql, shop };
  }

  // Fallback: HMAC was verified above; use the stored offline token directly
  try {
    const { admin } = await unauthenticated.admin(shop);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { gql: admin.graphql as any, shop };
  } catch {
    return null;
  }
}

// ─── GET / OPTIONS — sync orders then return loyalty data ────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Handle CORS preflight for direct URL override requests
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  const client = await resolveClient(request);

  const url = new URL(request.url);
  const customerIdRaw = url.searchParams.get("logged_in_customer_id");

  if (!client) {
    return Response.json(
      {
        success: false,
        error:
          "Uygulama oturumu bulunamadı. Lütfen mağaza yöneticisine başvurun.",
      },
      { status: 503, headers: corsHeaders() }
    );
  }

  if (!customerIdRaw || customerIdRaw === "0") {
    return Response.json(
      { success: false, error: "Puanlarınızı görmek için giriş yapmalısınız." },
      { status: 401, headers: corsHeaders() }
    );
  }

  // Fetch configurable points rate for this shop
  const settings = await db.shopSettings.findUnique({
    where: { shop: client.shop },
  });
  const pointsRate = settings?.pointsRate ?? 0.03;

  let loyaltyData;
  try {
    loyaltyData = await getLoyaltyData(client.gql, customerIdRaw);

    // On-demand sync: credit any new paid orders (replaces orders/paid webhook)
    const syncResult = await syncCustomerOrders(
      client.gql,
      customerIdRaw,
      loyaltyData,
      db,
      client.shop,
      pointsRate
    );

    if (syncResult.updated) {
      await updateLoyaltyData(client.gql, customerIdRaw, loyaltyData);
    }
  } catch (error) {
    console.error("Loyalty proxy loader error:", error);
    return Response.json(
      {
        success: false,
        error:
          "Sadakat verileri şu anda yüklenemiyor. Lütfen mağaza yöneticisine başvurun.",
      },
      { status: 502, headers: corsHeaders() }
    );
  }

  // Strip expired / used coupons from the storefront response
  const now = new Date();
  const activeCoupons = loyaltyData.active_coupons.filter(
    (c) => !c.used && new Date(c.expires_at) > now
  );

  return Response.json(
    {
      success: true,
      data: {
        total_earned_points: loyaltyData.total_earned_points,
        total_spent_points: loyaltyData.total_spent_points,
        current_points: loyaltyData.current_points,
        active_coupons: activeCoupons,
      },
    },
    { headers: corsHeaders() }
  );
};

// ─── POST — convert points to a new discount code ────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const client = await resolveClient(request);

  const url = new URL(request.url);
  const customerIdRaw = url.searchParams.get("logged_in_customer_id");

  if (!client) {
    return Response.json(
      {
        success: false,
        error:
          "Uygulama oturumu bulunamadı. Lütfen mağaza yöneticisine başvurun.",
      },
      { status: 503, headers: corsHeaders() }
    );
  }

  if (!customerIdRaw || customerIdRaw === "0") {
    return Response.json(
      { success: false, error: "Puanlarınızı kullanmak için giriş yapmalısınız." },
      { status: 401, headers: corsHeaders() }
    );
  }

  let body: { amount?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Geçersiz istek formatı." },
      { status: 400, headers: corsHeaders() }
    );
  }

  const amount = Number(body.amount);
  if (!amount || amount < 1 || !Number.isFinite(amount)) {
    return Response.json(
      { success: false, error: "Geçersiz puan miktarı." },
      { status: 400, headers: corsHeaders() }
    );
  }

  let loyaltyData;
  try {
    loyaltyData = await getLoyaltyData(client.gql, customerIdRaw);
  } catch (error) {
    console.error("Loyalty proxy action error:", error);
    return Response.json(
      {
        success: false,
        error:
          "Sadakat verileri şu anda yüklenemiyor. Lütfen mağaza yöneticisine başvurun.",
      },
      { status: 502, headers: corsHeaders() }
    );
  }

  if ((loyaltyData.current_points || 0) < amount) {
    return Response.json(
      { success: false, error: "Yeterli puanınız bulunmamaktadır." },
      { status: 400, headers: corsHeaders() }
    );
  }

  const code = generateCouponCode(customerIdRaw);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const discountResult = await createDiscountCode(client.gql, {
    customerId: customerIdRaw,
    code,
    amount,
    expiresAt,
  });

  if (!discountResult.success) {
    return Response.json(
      { success: false, error: discountResult.error },
      { status: 500, headers: corsHeaders() }
    );
  }

  const coupon: LoyaltyCoupon = {
    code,
    value: amount,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    used: false,
    discount_id: discountResult.discountId,
  };

  loyaltyData.total_spent_points =
    (loyaltyData.total_spent_points || 0) + amount;
  loyaltyData.current_points = loyaltyData.current_points - amount;
  loyaltyData.active_coupons = [...(loyaltyData.active_coupons || []), coupon];

  await updateLoyaltyData(client.gql, customerIdRaw, loyaltyData);

  await db.loyaltyEvent.create({
    data: {
      shop: client.shop,
      customerId: customerIdRaw,
      type: "redeem",
      points: amount,
      couponCode: code,
      couponValue: amount,
      expiresAt,
    },
  });

  return Response.json(
    { success: true, coupon },
    { headers: corsHeaders() }
  );
};

/**
 * Route-level headers: ensure this route is NEVER treated as an HTML document.
 * React Router v7 merges these headers into every response from this route,
 * preventing Vite from injecting HMR scripts or the app layout.
 */
export function headers() {
  return {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  };
}
