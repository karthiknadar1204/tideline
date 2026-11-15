import { workspaceBilling } from "@tideline/contracts";
import type { BillingSubscriptionStatus } from "@tideline/contracts";
import { notFound } from "next/navigation";
import { teamPanel } from "../../../../../lib/team-ui";
import { fetchWorkspaceResource, readWorkspaceAccess } from "../../../../../lib/workspace";
import { openBilling } from "./actions";

const labels: Record<BillingSubscriptionStatus, string> = {
  incomplete: "Payment incomplete",
  incomplete_expired: "Checkout expired",
  trialing: "Trial",
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
  unpaid: "Unpaid",
  paused: "Paused",
};
const button = "w-fit min-h-10 rounded-lg bg-[var(--workspace-button)] px-4 text-sm font-semibold text-[var(--workspace-button-text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)]";

export default async function BillingPage({ params, searchParams }: PageProps<"/workspace/[id]/settings/billing">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const workspace = await readWorkspaceAccess(id);
  if (workspace.role !== "owner") notFound();
  const response = await fetchWorkspaceResource(`${encodeURIComponent(id)}/billing`);
  const result = workspaceBilling.safeParse(response?.ok ? await response.json().catch(() => null) : null);
  const billing = result.data;
  const subscription = billing?.subscription;
  const acceptingChanges = Boolean(billing?.available);
  const canSubscribe = !subscription || subscription.status === "canceled" || subscription.status === "incomplete_expired";
  const subscribedPrice = subscription && billing?.prices.find(({ id }) => id === subscription.priceId);

  return (
    <main className="grid max-w-4xl gap-4" aria-label="Billing settings">
      <section className={teamPanel} aria-labelledby="workspace-billing">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold" id="workspace-billing">Workspace billing</h2>
          {acceptingChanges && <span className="rounded-md bg-[var(--workspace-subtle)] px-2 py-1 text-xs">Stripe test mode</span>}
        </div>
        {!billing ? <p className="text-sm text-[var(--workspace-muted)]">Billing is temporarily unavailable.</p> : (
          <>
            <dl className="grid gap-3 border-t border-[var(--workspace-border)] pt-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-[var(--workspace-muted)]">Subscription</dt>
                <dd className="mt-1 text-sm font-medium">{subscription ? labels[subscription.status] : "No subscription"}</dd>
              </div>
              {subscribedPrice && <div>
                <dt className="text-xs text-[var(--workspace-muted)]">Stripe product</dt>
                <dd className="mt-1 break-words text-sm font-medium">{subscribedPrice.name}</dd>
              </div>}
            </dl>
            {subscription?.cancelAtPeriodEnd && <p className="text-sm text-[var(--workspace-muted)]">Stripe is set to cancel at the end of this billing period.</p>}
            {query.checkout === "return" && <p role="status" className="text-sm text-[var(--workspace-muted)]">This page updates after Stripe confirms your subscription.</p>}
            {query.status === "failed" && <p role="alert" className="text-sm">Could not open Stripe. Try again.</p>}
            {query.status === "manage" && <p role="status" className="text-sm">Use the Stripe customer portal to manage your subscription.</p>}
            {acceptingChanges && billing.hasCustomer && (
              <form action={openBilling.bind(null, id, "portal")}>
                <button className={button} type="submit">Open Stripe customer portal</button>
              </form>
            )}
            {!acceptingChanges && <p className="text-sm text-[var(--workspace-muted)]">Stripe test billing is unconfigured.</p>}
          </>
        )}
      </section>
      {billing?.available && canSubscribe && (
        <section className={teamPanel} aria-labelledby="billing-test-prices">
          <h2 id="billing-test-prices" className="font-semibold">Subscription options</h2>
          {billing.prices.length > 0 ? (
            <ul className="divide-y divide-[var(--workspace-border)]">
              {billing.prices.map(({ id: priceId, name, interval, intervalCount }) => (
                <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={priceId}>
                  <div className="min-w-0">
                    <div className="break-words text-sm font-semibold">{name}</div>
                    <p className="mt-1 text-xs text-[var(--workspace-muted)]">
                      {intervalCount === 1 ? `Billed every ${interval}` : `Billed every ${intervalCount} ${interval}s`}
                    </p>
                  </div>
                  <form action={openBilling.bind(null, id, "checkout")}>
                    <input type="hidden" name="price" value={priceId} />
                    <button className={button} type="submit" aria-label={`Open Stripe Checkout for ${name}`}>
                      {billing.pendingCheckout && billing.prices.length === 1 ? "Continue to Stripe" : "Open Stripe Checkout"}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-[var(--workspace-muted)]">No active Stripe test prices were found.</p>}
        </section>
      )}
    </main>
  );
}
