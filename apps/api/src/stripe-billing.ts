import { billingPriceId, billingRedirect, billingSubscriptionStatus, workspaceBilling } from "@tideline/contracts";
import { hasOpenSubscription } from "@tideline/db/billing";
import Stripe from "stripe";

function customerId(customer: string | { id: string } | null) {
  return typeof customer === "string" ? customer : customer?.id;
}

export function billingEventCustomer(event: Stripe.Event) {
  if (event.livemode !== false) return;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      if (event.data.object.mode === "subscription") return customerId(event.data.object.customer);
      return;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return customerId(event.data.object.customer);
  }
}

export function createStripeBilling() {
  const { TIDELINE_STRIPE_TEST_SECRET_KEY: key, TIDELINE_STRIPE_WEBHOOK_SECRET: webhookSecret,
    TIDELINE_STRIPE_PRICE_IDS, TIDELINE_STRIPE_API_BASE_URL,
    TIDELINE_WEB_ORIGIN: webOrigin = "http://localhost:3000" } = process.env;
  const priceIds = [...new Set(TIDELINE_STRIPE_PRICE_IDS?.split(",").map((price) => price.trim()).filter(Boolean))];
  if (!key || !/^(?:sk|rk)_test_[A-Za-z0-9_]+$/u.test(key) || !webhookSecret?.startsWith("whsec_") ||
      !priceIds.length || priceIds.length > 8 || priceIds.some((id) => !billingPriceId.safeParse(id).success)) return;

  const web = URL.parse(webOrigin);
  if (!web || !(web.protocol === "https:" || web.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(web.hostname)) ||
      web.username || web.password) return;
  const api = TIDELINE_STRIPE_API_BASE_URL ? URL.parse(TIDELINE_STRIPE_API_BASE_URL) : undefined;
  if (TIDELINE_STRIPE_API_BASE_URL && (!api || api.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(api.hostname) ||
      api.username || api.password || api.pathname !== "/" || api.search || api.hash)) return;
  const stripe = new Stripe(key, {
    timeout: 3_500, maxNetworkRetries: 0, telemetry: false,
    ...(api && { host: api.hostname, port: api.port, protocol: "http" }),
  });
  const billingUrl = (id: string) => new URL(`/workspace/${id}/settings/billing`, web).href;

  async function price(id: string) {
    if (!priceIds.includes(id)) return;
    const price = await stripe.prices.retrieve(id, { expand: ["product"] });
    if (!price.active || price.livemode !== false || !price.recurring || typeof price.product === "string" || price.product.deleted) return;
    const result = workspaceBilling.shape.prices.element.safeParse({
      id: price.id,
      name: price.product.name,
      interval: price.recurring.interval,
      intervalCount: price.recurring.interval_count,
    });
    return result.data;
  }

  async function subscription(customer: string, workspaceId: string) {
    const list = await stripe.subscriptions.list({ customer, status: "all", limit: 100 })
      .autoPagingToArray({ limit: 500 });
    const rows = list.filter((row) => row.livemode === false && customerId(row.customer) === customer &&
      row.metadata.tidelineWorkspace === workspaceId).map((row) => {
      const status = billingSubscriptionStatus.parse(row.status);
      const priceId = billingPriceId.parse(row.items.data[0]?.price.id);
      return { id: row.id, status, priceId, cancelAtPeriodEnd: row.cancel_at_period_end, created: row.created };
    });
    return rows.sort((left, right) => Number(hasOpenSubscription(right.status)) - Number(hasOpenSubscription(left.status)) ||
      right.created - left.created || left.id.localeCompare(right.id))[0] ?? null;
  }

  return {
    price,
    async prices() {
      return (await Promise.all(priceIds.map(price))).filter((row) => row !== undefined);
    },
    subscription,
    async createCustomer({ id }: { id: string }) {
      const customer = await stripe.customers.create({ metadata: { tidelineWorkspace: id } }, { idempotencyKey: `tideline-customer-${id}` });
      if (customer.livemode !== false) throw new Error("Expected a test customer.");
      return customer.id;
    },
    async checkout(state: { workspaceId: string; stripeCustomerId: string; checkoutSessionId: string | null; checkoutPriceId: string | null }, priceId: string) {
      const { workspaceId, stripeCustomerId, checkoutSessionId, checkoutPriceId } = state;
      const current = await subscription(stripeCustomerId, workspaceId);
      if (hasOpenSubscription(current?.status ?? null)) return { kind: "manage" } as const;

      if (checkoutSessionId) {
        const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
        if (session.livemode !== false || customerId(session.customer) !== stripeCustomerId) throw new Error("Checkout customer does not match.");
        if (session.status === "complete" && current?.id !== customerId(session.subscription)) return { kind: "manage" } as const;
        if (session.status === "open" && checkoutPriceId === priceId) {
          return { kind: "checkout", ...billingRedirect.parse({ url: session.url }), checkoutSessionId, checkoutPriceId } as const;
        }
        if (session.status === "open") {
          await stripe.checkout.sessions.expire(checkoutSessionId, {}, { idempotencyKey: `tideline-expire-${checkoutSessionId}` });
        }
      }

      const returnUrl = billingUrl(workspaceId);
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: stripeCustomerId,
        client_reference_id: workspaceId,
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { tidelineWorkspace: workspaceId },
        subscription_data: { metadata: { tidelineWorkspace: workspaceId } },
        success_url: `${returnUrl}?checkout=return`,
        cancel_url: returnUrl,
      }, { idempotencyKey: `tideline-checkout-${workspaceId}-${checkoutSessionId ?? "first"}` });
      if (session.livemode !== false || customerId(session.customer) !== stripeCustomerId) throw new Error("Expected a test Checkout session.");
      return { kind: "checkout", ...billingRedirect.parse({ url: session.url }), checkoutSessionId: session.id, checkoutPriceId: priceId } as const;
    },
    async portal(workspaceId: string, customer: string) {
      const session = await stripe.billingPortal.sessions.create({ customer, return_url: billingUrl(workspaceId) });
      if (session.livemode !== false || session.customer !== customer) throw new Error("Expected a test Customer Portal session.");
      return billingRedirect.parse({ url: session.url });
    },
    verifyWebhook(payload: Uint8Array, signature: string) {
      return stripe.webhooks.constructEventAsync(payload, signature, webhookSecret);
    },
  };
}
