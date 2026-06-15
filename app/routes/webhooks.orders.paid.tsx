import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { creditOrder } from "../loyalty.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, admin, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    return new Response();
  }

  const order = payload as {
    id: number | string;
    customer?: { id?: number | string };
    total_price?: string;
    current_total_price?: string;
    financial_status?: string;
  };

  if (order.financial_status !== "paid" || !order.customer?.id) {
    return new Response();
  }

  try {
    const settings = await db.shopSettings.findUnique({ where: { shop } });
    const pointsRate = settings?.pointsRate ?? 0.03;

    const customerId = `gid://shopify/Customer/${order.customer.id}`;
    const orderId = `gid://shopify/Order/${order.id}`;
    const orderTotal = parseFloat(order.current_total_price ?? order.total_price ?? "0");

    await creditOrder(admin.graphql, db, shop, customerId, orderId, orderTotal, pointsRate);
  } catch (error) {
    console.error("orders/paid webhook error:", error);
  }

  return new Response();
};
