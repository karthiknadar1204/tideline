import type { DigestCadence, DigestSchedule } from "@tideline/contracts";
import { and, asc, eq, inArray, isNull, lte, max, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { agentSessions, weeklyDigestDeliveries, weeklyDigestSubscriptions, workspaceMembers, workspaces } from "./schema";
import { lockWorkspace } from "./workspaces";

type Access = { workspaceId: string; userId: string };
type Recipient = { workspaceId: string; recipientId: string };
type Delivery = Recipient & { cadence: DigestCadence; periodStart: string };
const minute = 60_000;
const scheduleFields = {
  weekday: weeklyDigestSubscriptions.weekday,
  hourUtc: weeklyDigestSubscriptions.hourUtc,
  recipientIds: weeklyDigestSubscriptions.recipientIds,
};

function whenScheduled(cadence: DigestCadence, now: Date) {
  if (cadence === "daily") return lte(weeklyDigestSubscriptions.hourUtc, now.getUTCHours());
  const hourOfWeek = ((now.getUTCDay() + 6) % 7) * 24 + now.getUTCHours();
  return sql`${weeklyDigestSubscriptions.weekday} * 24 + ${weeklyDigestSubscriptions.hourUtc} <= ${hourOfWeek}`;
}

function activeRecipient(recipientId: string | ReturnType<typeof sql>) {
  return sql`(${workspaces.ownerId} = ${recipientId} or (${workspaces.kind} = 'team' and exists (
    select 1 from ${workspaceMembers}
    where ${workspaceMembers.workspaceId} = ${workspaces.id} and ${workspaceMembers.userId} = ${recipientId}
      and ${workspaceMembers.removedAt} is null
  )))`;
}

function deliveryKey({ workspaceId, cadence, periodStart, recipientId }: Delivery) {
  return and(eq(weeklyDigestDeliveries.workspaceId, workspaceId), eq(weeklyDigestDeliveries.periodStart, periodStart),
    eq(weeklyDigestDeliveries.cadence, cadence),
    eq(weeklyDigestDeliveries.recipientId, recipientId));
}

export function createDigestDeliveryStore(databaseUrl: string) {
  const connection = postgres(databaseUrl);
  const db = drizzle(connection);

  return {
    async read({ workspaceId, userId }: Access, cadence: DigestCadence) {
      return db.transaction(async (transaction) => {
        const [owner] = await transaction.select({ id: workspaces.id }).from(workspaces)
          .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, userId)));
        if (!owner) return;
        const [schedule] = await transaction.select(scheduleFields).from(weeklyDigestSubscriptions)
          .where(and(eq(weeklyDigestSubscriptions.workspaceId, workspaceId), eq(weeklyDigestSubscriptions.cadence, cadence)));
        const [last] = await transaction.select({ at: max(weeklyDigestDeliveries.sentAt) }).from(weeklyDigestDeliveries)
          .where(and(eq(weeklyDigestDeliveries.workspaceId, workspaceId), eq(weeklyDigestDeliveries.cadence, cadence)));
        return { schedule: schedule ?? null, lastDeliveredAt: last?.at?.toISOString() ?? null };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async update(access: Access, cadence: DigestCadence, schedule: DigestSchedule | null) {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (workspace?.role !== "owner") return "inaccessible";
        if (!schedule) {
          await transaction.delete(weeklyDigestSubscriptions).where(and(
            eq(weeklyDigestSubscriptions.workspaceId, workspace.id), eq(weeklyDigestSubscriptions.cadence, cadence),
          ));
          return "updated";
        }
        const others = schedule.recipientIds.filter((id) => id !== workspace.ownerId);
        if (others.length) {
          if (workspace.kind !== "team") return "invalid-recipients";
          const members = await transaction.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(
            eq(workspaceMembers.workspaceId, workspace.id), isNull(workspaceMembers.removedAt), inArray(workspaceMembers.userId, others),
          ));
          if (members.length !== others.length) return "invalid-recipients";
        }
        await transaction.insert(weeklyDigestSubscriptions).values({ workspaceId: workspace.id, cadence, ...schedule })
          .onConflictDoUpdate({ target: [weeklyDigestSubscriptions.workspaceId, weeklyDigestSubscriptions.cadence], set: schedule });
        return "updated";
      });
    },

    async due(cadence: DigestCadence, periodStart: string, now: Date) {
      const recipientId = sql<string>`recipient.id`;
      return db.select({ workspaceId: workspaces.id, recipientId }).from(weeklyDigestSubscriptions)
        .innerJoin(workspaces, eq(workspaces.id, weeklyDigestSubscriptions.workspaceId))
        .crossJoinLateral(sql`unnest(${weeklyDigestSubscriptions.recipientIds}) as recipient(id)`)
        .leftJoin(weeklyDigestDeliveries, and(eq(weeklyDigestDeliveries.workspaceId, workspaces.id),
          eq(weeklyDigestDeliveries.periodStart, periodStart), eq(weeklyDigestDeliveries.recipientId, recipientId),
          eq(weeklyDigestDeliveries.cadence, cadence)))
        .where(and(eq(weeklyDigestSubscriptions.cadence, cadence), whenScheduled(cadence, now),
          cadence === "daily" ? sql`exists (
            select 1 from ${agentSessions}
            where ${agentSessions.workspaceId} = ${workspaces.id} and ${agentSessions.readyMessageCount} > 0
              and left(${agentSessions.startedAt}, 10) = ${periodStart}
          )` : undefined,
          activeRecipient(recipientId), isNull(weeklyDigestDeliveries.sentAt),
          or(isNull(weeklyDigestDeliveries.nextAttemptAt), lte(weeklyDigestDeliveries.nextAttemptAt, now))))
        .orderBy(asc(weeklyDigestDeliveries.nextAttemptAt), asc(workspaces.id), asc(recipientId)).limit(25);
    },

    async claim(delivery: Delivery, now: Date) {
      return db.transaction(async (transaction) => {
        const [eligible] = await transaction.select({ name: workspaces.name }).from(weeklyDigestSubscriptions)
          .innerJoin(workspaces, eq(workspaces.id, weeklyDigestSubscriptions.workspaceId))
          .where(and(eq(workspaces.id, delivery.workspaceId), eq(weeklyDigestSubscriptions.cadence, delivery.cadence),
            whenScheduled(delivery.cadence, now), activeRecipient(delivery.recipientId),
            sql`${delivery.recipientId} = any(${weeklyDigestSubscriptions.recipientIds})`));
        if (!eligible) return;
        const nextAttemptAt = new Date(now.getTime() + 2 * minute);
        const [claim] = await transaction.insert(weeklyDigestDeliveries).values({ ...delivery, nextAttemptAt })
          .onConflictDoUpdate({
            target: [weeklyDigestDeliveries.workspaceId, weeklyDigestDeliveries.cadence, weeklyDigestDeliveries.periodStart, weeklyDigestDeliveries.recipientId],
            set: { nextAttemptAt, attempts: sql`${weeklyDigestDeliveries.attempts} + 1` },
            setWhere: and(isNull(weeklyDigestDeliveries.sentAt), lte(weeklyDigestDeliveries.nextAttemptAt, now)),
          }).returning({ attempts: weeklyDigestDeliveries.attempts });
        return claim && { ...delivery, ...eligible, ...claim };
      });
    },

    async complete(delivery: Delivery & { attempts: number }, result: { sentAt: Date } | { nextAttemptAt: Date }) {
      await db.update(weeklyDigestDeliveries).set(result).where(and(deliveryKey(delivery), eq(weeklyDigestDeliveries.attempts, delivery.attempts)));
    },

    async close() {
      await connection.end();
    },
  };
}
