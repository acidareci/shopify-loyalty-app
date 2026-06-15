import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`, payload);

  // No separate data store of customer PII beyond loyalty points/coupons
  // tied to the customer ID already exposed to the merchant in-app.

  return new Response();
};
