import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { accountRetirements, agentSessions, clerkDirectoryUserStates, cliSetups, savedReports, syncGrants, weeklyDigestDeliveries, weeklyDigestSubscriptions,
  workspaceInvites, workspaceMembers, workspaces } from "./schema";

type Transaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

export function accountKey(userId: string) {
  return createHash("sha256").update(userId).digest("hex");
}

export function lockAccount(transaction: Transaction, userId: string) {
  return transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 1403125277))`);
}

export function lockAccounts(transaction: Transaction, userIds: string[]) {
  return transaction.execute(sql`select pg_advisory_xact_lock(lock_key) from (
    select distinct hashtextextended(user_id, 1403125277) as lock_key
    from jsonb_array_elements_text(${JSON.stringify(userIds)}::jsonb) as accounts(user_id)
    order by lock_key
  ) as locks`);
}

export function accountActive(userId: string) {
  const key = accountKey(userId);
  return sql`not exists (select 1 from ${accountRetirements} where ${accountRetirements.userKey} = ${key})
    and not exists (select 1 from ${clerkDirectoryUserStates} where ${clerkDirectoryUserStates.userKey} = ${key} and ${clerkDirectoryUserStates.blocked})`;
}

export async function directoryIsBlocked(database: Pick<PostgresJsDatabase, "select">, userId: string) {
  const [state] = await database.select({ blocked: clerkDirectoryUserStates.blocked }).from(clerkDirectoryUserStates)
    .where(eq(clerkDirectoryUserStates.userKey, accountKey(userId)));
  return state?.blocked === true;
}

export async function accountIsRetiring(database: Pick<PostgresJsDatabase, "select">, userId: string) {
  const [record] = await database.select({ key: accountRetirements.userKey }).from(accountRetirements)
    .where(eq(accountRetirements.userKey, accountKey(userId)));
  return Boolean(record);
}

export async function requireActiveAccount(transaction: Transaction, userId: string) {
  await lockAccount(transaction, userId);
  if (await accountIsRetiring(transaction, userId)) throw new Error("This account is being deleted.");
  if (await directoryIsBlocked(transaction, userId)) throw new Error("Directory access is inactive.");
}

export function ownedTeams(database: Pick<PostgresJsDatabase, "select">, userId: string) {
  return database.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
    .where(and(eq(workspaces.ownerId, userId), eq(workspaces.kind, "team"))).orderBy(asc(workspaces.name), asc(workspaces.id));
}

export async function deleteWorkspaceData(transaction: Transaction, workspaceId: string) {
  await transaction.delete(syncGrants).where(eq(syncGrants.workspaceId, workspaceId));
  await transaction.delete(agentSessions).where(eq(agentSessions.workspaceId, workspaceId));
  await transaction.delete(workspaces).where(eq(workspaces.id, workspaceId));
}

export async function retireAccount(transaction: Transaction, userId: string) {
  await lockAccount(transaction, userId);
  if (await accountIsRetiring(transaction, userId)) return "retiring";
  if ((await ownedTeams(transaction, userId)).length) return "owns-teams";

  // Lock the user's workspaces before removing credentials or attribution. A key-share lock for an in-flight upload can finish.
  const homes = await transaction.select({ id: workspaces.id, kind: workspaces.kind }).from(workspaces)
    .where(sql`${workspaces.ownerId} = ${userId} or exists (
      select 1 from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${workspaces.id} and ${workspaceMembers.userId} = ${userId}
    )`).orderBy(asc(workspaces.id)).for("no key update");
  await transaction.insert(accountRetirements).values({ userKey: accountKey(userId) });
  const personal = homes.find(({ kind }) => kind === "personal");
  if (personal) await deleteWorkspaceData(transaction, personal.id);

  await transaction.delete(syncGrants).where(eq(syncGrants.userId, userId));
  await transaction.delete(cliSetups).where(eq(cliSetups.userId, userId));
  await transaction.delete(workspaceInvites).where(eq(workspaceInvites.acceptedBy, userId));
  await transaction.delete(workspaceMembers).where(eq(workspaceMembers.userId, userId));
  await transaction.update(agentSessions).set({ uploadedBy: null }).where(eq(agentSessions.uploadedBy, userId));
  await transaction.delete(savedReports).where(and(eq(savedReports.authorId, userId), eq(savedReports.visibility, "private")));
  await transaction.update(savedReports).set({ authorId: sql`'retired-' || ${savedReports.id}::text` })
    .where(and(eq(savedReports.authorId, userId), eq(savedReports.visibility, "workspace")));
  await transaction.delete(weeklyDigestDeliveries).where(eq(weeklyDigestDeliveries.recipientId, userId));
  const receivesDigest = sql`${userId} = any(${weeklyDigestSubscriptions.recipientIds})`;
  await transaction.delete(weeklyDigestSubscriptions).where(and(receivesDigest, sql`cardinality(${weeklyDigestSubscriptions.recipientIds}) = 1`));
  await transaction.update(weeklyDigestSubscriptions)
    .set({ recipientIds: sql`array_remove(${weeklyDigestSubscriptions.recipientIds}, ${userId})` }).where(receivesDigest);

  return "retiring";
}
