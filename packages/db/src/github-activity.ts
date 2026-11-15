import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { GitHubActivityQuery, GitHubActivityUpload } from "@tideline/contracts";
import { createGitHubEvidence } from "./github-evidence";
import { githubActivityEvents, syncGrants, workspaces } from "./schema";
import { activeSyncGrant } from "./sync-grant";
import { workspaceAccessibleTo } from "./workspaces";

type Activity = GitHubActivityUpload & { workspaceId: string; repositoryKey: string };

export function createGitHubActivityStore(databaseUrl: string) {
  const db = drizzle(postgres(databaseUrl));
  type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

  async function write(transaction: Transaction, { workspaceId, repository, repositoryKey, events }: Activity) {
    if (events.length) {
      await transaction.insert(githubActivityEvents).values(events.map((event) => ({
        workspaceId, repository, repositoryKey, kind: event.kind, externalId: event.id, event,
        happenedAt: new Date(event.at),
      }))).onConflictDoUpdate({
        target: [githubActivityEvents.workspaceId, githubActivityEvents.repositoryKey, githubActivityEvents.kind, githubActivityEvents.externalId],
        set: { event: sql`excluded.event`, repository: sql`excluded.repository`, happenedAt: sql`excluded.happened_at` },
      });
    }
    return { received: events.length };
  }

  return {
    ...createGitHubEvidence(db),
    async record(activity: Activity, userId: string) {
      return db.transaction(async (transaction) => {
        const [access] = await transaction.select({ id: workspaces.id }).from(workspaces)
          .where(and(eq(workspaces.id, activity.workspaceId), workspaceAccessibleTo(userId)));
        if (!access) return null;
        return write(transaction, activity);
      });
    },
    async recordCollector(activity: Activity, tokenHash: string) {
      return db.transaction(async (transaction) => {
        const [grant] = await transaction.select({ workspaceId: syncGrants.workspaceId }).from(syncGrants)
          .where(activeSyncGrant(tokenHash)).for("update");
        if (!grant) return { kind: "unauthorized" } as const;
        if (grant.workspaceId !== activity.workspaceId.toLowerCase()) return { kind: "foreign-workspace" } as const;
        return { kind: "accepted", receipt: await write(transaction, activity) } as const;
      });
    },
    async list(workspaceId: string, userId: string, query: GitHubActivityQuery) {
      const [access] = await db.select({ id: workspaces.id }).from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), workspaceAccessibleTo(userId)));
      if (!access) return null;
      const filters = and(
        eq(githubActivityEvents.workspaceId, workspaceId),
        query.repository ? eq(githubActivityEvents.repositoryKey, query.repository) : undefined,
        query.repoName ? eq(sql`lower(split_part(${githubActivityEvents.repository}, '/', 2))`, query.repoName.toLowerCase()) : undefined,
        query.from ? gte(githubActivityEvents.happenedAt, new Date(`${query.from}T00:00:00.000Z`)) : undefined,
        query.to ? lte(githubActivityEvents.happenedAt, new Date(`${query.to}T23:59:59.999Z`)) : undefined,
      );
      const kind = query.kind;
      const [events, totals] = await Promise.all([
        db.select({ repository: githubActivityEvents.repository, event: githubActivityEvents.event })
          .from(githubActivityEvents).where(and(filters, kind ? eq(githubActivityEvents.kind, kind) : undefined))
          .orderBy(desc(githubActivityEvents.happenedAt), desc(githubActivityEvents.externalId)).limit(1_001),
        db.select({ kind: githubActivityEvents.kind, total: count() })
          .from(githubActivityEvents).where(filters).groupBy(githubActivityEvents.kind),
      ]);
      const counts = { merge: 0, ci: 0 };
      for (const { kind, total } of totals) if (kind === "merge" || kind === "ci") counts[kind] = total;
      return { events: events.slice(0, 1_000), counts, hasMore: events.length > 1_000 };
    },
  };
}
