import type { CliAccount, WorkspaceUsageTargetUpdate, WorkspaceUsageTargets } from "@tideline/contracts";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cliGrants, workspaces } from "./schema";

type WorkspaceOwner = { workspaceId: string; ownerId: string };

function ownedWorkspace({ workspaceId, ownerId }: WorkspaceOwner) {
  return and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, ownerId));
}

export function createWorkspaceStore(databaseUrl: string) {
  const db = drizzle(postgres(databaseUrl));
  const workspaceFields = { id: workspaces.id, name: workspaces.name };
  const usageTargetFields = { monthlyBudgetCents: workspaces.monthlyBudgetCents, goal: workspaces.usageGoal };

  return {
    async ensurePersonal(ownerId: string) {
      const [createdWorkspace] = await db
        .insert(workspaces)
        .values({ ownerId })
        .onConflictDoNothing({ target: workspaces.ownerId })
        .returning(workspaceFields);

      if (createdWorkspace) {
        return createdWorkspace;
      }

      const [existingWorkspace] = await db
        .select(workspaceFields)
        .from(workspaces)
        .where(eq(workspaces.ownerId, ownerId));

      if (!existingWorkspace) {
        throw new Error("Could not find the owner's workspace.");
      }
      return existingWorkspace;
    },

    async findOwned(owner: WorkspaceOwner) {
      const [workspace] = await db
        .select(workspaceFields)
        .from(workspaces)
        .where(ownedWorkspace(owner));
      return workspace;
    },

    async readUsageTargets(owner: WorkspaceOwner): Promise<WorkspaceUsageTargets | undefined> {
      const [targets] = await db.select(usageTargetFields).from(workspaces).where(ownedWorkspace(owner));
      return targets;
    },

    async updateUsageTarget(owner: WorkspaceOwner, update: WorkspaceUsageTargetUpdate): Promise<WorkspaceUsageTargets | undefined> {
      const [targets] = await db.update(workspaces)
        .set(update.kind === "budget" ? { monthlyBudgetCents: update.value } : { usageGoal: update.value })
        .where(ownedWorkspace(owner))
        .returning(usageTargetFields);
      return targets;
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
