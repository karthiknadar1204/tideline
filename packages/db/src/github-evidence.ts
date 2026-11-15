import { githubCommitRepository } from "@tideline/contracts/github-evidence";
import type { GitHubCommitEvidence } from "@tideline/contracts/github-evidence";
import { and, eq, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentSessions, githubCommitEvidence, syncGrants, workspaces } from "./schema";
import { activeSyncGrant } from "./sync-grant";
import { workspaceAccessibleTo } from "./workspaces";

type Access = { userId: string } | { tokenHash: string };
type Transaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];
type Commit = { sha: string; url: string | null };

const verifiedCommits = (workspaceId: string, repository: string) => sql`
  select entry.value ->> 'sha' as sha, max(${agentSessions.startedAt}) as latest
  from ${agentSessions}
  cross join lateral jsonb_array_elements(${agentSessions.readyReview} -> 'commits') as entry(value)
  where ${agentSessions.workspaceId} = ${workspaceId}
    and ${agentSessions.readyMessageCount} > 0 and ${agentSessions.deletedAt} is null
    and entry.value ->> 'sha' ~ '^[0-9a-f]{40}$'
    and lower(entry.value ->> 'url') =
      ('https://github.com/' || ${repository} || '/commit/' || (entry.value ->> 'sha'))
  group by entry.value ->> 'sha'
`;

async function canAccess(db: Transaction, workspaceId: string, access: Access) {
  if ("tokenHash" in access) {
    const [grant] = await db.select({ workspaceId: syncGrants.workspaceId }).from(syncGrants)
      .where(activeSyncGrant(access.tokenHash)).for("update");
    return grant?.workspaceId === workspaceId;
  }
  const [workspace] = await db.select({ id: workspaces.id }).from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), workspaceAccessibleTo(access.userId)));
  return Boolean(workspace);
}

export function createGitHubEvidence(db: PostgresJsDatabase) {
  return {
    async evidenceTargets(workspaceId: string, repository: string, access: Access, refresh = false) {
      return db.transaction(async (transaction) => {
        if (!await canAccess(transaction, workspaceId, access)) return null;
        const targets = await transaction.execute<{ sha: string }>(sql`
          select verified.sha from (${verifiedCommits(workspaceId, repository)}) verified
          left join ${githubCommitEvidence} e on e.workspace_id = ${workspaceId} and e.repository = ${repository} and e.sha = verified.sha
          where ${refresh} or e.checked_at is null or e.checked_at < now() - interval '15 minutes'
          order by e.checked_at asc nulls first, verified.latest desc, verified.sha
          limit 6
        `);
        return targets.map(({ sha }) => sha);
      });
    },

    async recordEvidence(workspaceId: string, repository: string, commits: GitHubCommitEvidence[], access: Access) {
      return db.transaction(async (transaction) => {
        if (!await canAccess(transaction, workspaceId, access)) return null;
        if (!commits.length) return { received: 0 };
        const requested = sql.join(commits.map(({ sha }) => sql`${sha}`), sql`,`);
        const verified = await transaction.execute<{ sha: string }>(sql`
          select sha from (${verifiedCommits(workspaceId, repository)}) verified where sha in (${requested})
        `);
        const allowed = new Set(verified.map(({ sha }) => sha));
        const values = commits.filter(({ sha }) => allowed.has(sha));
        if (values.length) {
          await transaction.insert(githubCommitEvidence).values(values.map((evidence) => ({
            workspaceId, repository, sha: evidence.sha, evidence,
          }))).onConflictDoUpdate({
            target: [githubCommitEvidence.workspaceId, githubCommitEvidence.repository, githubCommitEvidence.sha],
            set: { evidence: sql`${githubCommitEvidence.evidence} || excluded.evidence`, checkedAt: sql`clock_timestamp()` },
          });
        }
        return { received: values.length };
      });
    },

    async evidenceForSession(workspaceId: string, commits: readonly Commit[]) {
      const targets = commits.flatMap((commit) => {
        const repository = githubCommitRepository(commit);
        return repository ? [and(eq(githubCommitEvidence.repository, repository), eq(githubCommitEvidence.sha, commit.sha))] : [];
      });
      if (!targets.length) return [];
      const rows = await db.select({ repository: githubCommitEvidence.repository, evidence: githubCommitEvidence.evidence })
        .from(githubCommitEvidence).where(and(eq(githubCommitEvidence.workspaceId, workspaceId), or(...targets)));
      return rows.map(({ repository, evidence }) => ({ ...evidence, repository }));
    },
  };
}
