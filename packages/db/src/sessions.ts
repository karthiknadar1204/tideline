import { isDeepStrictEqual } from "node:util";
import { CLI_SESSION_PAGE_SIZE, codexSkillCatalog, codexSkillInstructions, MAX_SESSION_COMMITS, sessionSourceLabel, WORKSPACE_SESSION_PAGE_SIZE } from "@tideline/contracts";
import type {
  CliSessionListQuery, RepositoryEvidenceQuery, RepositoryInstructionUpload, SessionActivity, SessionCapture, SessionImportRequest, SessionSummary, SyncInventoryUpdate,
  WorkspaceActivityKind, WorkspaceActivityQuery, WorkspaceSessionSearchQuery,
} from "@tideline/contracts";
import { and, asc, count, desc, eq, gt, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { alias } from "drizzle-orm/pg-core";
import { lockAccount } from "./account-retirement";
import { agentSessions, repositoryInstructions, sessionShares, syncGrants, syncInventories, transcriptAttachments, transcriptRecords, workspaceMembers, workspaces } from "./schema";
import { readRepositoryFiles, readRepositoryInstructions } from "./repository-evidence";
import { sessionReportedFrustration } from "./session-frustration";
import { mergeSessionCapture } from "./session-subagents";
import { advancedSessionSearch, recordedToolFailure, sessionActivityRows, sessionModels } from "./session-search";
import { mergeRepositorySettings, readRepositorySyncStatus, readSyncCoverage } from "./sync-inventory";
import { readWorkspaceActivity } from "./workspace-activity";
import { activeSyncGrant } from "./sync-grant";
import { workspaceAccessibleTo, workspaceManagedBy } from "./workspaces";

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

function withKnownMcpServers(activity: SessionActivity, known: SessionActivity): SessionActivity {
  const key = ({ line, index, name }: SessionActivity["tools"][number]) => `${line}:${index}:${name}`;
  const servers = new Map(known.tools.filter(({ mcpServer }) => mcpServer).map((tool) => [key(tool), tool.mcpServer]));
  if (!servers.size) return activity;
  return {
    ...activity,
    tools: activity.tools.map((tool) => {
      const mcpServer = servers.get(key(tool));
      return mcpServer && !tool.mcpServer ? { ...tool, mcpServer } : tool;
    }),
  };
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
  const { source, sourceSessionId, startedAt, events, analytics, activity, review, capture } = session;
  const messages = source === "codex" ? withoutLegacySkillContext(events) : events;
  if (!messages.length) return null;
  const [created] = await transaction
    .insert(agentSessions)
    .values({
      workspaceId, uploadedBy, source, sourceSessionId, startedAt, messages,
      pendingAnalytics: analytics, pendingActivity: activity, pendingReview: review, pendingCapture: capture,
    })
    .onConflictDoNothing({ target: [agentSessions.workspaceId, agentSessions.source, agentSessions.sourceSessionId] })
    .returning({ id: agentSessions.id });

  if (created) {
    return { id: created.id, alreadyReceived: false };
  }

  const [existing] = await transaction.select({
    id: agentSessions.id,
    uploadedBy: agentSessions.uploadedBy,
    deletedAt: agentSessions.deletedAt,
    startedAt: agentSessions.startedAt,
    messages: agentSessions.messages,
    analytics: agentSessions.pendingAnalytics,
    activity: agentSessions.pendingActivity,
    review: agentSessions.pendingReview,
    capture: sql<SessionCapture | null>`coalesce(${agentSessions.pendingCapture}, ${agentSessions.readyCapture})`,
  }).from(agentSessions).where(and(
    eq(agentSessions.workspaceId, workspaceId),
    eq(agentSessions.source, source),
    eq(agentSessions.sourceSessionId, sourceSessionId),
  )).for("update");

  if (!existing) {
    throw new Error("Import record disappeared before it could be checked.");
  }
  if (existing.deletedAt) return { id: existing.id, alreadyReceived: true };
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
  let activityUpdate = activity && activity.throughLine > previousActivityLine ? activity : undefined;
  if (activity && existing.activity && activity.throughLine >= previousActivityLine) {
    const received = withKnownMcpServers(activity, existing.activity);
    if (activity.throughLine === previousActivityLine &&
        !isDeepStrictEqual(withKnownMcpServers(existing.activity, activity), received)) return null;
    if (!isDeepStrictEqual(existing.activity, received)) activityUpdate = received;
  }
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
  const captureUpdate = mergeSessionCapture(existing.capture, capture);
  if (captureUpdate === null) return null;
  if (lengthDifference === 0 && !analyticsUpdate && !activityUpdate && !reviewUpdate && !captureUpdate) return replay;

  await transaction.update(agentSessions)
    .set({
      messages: lengthDifference > 0 || removesLegacyContext ? messages : undefined,
      readyMessageCount: removesLegacyContext ? 0 : undefined,
      pendingAnalytics: analyticsUpdate && {
        ...analyticsUpdate, repository: existing.analytics?.repository ?? analyticsUpdate.repository,
      },
      pendingActivity: activityUpdate,
      pendingReview: reviewUpdate,
      pendingCapture: captureUpdate,
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
        await lockAccount(transaction, userId);
        if (!await lockAccessibleWorkspace(transaction, workspaceId, userId)) return false;
        await transaction.insert(syncGrants).values({ tokenHash, workspaceId, userId, expiresAt });
        return true;
      });
    },

    async revokeSync(tokenHash: string) {
      return db.transaction(async (transaction) => {
        const [grant] = await transaction.update(syncGrants)
          .set({ revokedAt: sql`coalesce(${syncGrants.revokedAt}, now())` })
          .where(eq(syncGrants.tokenHash, tokenHash))
          .returning({ workspaceId: syncGrants.workspaceId });
        if (!grant) return false;
        await transaction.delete(syncInventories).where(eq(syncInventories.grantHash, tokenHash));
        return true;
      });
    },

    coverage(workspaceId: string, userId: string) {
      return readSyncCoverage(db, workspaceId, userId);
    },

    repositorySyncStatus(workspaceId: string, userId: string, query?: string) {
      return readRepositorySyncStatus(db, workspaceId, userId, query);
    },

    async updateInventory(tokenHash: string, update: SyncInventoryUpdate) {
      return db.transaction(async (transaction) => {
        const [grant] = await transaction.select({ workspaceId: syncGrants.workspaceId })
          .from(syncGrants).where(activeSyncGrant(tokenHash)).for("update");
        if (!grant) return "unauthorized";
        if (grant.workspaceId !== update.workspaceId.toLowerCase()) return "foreign-workspace";
        if ("clear" in update) {
          await transaction.delete(syncInventories).where(eq(syncInventories.grantHash, tokenHash));
        } else {
          const [previous] = await transaction.select({ report: syncInventories.report }).from(syncInventories)
            .where(eq(syncInventories.grantHash, tokenHash));
          const report = mergeRepositorySettings(update, previous?.report);
          await transaction.insert(syncInventories).values({ grantHash: tokenHash, workspaceId: grant.workspaceId, report })
            .onConflictDoUpdate({ target: syncInventories.grantHash, set: { report, updatedAt: sql`clock_timestamp()` } });
        }
        await transaction.delete(syncInventories).where(sql`${syncInventories.updatedAt} < clock_timestamp() - interval '90 days'`);
        return "accepted";
      });
    },

    async readSyncGrant(tokenHash: string) {
      const [grant] = await db.select({ workspaceId: syncGrants.workspaceId }).from(syncGrants).where(activeSyncGrant(tokenHash));
      return grant;
    },

    async hasActiveSyncGrant(workspaceId: string, userId: string) {
      const [grant] = await db.select({ workspaceId: syncGrants.workspaceId })
        .from(syncGrants)
        .where(and(
          eq(syncGrants.workspaceId, workspaceId),
          eq(syncGrants.userId, userId),
          isNull(syncGrants.revokedAt),
          gt(syncGrants.expiresAt, sql`clock_timestamp()`),
        ))
        .limit(1);
      return Boolean(grant);
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

    activity(access: { workspaceId: string; userId: string }, kind: WorkspaceActivityKind, filters: WorkspaceActivityQuery) {
      return readWorkspaceActivity(db, access, kind, filters);
    },

    repositoryFiles(access: Parameters<typeof readRepositoryFiles>[1], filters: RepositoryEvidenceQuery) {
      return readRepositoryFiles(db, access, filters);
    },

    repositoryInstructions(access: Parameters<typeof readRepositoryInstructions>[1]) {
      return readRepositoryInstructions(db, access);
    },

    async receiveRepositoryInstructions(tokenHash: string, { workspaceId: inputWorkspace, repository, snapshot, contextOnly }: RepositoryInstructionUpload) {
      return db.transaction(async (transaction) => {
        const [grant] = await transaction.select({ workspaceId: syncGrants.workspaceId, userId: syncGrants.userId })
          .from(syncGrants).where(activeSyncGrant(tokenHash)).for("update");
        if (!grant?.userId) return "unauthorized";
        if (grant.workspaceId !== inputWorkspace.toLowerCase()) return "foreign-workspace";

        const [existing] = await transaction.select({ id: agentSessions.id }).from(agentSessions).where(and(
          eq(agentSessions.workspaceId, grant.workspaceId),
          sql`coalesce(${agentSessions.readyAnalytics}, ${agentSessions.pendingAnalytics})->'repository'->>'key' = ${repository}`,
        )).limit(1);
        if (!existing) return "unknown-repository";

        const stored = repositoryInstructions.snapshot;
        const merged = contextOnly ? sql`jsonb_set(${stored}, '{context}', excluded.snapshot -> 'context')` : snapshot.context ? sql`excluded.snapshot` : sql`
          case when ${stored} ? 'context' then jsonb_set(excluded.snapshot, '{context}', ${stored} -> 'context') else excluded.snapshot end`;
        await transaction.insert(repositoryInstructions).values({ workspaceId: grant.workspaceId, repositoryKey: repository, snapshot })
          .onConflictDoUpdate({
            target: [repositoryInstructions.workspaceId, repositoryInstructions.repositoryKey],
            set: { snapshot: merged, observedAt: sql`clock_timestamp()` },
            setWhere: sql`${stored} is distinct from (${merged})`,
          });
        return "accepted";
      });
    },

    async listReady(workspaceId: string) {
      return db.select({ ...summaryFields, activityCounts }).from(agentSessions)
        .where(and(eq(agentSessions.workspaceId, workspaceId), gt(agentSessions.readyMessageCount, 0)))
        .orderBy(desc(agentSessions.receivedAt), desc(agentSessions.id));
    },

    async listReadyForDigest(workspaceId: string, { from, to }: { from: string; to: string }) {
      const day = sql`left(${agentSessions.startedAt}, 10)`;
      return db.select({ ...summaryFields, activityCounts, recordedToolFailure }).from(agentSessions)
        .where(and(eq(agentSessions.workspaceId, workspaceId), gt(agentSessions.readyMessageCount, 0), gte(day, from), lte(day, to)))
        .orderBy(desc(agentSessions.startedAt), desc(agentSessions.id));
    },

    async listReadyForTrends({ workspaceId, userId }: { workspaceId: string; userId: string }, { from, to }: { from: string; to: string }) {
      return db.transaction(async (transaction) => {
        const [accessible] = await transaction.select({ id: workspaces.id }).from(workspaces)
          .where(and(eq(workspaces.id, workspaceId), workspaceAccessibleTo(userId)));
        if (!accessible) return;
        const day = sql`left(${agentSessions.startedAt}, 10)`;
        return transaction.select({ ...summaryFields, activityCounts, recordedToolFailure, reportedFrustration: sessionReportedFrustration })
          .from(agentSessions)
          .where(and(eq(agentSessions.workspaceId, workspaceId), gt(agentSessions.readyMessageCount, 0), gte(day, from), lte(day, to)))
          .orderBy(desc(agentSessions.startedAt), desc(agentSessions.id));
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async listReadyWithInsights(workspaceId: string, userId: string) {
      const rows = await db.select({
        ...summaryFields,
        activityCounts,
        reportedFrustration: sessionReportedFrustration,
        activeMemberId: sql<string | null>`case
          when ${workspaces.kind} = 'team' and ${agentSessions.uploadedBy} = ${workspaces.ownerId} then ${workspaces.ownerId}
          when ${workspaceMembers.removedAt} is null then ${workspaceMembers.userId}
          else null end`,
        formerMember: sql<boolean>`${workspaceMembers.removedAt} is not null`,
      }).from(agentSessions)
        .innerJoin(workspaces, eq(agentSessions.workspaceId, workspaces.id))
        .leftJoin(workspaceMembers, and(
          eq(workspaces.kind, "team"),
          eq(workspaceMembers.workspaceId, agentSessions.workspaceId),
          eq(workspaceMembers.userId, agentSessions.uploadedBy),
        ))
        .where(and(
          eq(workspaces.id, workspaceId),
          workspaceAccessibleTo(userId),
          gt(agentSessions.readyMessageCount, 0),
        ))
        .orderBy(desc(agentSessions.receivedAt), desc(agentSessions.id));

      return rows.map(({ activeMemberId, formerMember, ...summary }) => ({
        ...summary,
        member: activeMemberId ? { kind: "active" as const, id: activeMemberId }
          : { kind: formerMember ? "former" as const : "unknown" as const },
      }));
    },

    async searchReady(workspaceId: string, filters: WorkspaceSessionSearchQuery, { includeActivityFacets = false } = {}) {
      const ready = and(eq(agentSessions.workspaceId, workspaceId), gt(agentSessions.readyMessageCount, 0));
      const repositoryKey = sql<string>`${agentSessions.readyAnalytics} -> 'repository' ->> 'key'`;
      const repositoryName = sql<string>`${agentSessions.readyAnalytics} -> 'repository' ->> 'name'`;
      const availableModel = sql<string>`available_models.value ->> 'model'`;
      const sessionDay = sql`left(${agentSessions.startedAt}, 10)`;
      const matches = and(
        ready,
        filters.source === undefined ? undefined : eq(agentSessions.source, filters.source),
        filters.repository === undefined ? undefined : eq(repositoryKey, filters.repository),
        filters.model === undefined ? undefined : sql`exists (
          select 1 from ${sessionModels} as filter_models(value) where filter_models.value ->> 'model' = ${filters.model}
        )`,
        filters.from === undefined ? undefined : gte(sessionDay, filters.from),
        filters.to === undefined ? undefined : lte(sessionDay, filters.to),
        advancedSessionSearch(filters),
      );

      return db.transaction(async (transaction) => {
        const activityName = sql<string>`available_activity.value ->> 'name'`;
        const activityNames = (kind: "skills" | "children") => transaction.selectDistinct({ name: activityName }).from(agentSessions)
          .crossJoinLateral(sql`${sessionActivityRows(kind)} as available_activity(value)`)
          .where(and(ready, isNotNull(activityName))).orderBy(asc(activityName)).limit(250);
        const [[totals], repositories, modelRows, skills, subagents] = await Promise.all([
          transaction.select({ total: count() }).from(agentSessions).where(matches),
          transaction.select({ key: repositoryKey, name: sql<string>`min(${repositoryName})` }).from(agentSessions)
            .where(and(ready, isNotNull(repositoryKey), isNotNull(repositoryName)))
            .groupBy(repositoryKey).orderBy(asc(sql`min(${repositoryName})`), asc(repositoryKey)),
          transaction.selectDistinct({ model: availableModel }).from(agentSessions)
            .crossJoinLateral(sql`${sessionModels} as available_models(value)`)
            .where(and(ready, isNotNull(availableModel))).orderBy(asc(availableModel)),
          includeActivityFacets ? activityNames("skills") : [],
          includeActivityFacets ? activityNames("children") : [],
        ]);
        const total = totals.total;
        const page = Math.min(filters.page, Math.max(1, Math.ceil(total / WORKSPACE_SESSION_PAGE_SIZE)));
        const order = filters.sort === "oldest" ? [asc(agentSessions.startedAt), asc(agentSessions.id)]
          : filters.sort === "newest" ? [desc(agentSessions.startedAt), desc(agentSessions.id)]
          : [desc(agentSessions.receivedAt), desc(agentSessions.id)];
        const sessions = total ? await transaction.select({ ...summaryFields, activityCounts }).from(agentSessions).where(matches)
          .orderBy(...order)
          .limit(WORKSPACE_SESSION_PAGE_SIZE).offset((page - 1) * WORKSPACE_SESSION_PAGE_SIZE) : [];
        return {
          sessions, total, page, repositories, models: modelRows.map(({ model }) => model),
          skills: skills.map(({ name }) => name), subagents: subagents.map(({ name }) => name),
        };
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

    async findReady(workspaceId: string, sessionId: string, { includeCapture = false } = {}) {
      const [session] = await db.select({
        ...summaryFields,
        activity: agentSessions.readyActivity,
        review: agentSessions.readyReview,
        sourceSessionId: agentSessions.sourceSessionId,
        messages: agentSessions.messages,
        ...(includeCapture && { capture: agentSessions.readyCapture }),
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

    async deleteManaged({ workspaceId, sessionId, userId }: { workspaceId: string; sessionId: string; userId: string }) {
      return db.transaction(async (transaction) => {
        const scope = and(eq(workspaces.id, workspaceId), workspaceManagedBy(userId));
        const [locked] = await transaction.select({ id: workspaces.id }).from(workspaces)
          .where(scope).for("no key update");
        if (!locked) return false;
        const [authorized] = await transaction.select({ id: workspaces.id }).from(workspaces).where(scope);
        if (!authorized) return false;

        // Keep only the identity needed to acknowledge collector retries without recreating the session.
        const [deleted] = await transaction.update(agentSessions)
          .set({
            deletedAt: sql`coalesce(${agentSessions.deletedAt}, now())`,
            uploadedBy: null,
            title: null,
            messages: [],
            readyMessageCount: 0,
            pendingAnalytics: null,
            readyAnalytics: null,
            pendingActivity: null,
            readyActivity: null,
            pendingReview: null,
            readyReview: null,
            pendingCapture: null,
            readyCapture: null,
          })
          .where(and(eq(agentSessions.workspaceId, workspaceId), eq(agentSessions.id, sessionId)))
          .returning({ id: agentSessions.id });
        if (!deleted) return false;
        await transaction.delete(sessionShares).where(eq(sessionShares.sessionId, deleted.id));
        await transaction.delete(transcriptRecords).where(eq(transcriptRecords.sessionId, deleted.id));
        await transaction.delete(transcriptAttachments).where(eq(transcriptAttachments.sessionId, deleted.id));
        return true;
      });
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
          capture: agentSessions.pendingCapture,
        }).from(agentSessions)
          .where(sql`${agentSessions.readyMessageCount} < jsonb_array_length(${agentSessions.messages})
            or (${agentSessions.pendingAnalytics} ->> 'throughLine')
              is distinct from (${agentSessions.readyAnalytics} ->> 'throughLine')
            or (${agentSessions.pendingAnalytics} -> 'repository' ->> 'key')
              is distinct from (${agentSessions.readyAnalytics} -> 'repository' ->> 'key')
            or ${agentSessions.pendingActivity} is distinct from ${agentSessions.readyActivity}
            or ${agentSessions.pendingReview} is distinct from ${agentSessions.readyReview}
            or ${agentSessions.pendingCapture} is not null`)
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
          .set({
            title, readyMessageCount: pending.messages.length, readyAnalytics,
            readyActivity: pending.activity, readyReview: pending.review,
            readyCapture: pending.capture ?? undefined, pendingCapture: null,
          })
          .where(eq(agentSessions.id, pending.id));

        return pending.id;
      });
    },

    async close() {
      await connection.end();
    },
  };
}
