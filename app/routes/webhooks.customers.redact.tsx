import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, payload);

  const customerId = payload?.customer?.id
    ? String(payload.customer.id)
    : null;

  if (customerId) {
    await db.loyaltyEvent.deleteMany({
      where: { shop, customerId: { contains: String(customerId) } },
    });
  }

  return new Response();
};
