import type { CliAccount, TeamMemberRole, WorkspaceAccess, WorkspaceRole, WorkspaceUsageTargetUpdate, WorkspaceUsageTargets } from "@tideline/contracts";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cliGrants, syncGrants, workspaceInvites, workspaceMembers, workspaces } from "./schema";

type WorkspaceUser = { workspaceId: string; userId: string };
type Transaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

const workspaceFields = { id: workspaces.id, name: workspaces.name };
const workspaceAccessFields = { ...workspaceFields, kind: workspaces.kind };
const usageTargetFields = { monthlyBudgetCents: workspaces.monthlyBudgetCents, goal: workspaces.usageGoal };
const inviteFields = {
  id: workspaceInvites.id,
  email: workspaceInvites.email,
  role: workspaceInvites.role,
  expiresAt: workspaceInvites.expiresAt,
};
const personalWorkspace = sql`${workspaces.kind} = 'personal'`;

function membershipScope({ workspaceId, userId }: WorkspaceUser) {
  return and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId));
}

function memberRole(userId: string) {
  return sql<TeamMemberRole | null>`(
    select ${workspaceMembers.role} from ${workspaceMembers}
    where ${workspaceMembers.workspaceId} = ${workspaces.id} and ${workspaceMembers.userId} = ${userId}
      and ${workspaceMembers.removedAt} is null and ${workspaces.kind} = 'team'
  )`;
}

function workspaceRole(userId: string) {
  return sql<WorkspaceRole>`case when ${workspaces.ownerId} = ${userId} then 'owner' else ${memberRole(userId)}::text end`;
}

export function workspaceAccessibleTo(userId: string) {
  return sql`(${workspaces.ownerId} = ${userId} or ${memberRole(userId)} is not null)`;
}

export function workspaceManagedBy(userId: string) {
  return sql`(${workspaces.ownerId} = ${userId} or ${memberRole(userId)} = 'admin')`;
}

export async function lockWorkspace(
  transaction: Transaction,
  { workspaceId, userId }: WorkspaceUser,
): Promise<(Omit<WorkspaceAccess, "role"> & { ownerId: string; role: WorkspaceRole | undefined }) | undefined> {
  const [workspace] = await transaction.select({ ...workspaceAccessFields, ownerId: workspaces.ownerId })
    .from(workspaces).where(eq(workspaces.id, workspaceId)).for("no key update");
  if (!workspace) return;
  if (workspace.ownerId === userId) return { ...workspace, role: "owner" };
  if (workspace.kind !== "team") return;
  const [member] = await transaction.select({ role: workspaceMembers.role })
    .from(workspaceMembers).where(and(membershipScope({ workspaceId, userId }), isNull(workspaceMembers.removedAt)));
  return { ...workspace, role: member?.role };
}

function isWorkspaceManager(role: WorkspaceRole | undefined): role is "owner" | "admin" {
  return role === "owner" || role === "admin";
}

function managesRole(actorRole: WorkspaceRole | undefined, targetRole: TeamMemberRole) {
  return actorRole === "owner" || (actorRole === "admin" && targetRole === "member");
}

function pendingInvite() {
  return and(isNull(workspaceInvites.revokedAt), isNull(workspaceInvites.acceptedBy));
}

function currentInvite() {
  return and(pendingInvite(), gt(workspaceInvites.expiresAt, sql`clock_timestamp()`));
}

function serializeInvite({ expiresAt, ...invite }: Pick<typeof workspaceInvites.$inferSelect, keyof typeof inviteFields>) {
  return { ...invite, expiresAt: expiresAt.toISOString() };
}

