import { MAX_INVENTORY_REPOSITORIES, repositorySyncResponse, syncCoverageResponse } from "@tideline/contracts";
import type { SyncInventoryUpload } from "@tideline/contracts";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentSessions, syncGrants, syncInventories, workspaces } from "./schema";
import { workspaceAccessibleTo } from "./workspaces";

function inventoryScope(workspaceId: string, userId: string) {
  return sql`with permitted as (
      select id from ${workspaces}
      where id = ${workspaceId} and ${workspaceAccessibleTo(userId)}
    ), reports as (
      select ${syncInventories.report} as report, ${syncInventories.updatedAt} as updated
      from ${syncInventories}
      inner join permitted on permitted.id = ${syncInventories.workspaceId}
      inner join ${syncGrants} on ${syncGrants.tokenHash} = ${syncInventories.grantHash}
      where ${syncGrants.revokedAt} is null and ${syncGrants.expiresAt} > clock_timestamp()
        and ${syncInventories.updatedAt} > clock_timestamp() - interval '90 days'
    )`;
}

export async function readSyncCoverage(db: PostgresJsDatabase, workspaceId: string, userId: string) {
  const [result] = await db.execute(sql`
    ${inventoryScope(workspaceId, userId)}, observed as (
      select distinct entry.value->>'source' as source, entry.value->>'id' as source_id
      from reports cross join lateral jsonb_array_elements(report->'sessions') as entry(value)
    ), coverage as (
      select count(*)::int as known,
        (count(*) filter (where ${agentSessions.readyMessageCount} > 0))::int as ready,
        (count(*) filter (where ${agentSessions.id} is not null and ${agentSessions.readyMessageCount} = 0))::int as pending
      from observed
      left join ${agentSessions} on ${agentSessions.workspaceId} = ${workspaceId}
        and ${agentSessions.source} = observed.source::session_source and ${agentSessions.sourceSessionId} = observed.source_id::uuid
      where ${agentSessions.deletedAt} is null
    )
    select (select count(*)::int from reports) as collectors,
      (select max(updated) from reports) as "reportedAt",
      coalesce((select bool_or((report->>'partial')::boolean) from reports), false) as partial,
      coverage.* from coverage where exists(select 1 from permitted)
  `);
  if (!result) return null;
  const { reportedAt, ...counts } = result;
  return syncCoverageResponse.parse({ ...counts, reportedAt: reportedAt ? new Date(String(reportedAt)).toISOString() : null });
}

export async function readRepositorySyncStatus(db: PostgresJsDatabase, workspaceId: string, userId: string, query?: string) {
  const [result] = await db.execute(sql`
    ${inventoryScope(workspaceId, userId)}, selections as (
      select entry.value->>'key' as key, max(entry.value->>'name') as name,
        bool_or((entry.value->>'enabled')::boolean) as enabled
      from reports cross join lateral jsonb_array_elements(report->'repositorySettings'->'rows') as entry(value)
      group by entry.value->>'key'
    ), uploaded as (
      select ${agentSessions.readyAnalytics}->'repository'->>'key' as key,
        max(${agentSessions.readyAnalytics}->'repository'->>'name') as name, count(*)::int as sessions
      from ${agentSessions} inner join permitted on permitted.id = ${agentSessions.workspaceId}
      where ${agentSessions.readyMessageCount} > 0 and ${agentSessions.readyAnalytics}->'repository'->>'key' is not null
      group by ${agentSessions.readyAnalytics}->'repository'->>'key'
    ), repositories as (
      select coalesce(uploaded.key, selections.key) as key, coalesce(uploaded.name, selections.name) as name,
        coalesce(uploaded.sessions, 0) as sessions,
        case when selections.enabled then 'enabled' when selections.enabled is false then 'paused' else 'unreported' end as state
      from uploaded full join selections on uploaded.key = selections.key
    ), visible as (
      select * from repositories
      where ${query ? sql`strpos(lower(name), lower(${query})) > 0` : sql`true`}
      order by sessions desc, name, key limit 100
    ) select coalesce(jsonb_agg(visible order by sessions desc, name, key), '[]'::jsonb) as repositories
      from visible having exists (select 1 from permitted)
  `);
  return result ? repositorySyncResponse.parse(result.repositories) : null;
}

export function mergeRepositorySettings(current: SyncInventoryUpload, previous?: SyncInventoryUpload): SyncInventoryUpload {
  const reported = current.repositorySettings;
  const earlier = previous?.repositorySettings;
  if (!earlier) return current;
  if (!reported) return { ...current, repositorySettings: earlier };

  const rows = new Map(reported.rows.map((row) => [row.key, row]));
  for (const row of earlier.rows) {
    if (rows.size === MAX_INVENTORY_REPOSITORIES) break;
    if (!rows.has(row.key)) rows.set(row.key, { ...row, enabled: !reported.complete && row.enabled });
  }
  return { ...current, repositorySettings: { ...reported, rows: [...rows.values()] } };
}
