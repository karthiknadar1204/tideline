import { isDeepStrictEqual } from "node:util";
import { CLI_SESSION_PAGE_SIZE, codexSkillCatalog, codexSkillInstructions, MAX_SESSION_COMMITS, sessionSourceLabel, WORKSPACE_SESSION_PAGE_SIZE } from "@tideline/contracts";
import type { CliSessionListQuery, SessionActivity, SessionImportRequest, SessionSummary, WorkspaceSessionSearchQuery } from "@tideline/contracts";
import { and, asc, count, desc, eq, gt, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { alias } from "drizzle-orm/pg-core";
import { agentSessions, syncGrants, workspaces } from "./schema";
import { workspaceAccessibleTo } from "./workspaces";

type Transaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];
type Messages = SessionImportRequest["session"]["events"];

function withoutLegacySkillContext(messages: Messages) {
  return messages.filter(({ role, text }) => role !== "user" ||
    (!codexSkillInstructions.test(text) && !codexSkillCatalog.test(text)));
}

function countActivity(activity: SessionActivity | null): SessionSummary["activityCounts"] {
  return activity && {
    tools: activity.tools.length,
    skills: activity.skills.length,
    children: activity.children.length,
    truncated: activity.truncated,
  };
}

function activeSyncGrant(tokenHash: string) {
  return and(eq(syncGrants.tokenHash, tokenHash), isNull(syncGrants.revokedAt), gt(syncGrants.expiresAt, sql`clock_timestamp()`));
}

async function lockAccessibleWorkspace(transaction: Transaction, workspaceId: string, userId: string) {
  const [locked] = await transaction.select({ id: workspaces.id }).from(workspaces)
    .where(eq(workspaces.id, workspaceId)).for("no key update");
  if (!locked) return;
  const [accessible] = await transaction.select({ kind: workspaces.kind }).from(workspaces)
    .where(and(eq(workspaces.id, locked.id), workspaceAccessibleTo(userId)));
  return accessible;
}