export function createWorkspaceStore(databaseUrl: string) {
  const db = drizzle(postgres(databaseUrl));

  return {
    async ensurePersonal(ownerId: string) {
      const [createdWorkspace] = await db.insert(workspaces)
        .values({ ownerId })
        .onConflictDoNothing({ target: workspaces.ownerId, where: personalWorkspace })
        .returning(workspaceFields);

      if (createdWorkspace) return createdWorkspace;

      const [existingWorkspace] = await db.select(workspaceFields).from(workspaces)
        .where(and(eq(workspaces.ownerId, ownerId), personalWorkspace));

      if (!existingWorkspace) throw new Error("Could not find the owner's workspace.");
      return existingWorkspace;
    },

    async createTeam(userId: string, name: string): Promise<WorkspaceAccess> {
      const [workspace] = await db.insert(workspaces)
        .values({ ownerId: userId, name, kind: "team" })
        .returning(workspaceAccessFields);
      return { ...workspace, role: "owner" };
    },

    async listAccessible(userId: string): Promise<WorkspaceAccess[]> {
      return db.select({ ...workspaceAccessFields, role: workspaceRole(userId) }).from(workspaces)
        .where(workspaceAccessibleTo(userId))
        .orderBy(asc(workspaces.kind), asc(workspaces.name), asc(workspaces.id));
    },

    async findAccessible({ workspaceId, userId }: WorkspaceUser): Promise<WorkspaceAccess | undefined> {
      const [workspace] = await db.select({ ...workspaceAccessFields, role: workspaceRole(userId) }).from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), workspaceAccessibleTo(userId)));
      return workspace;
    },

    async renameManaged(access: WorkspaceUser, name: string): Promise<WorkspaceAccess | undefined> {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (!workspace || !isWorkspaceManager(workspace.role)) return;
        const [updated] = await transaction.update(workspaces).set({ name })
          .where(eq(workspaces.id, access.workspaceId)).returning(workspaceAccessFields);
        return { ...updated, role: workspace.role };
      });
    },

    async readUsageTargets({ workspaceId, userId }: WorkspaceUser): Promise<WorkspaceUsageTargets | undefined> {
      const [targets] = await db.select(usageTargetFields).from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), workspaceAccessibleTo(userId)));
      return targets;
    },

    async updateUsageTarget(access: WorkspaceUser, update: WorkspaceUsageTargetUpdate): Promise<WorkspaceUsageTargets | undefined> {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (!workspace || !isWorkspaceManager(workspace.role)) return;
        const [targets] = await transaction.update(workspaces)
          .set(update.kind === "budget" ? { monthlyBudgetCents: update.value } : { usageGoal: update.value })
          .where(eq(workspaces.id, access.workspaceId)).returning(usageTargetFields);
        return targets;
      });
    },

    async listTeam({ workspaceId, userId }: WorkspaceUser) {
      return db.transaction(async (transaction) => {
        const [workspace] = await transaction.select({ ownerId: workspaces.ownerId, role: workspaceRole(userId) })
          .from(workspaces)
          .where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, "team"), workspaceAccessibleTo(userId)));
        if (!workspace) return;
        const managesMembers = isWorkspaceManager(workspace.role);
        const members = await transaction.select({ userId: workspaceMembers.userId, email: workspaceMembers.email, role: workspaceMembers.role })
          .from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), isNull(workspaceMembers.removedAt)))
          .orderBy(asc(workspaceMembers.role), asc(workspaceMembers.email));
        const invites = managesMembers ? await transaction.select(inviteFields).from(workspaceInvites)
          .where(and(eq(workspaceInvites.workspaceId, workspaceId), currentInvite()))
          .orderBy(asc(workspaceInvites.email)) : [];

        return {
          members: [
            { userId: workspace.ownerId, email: null, role: "owner" as const },
            ...members.map((member) => ({ ...member, email: managesMembers || member.userId === userId ? member.email : null })),
          ],
          invites: invites.map(serializeInvite),
        };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async createInvite(access: WorkspaceUser, invitation: { email: string; role: TeamMemberRole; tokenHash: string; expiresAt: Date }) {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (workspace?.kind !== "team" || !managesRole(workspace.role, invitation.role)) return;
        const [member] = await transaction.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, access.workspaceId), eq(workspaceMembers.email, invitation.email), isNull(workspaceMembers.removedAt)));
        if (member) return;

        await transaction.update(workspaceInvites).set({ revokedAt: sql`clock_timestamp()` })
          .where(and(
            eq(workspaceInvites.workspaceId, access.workspaceId),
            eq(workspaceInvites.email, invitation.email),
            pendingInvite(),
            workspace.role === "owner" ? undefined : or(
              eq(workspaceInvites.role, "member"),
              sql`${workspaceInvites.expiresAt} <= clock_timestamp()`,
            ),
          ));

        const [created] = await transaction.insert(workspaceInvites)
          .values({ ...invitation, workspaceId: access.workspaceId })
          .onConflictDoNothing().returning(inviteFields);
        return created && serializeInvite(created);
      });
    },

    async acceptInvite({ userId, tokenHash, verifiedEmails }: { userId: string; tokenHash: string; verifiedEmails: string[] }): Promise<WorkspaceAccess | undefined> {
      return db.transaction(async (transaction) => {
        const [match] = await transaction.select({ workspaceId: workspaceInvites.workspaceId }).from(workspaceInvites)
          .where(eq(workspaceInvites.tokenHash, tokenHash));
        if (!match) return;
        const workspace = await lockWorkspace(transaction, { workspaceId: match.workspaceId, userId });
        if (workspace?.kind !== "team") return;

        const [invite] = await transaction.select().from(workspaceInvites).where(and(
          eq(workspaceInvites.tokenHash, tokenHash),
          isNull(workspaceInvites.revokedAt),
          gt(workspaceInvites.expiresAt, sql`clock_timestamp()`),
        ));
        if (!invite || !verifiedEmails.includes(invite.email)) return;

        const { id, name, kind } = workspace;
        if (invite.acceptedBy !== null) {
          return invite.acceptedBy === userId && workspace.role ? { id, name, kind, role: workspace.role } : undefined;
        }

        if (!workspace.role) {
          const [joined] = await transaction.insert(workspaceMembers)
            .values({ workspaceId: id, userId, email: invite.email, role: invite.role })
            .onConflictDoUpdate({
              target: [workspaceMembers.workspaceId, workspaceMembers.userId],
              set: { email: invite.email, role: invite.role, removedAt: null },
              setWhere: sql`${workspaceMembers.removedAt} < (
                select ${workspaceInvites.createdAt} from ${workspaceInvites} where ${workspaceInvites.id} = ${invite.id}
              )`,
            }).returning({ userId: workspaceMembers.userId });
          if (!joined) return;
        }
        await transaction.update(workspaceInvites).set({ acceptedBy: userId }).where(eq(workspaceInvites.id, invite.id));
        return { id, name, kind, role: workspace.role ?? invite.role };
      });
    },

    async setMemberRole(access: WorkspaceUser, member: { userId: string; role: TeamMemberRole }) {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (workspace?.kind !== "team" || workspace.role !== "owner" || member.userId === workspace.ownerId) return false;
        const [updated] = await transaction.update(workspaceMembers).set({ role: member.role })
          .where(and(membershipScope({ workspaceId: access.workspaceId, userId: member.userId }), isNull(workspaceMembers.removedAt)))
          .returning({ userId: workspaceMembers.userId });
        return Boolean(updated);
      });
    },

    async removeMember(access: WorkspaceUser, memberUserId: string) {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (workspace?.kind !== "team" || !isWorkspaceManager(workspace.role) || memberUserId === workspace.ownerId) return false;
        const [removed] = await transaction.update(workspaceMembers).set({ removedAt: sql`clock_timestamp()` })
          .where(and(
            membershipScope({ workspaceId: access.workspaceId, userId: memberUserId }),
            isNull(workspaceMembers.removedAt),
            workspace.role === "owner" ? undefined : eq(workspaceMembers.role, "member"),
          ))
          .returning({ email: workspaceMembers.email });
        if (!removed) return false;
        await transaction.update(workspaceInvites).set({ revokedAt: sql`clock_timestamp()` })
          .where(and(
            eq(workspaceInvites.workspaceId, access.workspaceId), eq(workspaceInvites.email, removed.email), pendingInvite(),
            workspace.role === "owner" ? undefined : eq(workspaceInvites.role, "member"),
          ));
        await transaction.update(syncGrants).set({ revokedAt: sql`clock_timestamp()` })
          .where(and(eq(syncGrants.workspaceId, access.workspaceId), eq(syncGrants.userId, memberUserId), isNull(syncGrants.revokedAt)));
        return true;
      });
    },

    async revokeInvite(access: WorkspaceUser, inviteId: string) {
      return db.transaction(async (transaction) => {
        const workspace = await lockWorkspace(transaction, access);
        if (workspace?.kind !== "team" || !isWorkspaceManager(workspace.role)) return false;
        const [revoked] = await transaction.update(workspaceInvites).set({ revokedAt: sql`clock_timestamp()` })
          .where(and(
            eq(workspaceInvites.workspaceId, access.workspaceId), eq(workspaceInvites.id, inviteId),
            currentInvite(), workspace.role === "owner" ? undefined : eq(workspaceInvites.role, "member"),
          ))
          .returning({ id: workspaceInvites.id });
        return Boolean(revoked);
      });
    },

    async enrollCli(tokenHash: string, workspaceId: string, expiresAt: Date) {
      await db.insert(cliGrants).values({ tokenHash, workspaceId, expiresAt });
    },

    async findCliAccount(tokenHash: string): Promise<CliAccount | undefined> {
      const [account] = await db.select({ userId: workspaces.ownerId, workspace: workspaceFields })
        .from(cliGrants)
        .innerJoin(workspaces, eq(cliGrants.workspaceId, workspaces.id))
        .where(and(eq(cliGrants.tokenHash, tokenHash), isNull(cliGrants.revokedAt), gt(cliGrants.expiresAt, sql`clock_timestamp()`)));
      return account;
    },

    async revokeCli(tokenHash: string) {
      const [grant] = await db.update(cliGrants)
        .set({ revokedAt: sql`coalesce(${cliGrants.revokedAt}, now())` })
        .where(eq(cliGrants.tokenHash, tokenHash))
        .returning({ tokenHash: cliGrants.tokenHash });
      return Boolean(grant);
    },
  };
}
