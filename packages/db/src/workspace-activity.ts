import type { WorkspaceActivityKind, WorkspaceActivityQuery } from "@tideline/contracts";
import { workspaceActivityResponse } from "@tideline/contracts";
import { and, eq, gt, gte, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentSessions, workspaces } from "./schema";
import { workspaceAccessibleTo } from "./workspaces";

const maximumRows = 100;

export async function readWorkspaceActivity(db: PostgresJsDatabase, { workspaceId, userId }: {
  workspaceId: string;
  userId: string;
}, kind: WorkspaceActivityKind, filters: WorkspaceActivityQuery) {
  const sessionDay = sql`left(${agentSessions.startedAt}, 10)`;
  const repositoryKey = sql`${agentSessions.readyAnalytics} -> 'repository' ->> 'key'`;
  const scope = and(
    gt(agentSessions.readyMessageCount, 0),
    filters.from ? gte(sessionDay, filters.from) : undefined,
    filters.to ? lte(sessionDay, filters.to) : undefined,
    filters.source ? eq(agentSessions.source, filters.source) : undefined,
    filters.repository ? eq(repositoryKey, filters.repository) : undefined,
  );
  const activityKey = kind === "skills" ? "skills" : "tools";
  const toolName = sql`entry.value ->> 'name'`;
  const qualifiedServer = sql`split_part(${toolName}, '__', 2)`;
  const mcpServer = sql`coalesce(entry.value ->> 'mcpServer',
    case when split_part(${toolName}, '__', 1) = 'mcp'
      and ${qualifiedServer} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$'
      and split_part(${toolName}, '__', 3) <> '' then ${qualifiedServer} end)`;
  const name = kind === "skills" ? toolName : mcpServer;

  const [result] = await db.execute(sql`
    with permitted as (
      select ${workspaces.id} from ${workspaces}
      where ${workspaces.id} = ${workspaceId} and ${workspaceAccessibleTo(userId)}
    ), scoped as (
      select ${agentSessions.id} as id, ${agentSessions.startedAt} as started, ${agentSessions.readyActivity} as activity
      from ${agentSessions}
      inner join permitted on permitted.id = ${agentSessions.workspaceId}
      where ${scope}
    ), hits as (
      select ${name} as name, scoped.id, scoped.started, entry.value ->> 'status' as status
      from scoped
      cross join lateral jsonb_array_elements(scoped.activity -> ${activityKey}::text) as entry(value)
    ), ranked as (
      select name, count(*)::integer as calls, count(distinct id)::integer as sessions,
        count(*) filter (where status = 'failed')::integer as failed
      from hits where name is not null group by name
    ), top as (
      select * from ranked order by calls desc, name asc limit ${maximumRows}
    ), latest as (
      select distinct on (hits.name) hits.name, hits.id, hits.started
      from hits inner join top on top.name = hits.name
      order by hits.name, hits.started desc, hits.id desc
    ), coverage as (
      select count(*)::integer as "sessionCount",
        count(activity)::integer as "coveredSessions",
        count(*) filter (where activity ->> 'truncated' = 'true')::integer as "truncatedSessions"
      from scoped
    )
    select coverage.*,
      (select count(*) > ${maximumRows} from ranked) as limited,
      coalesce((
        select jsonb_agg(to_jsonb(top) || jsonb_build_object('latest', jsonb_build_object('id', latest.id, 'at', latest.started))
          order by top.calls desc, top.name asc)
        from top inner join latest on latest.name = top.name
      ), '[]'::jsonb) as rows
    from coverage
    where exists (select 1 from permitted)
  `);
  return result && workspaceActivityResponse.parse(result);
}
