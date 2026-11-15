import type { BillingSubscriptionStatus } from "@tideline/contracts";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { stripeWebhookReceipts, workspaceBilling, workspaces } from "./schema";
import { lockWorkspace, workspaceAccessibleTo } from "./workspaces";

type Access = { workspaceId: string; userId: string };
type StoredBilling = typeof workspaceBilling.$inferSelect;
type Subscription = { id: string; status: BillingSubscriptionStatus; priceId: string; cancelAtPeriodEnd: boolean };
type CheckoutResult =
  | { kind: "checkout"; url: string; checkoutSessionId: string; checkoutPriceId: string }
  | { kind: "manage" };

export function hasOpenSubscription(status: BillingSubscriptionStatus | null) {
  return status !== null && status !== "canceled" && status !== "incomplete_expired";
}

export function createBillingStore(databaseUrl: string) {
  const db = drizzle(postgres(databaseUrl));

  return {
    async read({ workspaceId, userId }: Access) {
      const [result] = await db.select({ state: workspaceBilling }).from(workspaces)
        .leftJoin(workspaceBilling, eq(workspaceBilling.workspaceId, workspaces.id))
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, userId), workspaceAccessibleTo(userId)));
      return result;
    },

    async beginCheckout(
      access: Access,
      createCustomer: (workspace: { id: string; name: string }) => Promise<string>,
      createCheckout: (state: StoredBilling) => Promise<CheckoutResult>,
    ) {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (workspace?.role !== "owner") return { kind: "inaccessible" } as const;
        const [existing] = await transaction.select().from(workspaceBilling)
          .where(eq(workspaceBilling.workspaceId, workspace.id)).for("update");
        const [allocated] = existing ? [] : await transaction.insert(workspaceBilling).values({
          workspaceId: workspace.id, stripeCustomerId: await createCustomer(workspace),
        }).returning();
        const state = existing ?? allocated;
        if (!state) throw new Error("Could not reserve workspace billing.");
        const result = await createCheckout(state);
        if (result.kind === "checkout") {
          await transaction.update(workspaceBilling).set({
            checkoutSessionId: result.checkoutSessionId, checkoutPriceId: result.checkoutPriceId,
          }).where(eq(workspaceBilling.workspaceId, workspace.id));
        }
        return result;
      });
    },

    async syncSubscription(eventId: string, customerId: string, readSubscription: (workspaceId: string) => Promise<Subscription | null>) {
      return db.transaction(async (transaction) => {
        const [binding] = await transaction.select({ workspaceId: workspaceBilling.workspaceId }).from(workspaceBilling)
          .where(eq(workspaceBilling.stripeCustomerId, customerId));
        if (!binding) return;
        const [workspace] = await transaction.select({ id: workspaces.id }).from(workspaces)
          .where(eq(workspaces.id, binding.workspaceId)).for("no key update");
        if (!workspace) return;
        const [state] = await transaction.select({ customerId: workspaceBilling.stripeCustomerId }).from(workspaceBilling)
          .where(eq(workspaceBilling.workspaceId, workspace.id)).for("update");
        if (state?.customerId !== customerId) return;
        const [receipt] = await transaction.insert(stripeWebhookReceipts).values({ eventId, workspaceId: workspace.id })
          .onConflictDoNothing().returning({ eventId: stripeWebhookReceipts.eventId });
        if (!receipt) return;

        const subscription = await readSubscription(workspace.id);
        await transaction.update(workspaceBilling).set({
          stripeSubscriptionId: subscription?.id ?? null,
          subscriptionStatus: subscription?.status ?? null,
          subscriptionPriceId: subscription?.priceId ?? null,
          cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        }).where(eq(workspaceBilling.workspaceId, workspace.id));
      });
    },
  };
}
