import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { workspaces } from "./schema";

export function createWorkspaceStore(databaseUrl: string) {
  const db = drizzle(postgres(databaseUrl));
  const workspaceFields = { id: workspaces.id, name: workspaces.name };

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

    async findOwned({ workspaceId, ownerId }: { workspaceId: string; ownerId: string }) {
      const [workspace] = await db
        .select(workspaceFields)
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, ownerId)));
      return workspace;
    },
  };
}
