import { isDeepStrictEqual } from "node:util";
import type { SessionImportRequest } from "@tideline/contracts";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { agentSessions, syncGrants } from "./schema";

type Transaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

async function receiveSession(
  transaction: Transaction,
  { workspaceId, session }: SessionImportRequest,
  allowAppend: boolean,
) {
  const { source, sourceSessionId, startedAt, events: messages, analytics } = session;
  const [created] = await transaction
    .insert(agentSessions)
    .values({ workspaceId, source, sourceSessionId, startedAt, messages, pendingAnalytics: analytics })
    .onConflictDoNothing({ target: [agentSessions.workspaceId, agentSessions.source, agentSessions.sourceSessionId] })
    .returning({ id: agentSessions.id });

  if (created) {
    return { id: created.id, alreadyReceived: false };
  }

  const [existing] = await transaction.select({
    id: agentSessions.id,
    startedAt: agentSessions.startedAt,
    messages: agentSessions.messages,
    analytics: agentSessions.pendingAnalytics,
  }).from(agentSessions).where(and(
    eq(agentSessions.workspaceId, workspaceId),
    eq(agentSessions.source, source),
    eq(agentSessions.sourceSessionId, sourceSessionId),
  )).for("update");

  if (!existing) {
    throw new Error("Import record disappeared before it could be checked.");
  }

  const lengthDifference = messages.length - existing.messages.length;
  const sharedMessageCount = Math.min(messages.length, existing.messages.length);
  if (existing.startedAt !== startedAt ||
      (!allowAppend && lengthDifference !== 0) ||
      !isDeepStrictEqual(existing.messages.slice(0, sharedMessageCount), messages.slice(0, sharedMessageCount))) {
    return null;
  }

  const replay = { id: existing.id, alreadyReceived: true };
  if (lengthDifference < 0) return replay;

  const previousLine = existing.analytics?.throughLine ?? 0;
  const nextLine = analytics?.throughLine ?? 0;
  const repositoryEnrichment = analytics?.repository && !existing.analytics?.repository;
  if (analytics && nextLine <= previousLine) {
    if (lengthDifference > 0 || (nextLine === previousLine && (
      existing.analytics?.tokenCoverage !== analytics.tokenCoverage ||
      !isDeepStrictEqual(existing.analytics?.models, analytics.models)
    ))) {
      return null;
    }
    if (nextLine < previousLine || !repositoryEnrichment) return replay;
  }
  if (lengthDifference === 0 && !analytics) return replay;

  await transaction.update(agentSessions)
    .set({
      messages: lengthDifference > 0 ? messages : undefined,
      pendingAnalytics: analytics && {
        ...analytics, repository: existing.analytics?.repository ?? analytics.repository,
      },
    })
    .where(eq(agentSessions.id, existing.id));

  return { id: existing.id, alreadyReceived: false };
}

export function createSessionStore(databaseUrl: string) {
  const connection = postgres(databaseUrl);
  const db = drizzle(connection);
  const summaryFields = {
    id: agentSessions.id,
    source: agentSessions.source,
    startedAt: agentSessions.startedAt,
    title: sql<string>`${agentSessions.title}`,
    messageCount: agentSessions.readyMessageCount,
    analytics: agentSessions.readyAnalytics,
  };

  return {
    async receive(request: SessionImportRequest) {
      return db.transaction((transaction) => receiveSession(transaction, request, false));
    },

    async enrollSync({ tokenHash, workspaceId, expiresAt }: {
      tokenHash: string;
      workspaceId: string;
      expiresAt: Date;
    }) {
      await db.insert(syncGrants).values({ tokenHash, workspaceId, expiresAt });
    },

    async revokeSync(tokenHash: string) {
      const [grant] = await db.update(syncGrants)
        .set({ revokedAt: sql`coalesce(${syncGrants.revokedAt}, now())` })
        .where(eq(syncGrants.tokenHash, tokenHash))
        .returning({ workspaceId: syncGrants.workspaceId });

      return Boolean(grant);
    },

    async receiveSync(tokenHash: string, request: SessionImportRequest) {
      return db.transaction(async (transaction) => {
        const [grant] = await transaction.select({ workspaceId: syncGrants.workspaceId })
          .from(syncGrants)
          .where(and(
            eq(syncGrants.tokenHash, tokenHash),
            isNull(syncGrants.revokedAt),
            gt(syncGrants.expiresAt, sql`clock_timestamp()`),
          ))
          .for("update");

        if (!grant) return { kind: "unauthorized" } as const;
        if (grant.workspaceId !== request.workspaceId.toLowerCase()) return { kind: "foreign-workspace" } as const;

        const receipt = await receiveSession(transaction, request, true);
        return receipt ? { kind: "accepted", receipt } as const : { kind: "conflict" } as const;
      });
    },

    async listReady(workspaceId: string) {
      return db.select(summaryFields).from(agentSessions)
        .where(and(eq(agentSessions.workspaceId, workspaceId), gt(agentSessions.readyMessageCount, 0)))
        .orderBy(desc(agentSessions.receivedAt), desc(agentSessions.id));
    },

    async findReady(workspaceId: string, sessionId: string) {
      const [session] = await db.select({
        ...summaryFields,
        sourceSessionId: agentSessions.sourceSessionId,
        messages: agentSessions.messages,
      }).from(agentSessions).where(and(
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.id, sessionId),
        gt(agentSessions.readyMessageCount, 0),
      ));

      return session && { ...session, messages: session.messages.slice(0, session.messageCount) };
    },

    async processNext() {
      return db.transaction(async (transaction) => {
        const [pending] = await transaction.select({
          id: agentSessions.id,
          source: agentSessions.source,
          messages: agentSessions.messages,
          analytics: agentSessions.pendingAnalytics,
        }).from(agentSessions)
          .where(sql`${agentSessions.readyMessageCount} < jsonb_array_length(${agentSessions.messages})
            or (${agentSessions.pendingAnalytics} ->> 'throughLine')
              is distinct from (${agentSessions.readyAnalytics} ->> 'throughLine')
            or (${agentSessions.pendingAnalytics} -> 'repository' ->> 'key')
              is distinct from (${agentSessions.readyAnalytics} -> 'repository' ->> 'key')`)
          .orderBy(asc(agentSessions.receivedAt), asc(agentSessions.id))
          .limit(1)
          .for("update", { skipLocked: true });

        if (!pending) return undefined;

        const firstPrompt = pending.messages.find((message) => message.role === "user");
        const title = firstPrompt?.text.split("\n", 1)[0].trim().slice(0, 100)
          .replace(/[\uD800-\uDBFF]$/, "") || (pending.source === "codex" ? "Codex session" : "Claude Code session");
        const lastMessageLine = pending.messages.at(-1)?.line ?? 0;
        const analytics = pending.analytics;
        const readyAnalytics = analytics?.tokenCoverage === "reported" && analytics.throughLine < lastMessageLine
          ? { ...analytics, tokenCoverage: "partial" as const }
          : analytics;

        await transaction.update(agentSessions)
          .set({ title, readyMessageCount: pending.messages.length, readyAnalytics })
          .where(eq(agentSessions.id, pending.id));

        return pending.id;
      });
    },

    async close() {
      await connection.end();
    },
  };
}
