import type { CreateSessionShareRequest, SharedSessionSnapshot } from "@tideline/contracts";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { agentSessions, sessionShares, workspaces } from "./schema";
import { workspaceManagedBy } from "./workspaces";

type Transaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];
type ShareAccess = { workspaceId: string; sessionId: string; userId: string };

function scopedSession({ workspaceId, sessionId }: ShareAccess) {
  return and(eq(agentSessions.workspaceId, workspaceId), eq(agentSessions.id, sessionId));
}

async function lockShareWorkspace(transaction: Transaction, { workspaceId, userId }: ShareAccess) {
  const access = and(eq(workspaces.id, workspaceId), workspaceManagedBy(userId));
  const [locked] = await transaction.select({ id: workspaces.id }).from(workspaces).where(access).for("no key update");
  if (!locked) return false;
  const [authorized] = await transaction.select({ id: workspaces.id }).from(workspaces)
    .where(access);
  return Boolean(authorized);
}

export function createSessionShareStore(databaseUrl: string) {
  const connection = postgres(databaseUrl);
  const db = drizzle(connection);

  return {
    async readStatus(access: ShareAccess) {
      const [status] = await db.select({ token: sessionShares.token }).from(agentSessions)
        .innerJoin(workspaces, eq(workspaces.id, agentSessions.workspaceId))
        .leftJoin(sessionShares, eq(sessionShares.sessionId, agentSessions.id))
        .where(and(scopedSession(access), workspaceManagedBy(access.userId)));
      return status;
    },

    async create(access: ShareAccess, displayed: CreateSessionShareRequest, token: string) {
      return db.transaction(async (transaction) => {
        if (!await lockShareWorkspace(transaction, access)) return { kind: "missing" } as const;
        const [session] = await transaction.select({
          title: agentSessions.title,
          source: agentSessions.source,
          startedAt: agentSessions.startedAt,
          messages: agentSessions.messages,
          readyMessageCount: agentSessions.readyMessageCount,
          existingToken: sessionShares.token,
        }).from(agentSessions).leftJoin(sessionShares, eq(sessionShares.sessionId, agentSessions.id))
          .where(scopedSession(access));
        if (!session) return { kind: "missing" } as const;
        if (session.existingToken) return { kind: "shared", token: session.existingToken } as const;

        const { readyMessageCount, title, source, startedAt } = session;
        const messages = session.messages.slice(0, readyMessageCount);
        if (title === null || messages.length !== displayed.messageCount || messages.at(-1)?.line !== displayed.lastMessageLine) {
          return { kind: "changed" } as const;
        }

        const snapshot = { title, source, startedAt, messages: messages.map(({ role, text }) => ({ role, text })) } satisfies SharedSessionSnapshot;
        await transaction.insert(sessionShares).values({ sessionId: access.sessionId, token, snapshot });
        return { kind: "shared", token } as const;
      });
    },

    async revoke(access: ShareAccess) {
      return db.transaction(async (transaction) => {
        if (!await lockShareWorkspace(transaction, access)) return false;
        const [session] = await transaction.select({ id: agentSessions.id }).from(agentSessions).where(scopedSession(access));
        if (!session) return false;
        await transaction.delete(sessionShares).where(eq(sessionShares.sessionId, session.id));
        return true;
      });
    },

    async readPublic(token: string) {
      const [share] = await db.select({ snapshot: sessionShares.snapshot }).from(sessionShares).where(eq(sessionShares.token, token));
      return share?.snapshot;
    },

    async close() {
      await connection.end();
    },
  };
}
