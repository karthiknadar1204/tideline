import { billingCheckoutRequest, billingRedirect, workspaceBilling, workspaceResponse } from "@tideline/contracts";
import type { createBillingStore } from "@tideline/db/billing";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { billingEventCustomer, createStripeBilling } from "./stripe-billing";
import type { WorkspaceContext } from "./workspace-routes";

const path = "/workspaces/:workspaceId/billing";
const notFound = { error: "Workspace billing not found." };
const unavailable = { error: "Test billing is unavailable." };

function ownerAccess(context: Context<WorkspaceContext>) {
  const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId")).data;
  return workspaceId && { workspaceId: workspaceId.toLowerCase(), userId: context.get("userId") };
}

export function registerBillingRoutes(routes: Hono<WorkspaceContext>, store: ReturnType<typeof createBillingStore>) {
  const stripe = createStripeBilling();

  routes.get(path, async (context) => {
    const access = ownerAccess(context);
    const current = access && await store.read(access);
    if (!current) return context.json(notFound, 404);
    const { state } = current;
    try {
      const prices = stripe ? await stripe.prices() : [];
      const subscription = state?.subscriptionStatus && state.subscriptionPriceId ? {
        priceId: state.subscriptionPriceId, status: state.subscriptionStatus, cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      } : null;
      return context.json(workspaceBilling.parse({
        available: Boolean(stripe),
        hasCustomer: Boolean(state),
        pendingCheckout: Boolean(state?.checkoutSessionId) && !subscription,
        prices,
        subscription,
      }));
    } catch {
      return context.json(unavailable, 503);
    }
  });

  routes.post(`${path}/checkout`, bodyLimit({ maxSize: 1_024 }), async (context) => {
    const access = ownerAccess(context);
    if (!access || !await store.read(access)) return context.json(notFound, 404);
    if (!stripe) return context.json(unavailable, 503);
    const request = billingCheckoutRequest.safeParse(await context.req.json().catch(() => null));
    if (!request.success) return context.json({ error: "Choose an available Stripe price." }, 400);
    try {
      const selected = await stripe.price(request.data.priceId);
      if (!selected) return context.json({ error: "Choose an available Stripe price." }, 400);
      const result = await store.beginCheckout(access, stripe.createCustomer, (state) => stripe.checkout(state, selected.id));
      if (result.kind === "inaccessible") return context.json(notFound, 404);
      if (result.kind === "manage") return context.json({ error: "This workspace has a subscription. Open the Stripe customer portal." }, 409);
      return context.json(billingRedirect.parse({ url: result.url }));
    } catch {
      return context.json(unavailable, 503);
    }
  });

  routes.post(`${path}/portal`, async (context) => {
    const access = ownerAccess(context);
    const current = access && await store.read(access);
    if (!access || !current) return context.json(notFound, 404);
    if (!stripe) return context.json(unavailable, 503);
    if (!current.state) return context.json({ error: "Create a Stripe customer through Checkout first." }, 409);
    try {
      return context.json(await stripe.portal(access.workspaceId, current.state.stripeCustomerId));
    } catch {
      return context.json(unavailable, 503);
    }
  });

  routes.post("/webhooks/stripe", bodyLimit({ maxSize: 256 * 1_024 }), async (context) => {
    if (!stripe) return context.json(unavailable, 503);
    const signature = context.req.header("Stripe-Signature");
    if (!signature) return context.json({ error: "Missing Stripe signature." }, 400);
    const event = await context.req.arrayBuffer()
      .then((payload) => stripe.verifyWebhook(new Uint8Array(payload), signature)).catch(() => null);
    if (!event) return context.json({ error: "Invalid Stripe signature." }, 400);
    const customer = billingEventCustomer(event);
    if (!customer) return context.body(null, 204);
    try {
      await store.syncSubscription(event.id, customer, (workspaceId) => stripe.subscription(customer, workspaceId));
      return context.body(null, 204);
    } catch {
      return context.json({ error: "Could not update the subscription. Retry this event." }, 503);
    }
  });
}
