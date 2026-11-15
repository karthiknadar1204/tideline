import { repositoryFilesResponse } from "@tideline/contracts";
import type { RepositoryEvidenceQuery } from "@tideline/contracts";
import { and, eq, gt, gte, isNotNull, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentSessions, repositoryInstructions, workspaces } from "./schema";
import { workspaceAccessibleTo } from "./workspaces";

type RepositoryAccess = { workspaceId: string; userId: string; repository: string };

export async function readRepositoryFiles(db: PostgresJsDatabase, access: RepositoryAccess, filters: RepositoryEvidenceQuery) {
  const { workspaceId, userId, repository } = access;
  const day = sql`left(${agentSessions.startedAt}, 10)`;
  const repositoryKey = sql`${agentSessions.readyAnalytics}->'repository'->>'key'`;
  const scope = and(
    eq(repositoryKey, repository),
    gt(agentSessions.readyMessageCount, 0),
    filters.from ? gte(day, filters.from) : undefined,
    filters.to ? lte(day, filters.to) : undefined,
    filters.source ? eq(agentSessions.source, filters.source) : undefined,
  );
  const { file, page } = filters;
  const limit = file ? 8 : 40;
  const order = sql`started desc, id desc, position desc`;
  const rows = file
    ? sql`select jsonb_build_object(
        'line', value->'line', 'index', value->'index', 'change', value->'change',
        'previousPath', value->'previousPath', 'diff', value->'diff', 'truncated', value->'truncated',
        'session', jsonb_build_object('id', id, 'title', title, 'source', source, 'startedAt', started)
      ) as row, started, id, position from changes
      where value->>'path' = ${file} order by ${order}`
    : sql`select jsonb_build_object(
        'path', path, 'change', value->'change', 'changes', change_count,
        'session', jsonb_build_object('id', id, 'title', title, 'source', source, 'startedAt', started)
      ) as row, started, id, position from (
        select value->>'path' as path, value, id, position, title, source, started,
          count(*) over (partition by value->>'path') as change_count,
          row_number() over (partition by value->>'path' order by ${order}) as rank
        from changes
      ) ranked where rank = 1 order by ${order}`;

  const [result] = await db.execute(sql`
    with permitted as (
      select ${workspaces.id} from ${workspaces}
      where ${workspaces.id} = ${workspaceId} and ${workspaceAccessibleTo(userId)}
    ), scoped as (
      select ${agentSessions.id} as id, ${agentSessions.title} as title, ${agentSessions.source} as source,
        ${agentSessions.startedAt} as started, ${agentSessions.readyCapture} as captured
      from ${agentSessions}
      inner join permitted on permitted.id = ${agentSessions.workspaceId}
      where ${scope} and ${isNotNull(agentSessions.title)}
    ), changes as (
      select scoped.id, title, source, started, file.value, file.position from scoped
      cross join lateral jsonb_array_elements(scoped.captured->'files') with ordinality as file(value, position)
    ), result_page as (
      ${rows} limit ${limit + 1} offset ${(page - 1) * limit}
    )
    select ${file ? "history" : "index"}::text as kind,
      coalesce((
        select jsonb_agg(row order by ${order}) from (
          select row, started, id, position from result_page order by ${order} limit ${limit}
        ) visible
      ), '[]'::jsonb) as rows,
      (select count(*) > ${limit} from result_page) as "hasNext",
      exists (select 1 from scoped where captured is null or captured->>'truncated' = 'true') as partial
    where exists (select 1 from permitted)
  `);
  return result && repositoryFilesResponse.parse(result);
}

export async function readRepositoryInstructions(db: PostgresJsDatabase, { workspaceId, userId, repository }: RepositoryAccess) {
  const [row] = await db.select({ workspaceId: workspaces.id, snapshot: repositoryInstructions.snapshot, observedAt: repositoryInstructions.observedAt })
    .from(workspaces)
    .leftJoin(repositoryInstructions, and(eq(repositoryInstructions.workspaceId, workspaces.id), eq(repositoryInstructions.repositoryKey, repository)))
    .where(and(eq(workspaces.id, workspaceId), workspaceAccessibleTo(userId)));
  if (!row) return undefined;
  return row.snapshot && row.observedAt ? { snapshot: row.snapshot, observedAt: row.observedAt.toISOString() } : null;
}
