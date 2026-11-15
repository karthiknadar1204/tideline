import type { TeamMemberRole } from "@tideline/contracts";
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { accountIsRetiring, accountKey, lockAccount, lockAccounts } from "./account-retirement";
import { accountRetirements, clerkDirectoryUserStates, cliGrants, syncGrants, workspaceClerkOrganizations, workspaceMembers, workspaces } from "./schema";
import { lockWorkspace, workspaceAccessibleTo } from "./workspaces";

type DirectoryMembership = { userId: string; email: string | null; role: TeamMemberRole; active: boolean };
type Transaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];
type WorkspaceUser = { workspaceId: string; userId: string };

async function writeMemberships(transaction: Transaction, workspaceId: string, entries: DirectoryMembership[], at: Date) {
  const batchSize = 500;
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    await transaction.insert(workspaceMembers).values(entries.slice(offset, offset + batchSize).map((entry) => ({
      workspaceId, userId: entry.userId, email: entry.email, role: entry.role, removedAt: entry.active ? null : at,
      directoryObservedAt: at,
    }))).onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: { email: sql`excluded.email`, role: sql`excluded.role`, removedAt: sql`excluded.removed_at`, directoryObservedAt: sql`excluded.directory_observed_at` },
      setWhere: and(isNotNull(workspaceMembers.directoryObservedAt), or(lt(workspaceMembers.directoryObservedAt, at), and(
        eq(workspaceMembers.directoryObservedAt, at), isNull(workspaceMembers.removedAt), sql`excluded.removed_at is not null`,
      ))),
    });
  }
}

async function disconnect(transaction: Transaction, workspaceId: string) {
  const retired = await transaction.update(workspaceMembers).set({ removedAt: sql`clock_timestamp()`, email: null,
    directoryObservedAt: sql`greatest(${workspaceMembers.directoryObservedAt}, clock_timestamp())` })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), isNotNull(workspaceMembers.directoryObservedAt)))
    .returning({ userId: workspaceMembers.userId });
  if (retired.length) await transaction.delete(syncGrants)
    .where(and(eq(syncGrants.workspaceId, workspaceId), inArray(syncGrants.userId, retired.map(({ userId }) => userId))));
  await transaction.delete(workspaceClerkOrganizations).where(eq(workspaceClerkOrganizations.workspaceId, workspaceId));
}

async function lockedOrganization(transaction: Transaction, organizationId: string) {
  const [workspace] = await transaction.select({ id: workspaces.id, ownerId: workspaces.ownerId }).from(workspaces)
    .innerJoin(workspaceClerkOrganizations, eq(workspaceClerkOrganizations.workspaceId, workspaces.id))
    .where(eq(workspaceClerkOrganizations.organizationId, organizationId)).for("no key update", { of: workspaces });
  if (!workspace) return;
  const [link] = await transaction.select().from(workspaceClerkOrganizations).where(eq(workspaceClerkOrganizations.workspaceId, workspace.id));
  return link?.organizationId === organizationId ? { ...workspace, linkedAt: link.linkedAt } : undefined;
}