async function receiveSession(
  transaction: Transaction,
  { workspaceId, session }: SessionImportRequest,
  allowAppend: boolean,
  uploadedBy: string | null,
) {
  const { source, sourceSessionId, startedAt, events, analytics, activity, review } = session;
  const messages = source === "codex" ? withoutLegacySkillContext(events) : events;
  if (!messages.length) return null;
  const [created] = await transaction
    .insert(agentSessions)
    .values({ workspaceId, uploadedBy, source, sourceSessionId, startedAt, messages, pendingAnalytics: analytics, pendingActivity: activity, pendingReview: review })
    .onConflictDoNothing({ target: [agentSessions.workspaceId, agentSessions.source, agentSessions.sourceSessionId] })
    .returning({ id: agentSessions.id });

  if (created) {
    return { id: created.id, alreadyReceived: false };
  }

  const [existing] = await transaction.select({
    id: agentSessions.id,
    uploadedBy: agentSessions.uploadedBy,
    startedAt: agentSessions.startedAt,
    messages: agentSessions.messages,
    analytics: agentSessions.pendingAnalytics,
    activity: agentSessions.pendingActivity,
    review: agentSessions.pendingReview,
  }).from(agentSessions).where(and(
    eq(agentSessions.workspaceId, workspaceId),
    eq(agentSessions.source, source),
    eq(agentSessions.sourceSessionId, sourceSessionId),
  )).for("update");

  if (!existing) {
    throw new Error("Import record disappeared before it could be checked.");
  }
  if (existing.uploadedBy !== uploadedBy) return null;

  const priorMessages = source === "codex" && activity && !existing.activity
    ? withoutLegacySkillContext(existing.messages) : existing.messages;
  const removesLegacyContext = priorMessages.length !== existing.messages.length;
  const lengthDifference = messages.length - priorMessages.length;
  const sharedMessageCount = Math.min(messages.length, priorMessages.length);
  if (existing.startedAt !== startedAt ||
      (!allowAppend && lengthDifference !== 0) ||
      !isDeepStrictEqual(priorMessages.slice(0, sharedMessageCount), messages.slice(0, sharedMessageCount))) {
    return null;
  }

  const replay = { id: existing.id, alreadyReceived: true };
  if (lengthDifference < 0) return replay;

  const previousLine = existing.analytics?.throughLine ?? 0;
  const nextLine = analytics?.throughLine ?? 0;
  const repositoryEnrichment = analytics?.repository && !existing.analytics?.repository;
  const correctsLegacyCoverage = removesLegacyContext && isDeepStrictEqual(existing.analytics?.models, analytics?.models);
  const legacyContextReplay = source === "codex" && !activity && events.length !== messages.length;
  let analyticsUpdate = analytics;
  if (analytics && nextLine <= previousLine) {
    if (lengthDifference > 0 || (nextLine === previousLine && (
      !isDeepStrictEqual(existing.analytics?.models, analytics.models) ||
      (existing.analytics?.tokenCoverage !== analytics.tokenCoverage && !correctsLegacyCoverage && !legacyContextReplay)
    ))) {
      return null;
    }
    if (nextLine < previousLine || (!repositoryEnrichment && !correctsLegacyCoverage)) analyticsUpdate = undefined;
  }
  const previousActivityLine = existing.activity?.throughLine ?? 0;
  if (activity?.throughLine === previousActivityLine && !isDeepStrictEqual(existing.activity, activity)) return null;
  const activityUpdate = activity && activity.throughLine > previousActivityLine ? activity : undefined;
  const previousReviewLine = existing.review?.throughLine ?? 0;
  let reviewUpdate = review && review.throughLine > previousReviewLine ? review : undefined;
  if (review && existing.review && review.throughLine === previousReviewLine) {
    if (!isDeepStrictEqual(existing.review.findings, review.findings)) return null;
    const previousCommits = new Map(existing.review.commits.map((commit) => [commit.sha, commit]));
    for (const commit of review.commits) {
      const previous = previousCommits.get(commit.sha);
      if (!previous || (previous.url === null && commit.url !== null)) {
        previousCommits.set(commit.sha, previous ? { ...previous, url: commit.url } : commit);
      }
    }
    const commits = [...previousCommits.values()].slice(0, MAX_SESSION_COMMITS);
    const next = {
      ...review,
      commits,
      truncated: review.truncated || existing.review.truncated || previousCommits.size > MAX_SESSION_COMMITS,
    };
    if (!isDeepStrictEqual(existing.review, next)) reviewUpdate = next;
  }
  if (lengthDifference === 0 && !analyticsUpdate && !activityUpdate && !reviewUpdate) return replay;

  await transaction.update(agentSessions)
    .set({
      messages: lengthDifference > 0 || removesLegacyContext ? messages : undefined,
      readyMessageCount: removesLegacyContext ? 0 : undefined,
      pendingAnalytics: analyticsUpdate && {
        ...analyticsUpdate, repository: existing.analytics?.repository ?? analyticsUpdate.repository,
      },
      pendingActivity: activityUpdate,
      pendingReview: reviewUpdate,
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
  const activityCounts = sql<SessionSummary["activityCounts"]>`case when ${agentSessions.readyActivity} is not null then
    jsonb_build_object(
      'tools', jsonb_array_length(${agentSessions.readyActivity} -> 'tools'),
      'skills', jsonb_array_length(${agentSessions.readyActivity} -> 'skills'),
      'children', jsonb_array_length(${agentSessions.readyActivity} -> 'children'),
      'truncated', ${agentSessions.readyActivity} -> 'truncated'
    ) else null end`;

  return {
    async receive(request: SessionImportRequest, userId: string) {
      return db.transaction(async (transaction) => {
        const workspace = await lockAccessibleWorkspace(transaction, request.workspaceId, userId);
        if (!workspace) return;
        return receiveSession(transaction, request, false, workspace.kind === "team" ? userId : null);
      });
    },

    async enrollSync({ tokenHash, workspaceId, userId, expiresAt }: {
      tokenHash: string;
      workspaceId: string;
      userId: string;
      expiresAt: Date;
    }) {
      return db.transaction(async (transaction) => {
        if (!await lockAccessibleWorkspace(transaction, workspaceId, userId)) return false;
        await transaction.insert(syncGrants).values({ tokenHash, workspaceId, userId, expiresAt });
        return true;
      });
    },

    async revokeSync(tokenHash: string) {
      const [grant] = await db.update(syncGrants)
        .set({ revokedAt: sql`coalesce(${syncGrants.revokedAt}, now())` })
        .where(eq(syncGrants.tokenHash, tokenHash))
        .returning({ workspaceId: syncGrants.workspaceId });

      return Boolean(grant);
    },

    async readSyncGrant(tokenHash: string) {
      const [grant] = await db.select({ workspaceId: syncGrants.workspaceId }).from(syncGrants).where(activeSyncGrant(tokenHash));
      return grant;
    },

    async receiveSync(tokenHash: string, request: SessionImportRequest) {
      return db.transaction(async (transaction) => {
        const [grant] = await transaction.select({ workspaceId: syncGrants.workspaceId, userId: syncGrants.userId, kind: workspaces.kind })
          .from(syncGrants)
          .innerJoin(workspaces, eq(workspaces.id, syncGrants.workspaceId))
          .where(activeSyncGrant(tokenHash))
          .for("update", { of: syncGrants });

        if (!grant || (grant.kind === "team" && !grant.userId)) return { kind: "unauthorized" } as const;
        if (grant.workspaceId !== request.workspaceId.toLowerCase()) return { kind: "foreign-workspace" } as const;

        const receipt = await receiveSession(transaction, request, true, grant.kind === "team" ? grant.userId : null);
        return receipt ? { kind: "accepted", receipt } as const : { kind: "conflict" } as const;
      });
    },

    async listReady(workspaceId: string) {
      return db.select({ ...summaryFields, activityCounts }).from(agentSessions)
        .where(and(eq(agentSessions.workspaceId, workspaceId), gt(agentSessions.readyMessageCount, 0)))
        .orderBy(desc(agentSessions.receivedAt), desc(agentSessions.id));
    },

    async searchReady(workspaceId: string, filters: WorkspaceSessionSearchQuery) {
      const ready = and(eq(agentSessions.workspaceId, workspaceId), gt(agentSessions.readyMessageCount, 0));
      const repositoryKey = sql<string>`${agentSessions.readyAnalytics} -> 'repository' ->> 'key'`;
      const repositoryName = sql<string>`${agentSessions.readyAnalytics} -> 'repository' ->> 'name'`;
      const models = sql`jsonb_array_elements(${agentSessions.readyAnalytics} -> 'models')`;
      const availableModel = sql<string>`available_models.value ->> 'model'`;
      const sessionDay = sql`left(${agentSessions.startedAt}, 10)`;
      const matches = and(
        ready,
        filters.source === undefined ? undefined : eq(agentSessions.source, filters.source),
        filters.repository === undefined ? undefined : eq(repositoryKey, filters.repository),
        filters.model === undefined ? undefined : sql`exists (
          select 1 from ${models} as filter_models(value) where filter_models.value ->> 'model' = ${filters.model}
        )`,
        filters.from === undefined ? undefined : gte(sessionDay, filters.from),
        filters.to === undefined ? undefined : lte(sessionDay, filters.to),
        filters.query === undefined ? undefined : sql`(
          strpos(lower(${agentSessions.title}), lower(${filters.query})) > 0
          or exists (
            select 1 from jsonb_array_elements(${agentSessions.messages}) with ordinality as entry(message, position)
            where entry.position <= ${agentSessions.readyMessageCount}
              and entry.message ->> 'role' in ('user', 'assistant')
              and strpos(lower(entry.message ->> 'text'), lower(${filters.query})) > 0
          )
        )`,
      );

      return db.transaction(async (transaction) => {
        const [[totals], repositories, modelRows] = await Promise.all([
          transaction.select({ total: count() }).from(agentSessions).where(matches),
          transaction.select({ key: repositoryKey, name: sql<string>`min(${repositoryName})` }).from(agentSessions)
            .where(and(ready, isNotNull(repositoryKey), isNotNull(repositoryName)))
            .groupBy(repositoryKey).orderBy(asc(sql`min(${repositoryName})`), asc(repositoryKey)),
          transaction.selectDistinct({ model: availableModel }).from(agentSessions)
            .crossJoinLateral(sql`${models} as available_models(value)`)
            .where(and(ready, isNotNull(availableModel))).orderBy(asc(availableModel)),
        ]);
        const total = totals.total;
        const page = Math.min(filters.page, Math.max(1, Math.ceil(total / WORKSPACE_SESSION_PAGE_SIZE)));
        const sessions = total ? await transaction.select({ ...summaryFields, activityCounts }).from(agentSessions).where(matches)
          .orderBy(desc(agentSessions.receivedAt), desc(agentSessions.id))
          .limit(WORKSPACE_SESSION_PAGE_SIZE).offset((page - 1) * WORKSPACE_SESSION_PAGE_SIZE) : [];
        return { sessions, total, page, repositories, models: modelRows.map(({ model }) => model) };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async pageReady(workspaceId: string, { repo, source, from, to, after }: CliSessionListQuery) {
      const cursor = alias(agentSessions, "session_cursor");
      const cursorKey = after === undefined ? undefined : db.select({ receivedAt: cursor.receivedAt, id: cursor.id }).from(cursor)
        .where(and(eq(cursor.workspaceId, workspaceId), eq(cursor.id, after)));
      const rows = await db.select({ ...summaryFields, activityCounts }).from(agentSessions)
        .where(and(
          eq(agentSessions.workspaceId, workspaceId),
          gt(agentSessions.readyMessageCount, 0),
          repo === undefined ? undefined : sql`lower(${agentSessions.readyAnalytics} -> 'repository' ->> 'name') = ${repo.toLowerCase()}`,
          source === undefined ? undefined : eq(agentSessions.source, source),
          from === undefined ? undefined : gte(agentSessions.startedAt, from),
          to === undefined ? undefined : sql`left(${agentSessions.startedAt}, 10) <= ${to}`,
          cursorKey === undefined ? undefined : sql`(${agentSessions.receivedAt}, ${agentSessions.id}) < (${cursorKey})`,
        ))
        .orderBy(desc(agentSessions.receivedAt), desc(agentSessions.id))
        .limit(CLI_SESSION_PAGE_SIZE + 1);
      const sessions = rows.slice(0, CLI_SESSION_PAGE_SIZE);
      return { sessions, nextCursor: rows.length > sessions.length ? sessions[CLI_SESSION_PAGE_SIZE - 1].id : null };
    },

    async findReady(workspaceId: string, sessionId: string) {
      const [session] = await db.select({
        ...summaryFields,
        activity: agentSessions.readyActivity,
        review: agentSessions.readyReview,
        sourceSessionId: agentSessions.sourceSessionId,
        messages: agentSessions.messages,
      }).from(agentSessions).where(and(
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.id, sessionId),
        gt(agentSessions.readyMessageCount, 0),
      ));

      if (!session) return;
      const { activity, review, messages, ...summary } = session;
      return {
        ...summary,
        activityCounts: countActivity(activity),
        activity: activity && {
          truncated: activity.truncated, tools: activity.tools, skills: activity.skills, children: activity.children,
        },
        review: review && { commits: review.commits, findings: review.findings, truncated: review.truncated },
        messages: messages.slice(0, session.messageCount),
      };
    },

    async processNext() {
      return db.transaction(async (transaction) => {
        const [pending] = await transaction.select({
          id: agentSessions.id,
          source: agentSessions.source,
          messages: agentSessions.messages,
          analytics: agentSessions.pendingAnalytics,
          activity: agentSessions.pendingActivity,
          review: agentSessions.pendingReview,
        }).from(agentSessions)
          .where(sql`${agentSessions.readyMessageCount} < jsonb_array_length(${agentSessions.messages})
            or (${agentSessions.pendingAnalytics} ->> 'throughLine')
              is distinct from (${agentSessions.readyAnalytics} ->> 'throughLine')
            or (${agentSessions.pendingAnalytics} -> 'repository' ->> 'key')
              is distinct from (${agentSessions.readyAnalytics} -> 'repository' ->> 'key')
            or (${agentSessions.pendingActivity} ->> 'throughLine')
              is distinct from (${agentSessions.readyActivity} ->> 'throughLine')
            or ${agentSessions.pendingReview} is distinct from ${agentSessions.readyReview}`)
          .orderBy(asc(agentSessions.receivedAt), asc(agentSessions.id))
          .limit(1)
          .for("update", { skipLocked: true });

        if (!pending) return undefined;

        const firstPrompt = pending.messages.find((message) => message.role === "user");
        const title = firstPrompt?.text.split("\n", 1)[0].trim().slice(0, 100)
          .replace(/[\uD800-\uDBFF]$/, "") || `${sessionSourceLabel[pending.source]} session`;
        const lastMessageLine = pending.messages.at(-1)?.line ?? 0;
        const analytics = pending.analytics;
        const readyAnalytics = analytics?.tokenCoverage === "reported" && analytics.throughLine < lastMessageLine
          ? { ...analytics, tokenCoverage: "partial" as const }
          : analytics;

        await transaction.update(agentSessions)
          .set({ title, readyMessageCount: pending.messages.length, readyAnalytics, readyActivity: pending.activity, readyReview: pending.review })
          .where(eq(agentSessions.id, pending.id));

        return pending.id;
      });
    },

    async close() {
      await connection.end();
    },
  };
}