export function createClerkDirectoryStore(databaseUrl: string) {
  const connection = postgres(databaseUrl);
  const db = drizzle(connection);
  return {
    async status({ workspaceId, userId }: WorkspaceUser) {
      const [result] = await db.select({ organizationId: workspaceClerkOrganizations.organizationId }).from(workspaces)
        .leftJoin(workspaceClerkOrganizations, eq(workspaceClerkOrganizations.workspaceId, workspaces.id))
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, "team"), workspaceAccessibleTo(userId)));
      return result;
    },

    async link(access: WorkspaceUser, organizationId: string): Promise<"linked" | "conflict" | "unavailable"> {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (workspace?.kind !== "team" || workspace.role !== "owner") return "unavailable";
        await transaction.insert(workspaceClerkOrganizations).values({ workspaceId: workspace.id, organizationId }).onConflictDoNothing();
        const [link] = await transaction.select().from(workspaceClerkOrganizations).where(eq(workspaceClerkOrganizations.workspaceId, workspace.id));
        return link?.organizationId === organizationId ? "linked" : "conflict";
      });
    },

    async unlink(access: WorkspaceUser) {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (workspace?.kind !== "team" || workspace.role !== "owner") return false;
        await disconnect(transaction, workspace.id);
        return true;
      });
    },

    async reconcile(organizationId: string, members: DirectoryMembership[], at: Date) {
      return db.transaction(async (transaction) => {
        const seen = new Set(members.map(({ userId }) => userId));
        await lockAccounts(transaction, [...seen]);
        const workspace = await lockedOrganization(transaction, organizationId);
        if (!workspace || at < workspace.linkedAt) return;
        const existing = await transaction.select({ userId: workspaceMembers.userId, role: workspaceMembers.role }).from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, workspace.id), isNotNull(workspaceMembers.directoryObservedAt)));
        const changes = [...members, ...existing.filter(({ userId }) => !seen.has(userId)).map((member) => ({ ...member, active: false, email: null }))];
        const candidateKeys = JSON.stringify(changes.map(({ userId }) => accountKey(userId)));
        const retired = await transaction.select({ key: accountRetirements.userKey }).from(accountRetirements)
          .where(sql`${accountRetirements.userKey} in (select jsonb_array_elements_text(${candidateKeys}::jsonb))`);
        const retiredKeys = new Set(retired.map(({ key }) => key));
        await writeMemberships(transaction, workspace.id, changes.filter(({ userId }) => userId !== workspace.ownerId && !retiredKeys.has(accountKey(userId))), at);
        const absent = changes.filter(({ active }) => !active).map(({ userId }) => userId);
        if (absent.length) await transaction.delete(syncGrants).where(and(eq(syncGrants.workspaceId, workspace.id), inArray(syncGrants.userId, absent), sql`exists (
          select 1 from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${syncGrants.workspaceId}
            and ${workspaceMembers.userId} = ${syncGrants.userId} and ${workspaceMembers.directoryObservedAt} is not null and ${workspaceMembers.removedAt} is not null
        )`));
      });
    },

    async changeMembership(organizationId: string, member: DirectoryMembership, at: Date) {
      return db.transaction(async (transaction) => {
        await lockAccount(transaction, member.userId);
        if (await accountIsRetiring(transaction, member.userId)) return;
        const workspace = await lockedOrganization(transaction, organizationId);
        if (!workspace || at < workspace.linkedAt || workspace.ownerId === member.userId) return;
        await writeMemberships(transaction, workspace.id, [member], at);
        if (member.active) return;
        const [managed] = await transaction.select({ removedAt: workspaceMembers.removedAt }).from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, member.userId), isNotNull(workspaceMembers.directoryObservedAt)));
        if (managed?.removedAt) await transaction.delete(syncGrants)
          .where(and(eq(syncGrants.workspaceId, workspace.id), eq(syncGrants.userId, member.userId)));
      });
    },

    async removeOrganization(organizationId: string) {
      return db.transaction(async (transaction) => {
        const workspace = await lockedOrganization(transaction, organizationId);
        if (workspace) await disconnect(transaction, workspace.id);
      });
    },

    async setUserBlocked(userId: string, blocked: boolean, at: Date) {
      return db.transaction(async (transaction) => {
        await lockAccount(transaction, userId);
        const [updated] = await transaction.insert(clerkDirectoryUserStates).values({ userKey: accountKey(userId), blocked, observedAt: at })
          .onConflictDoUpdate({ target: clerkDirectoryUserStates.userKey, set: { blocked, observedAt: at },
            setWhere: or(lt(clerkDirectoryUserStates.observedAt, at), blocked
              ? and(eq(clerkDirectoryUserStates.observedAt, at), eq(clerkDirectoryUserStates.blocked, false)) : undefined) }).returning();
        if (!updated?.blocked) return;
        const personal = transaction.select({ id: workspaces.id }).from(workspaces)
          .where(and(eq(workspaces.ownerId, userId), eq(workspaces.kind, "personal")));
        await transaction.delete(cliGrants).where(inArray(cliGrants.workspaceId, personal));
        await transaction.delete(syncGrants).where(or(eq(syncGrants.userId, userId), inArray(syncGrants.workspaceId, personal)));
      });
    },

    close: () => connection.end(),
  };
}
