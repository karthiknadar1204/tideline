import { intelligenceDateRanges } from "@tideline/contracts/session-intelligence";
import type { failureReasonGuidance, SessionIntelligence, SessionIntelligenceQuery } from "@tideline/contracts/session-intelligence";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentSessions, workspaces } from "./schema";
import { reportedSessionFriction } from "./session-frustration";
import { workspaceAccessibleTo } from "./workspaces";

const failurePatterns = {
  "Rate limit": String.raw`\m(rate[ -]limit(?:ed| exceeded)?|too many requests|(?:http(?:/[0-9.]+)?[[:space:]]+|status[ :=]+)429)\M`,
  Timeout: String.raw`\m(timed out|timeout (?:expired|exceeded)|deadline exceeded|etimedout)\M`,
  "Permission denied": String.raw`\m(permission denied|operation not permitted|eacces|eperm)\M`,
  "Authentication error": String.raw`\m(authentication failed|invalid (?:api key|credentials)|(?:http(?:/[0-9.]+)?[[:space:]]+|status[ :=]+)401|unauthorized)\M`,
  "Missing dependency": String.raw`\m(command not found|module not found|cannot find (?:module|package)|no module named)\M`,
  "Connection error": String.raw`\m(connection (?:refused|reset)|could not resolve host|econnrefused|enotfound|econnreset)\M`,
  "Failed checks": String.raw`\m((?:test suite|build|lint|type check) failed|[1-9][0-9]* (?:tests? )?failed)\M`,
} satisfies Record<keyof typeof failureReasonGuidance, string>;

const reasonCases = sql.join(Object.entries(failurePatterns).map(([label, expression]) => sql`
  when (left(payload.value ->> 'output', 4096) || ' ' || right(payload.value ->> 'output', 4096)) ~* ${expression} then ${label}::text`
), sql` `);

export async function readSessionIntelligence(
  db: Pick<PostgresJsDatabase, "execute">,
  { workspaceId, userId }: { workspaceId: string; userId: string },
  filters: SessionIntelligenceQuery,
) {
  const { current, prior } = intelligenceDateRanges(filters);
  const day = sql`left(${agentSessions.startedAt}, 10)`;
  const rows = await db.execute<{ result: SessionIntelligence }>(sql`
    with accessible as (
      select ${workspaces.id} as id from ${workspaces}
      where ${workspaces.id} = ${workspaceId} and (${workspaceAccessibleTo(userId)})
    ), scoped as (
      select ${agentSessions.id} as id, ${agentSessions.source} as source, ${day} as day,
        ${agentSessions.readyAnalytics} -> 'repository' ->> 'key' as repository_key,
        ${agentSessions.readyAnalytics} -> 'repository' ->> 'name' as repository_name
      from ${agentSessions} join accessible on accessible.id = ${agentSessions.workspaceId}
      where ${agentSessions.deletedAt} is null and ${agentSessions.readyMessageCount} > 0
        and ${day} between ${prior.from} and ${current.to}
    ), sessions as (
      select scoped.id, scoped.source, scoped.day >= ${current.from} as is_current,
        ${agentSessions.startedAt} as started_at, ${agentSessions.title} as title,
        ${agentSessions.readyActivity} as activity, ${agentSessions.readyCapture} as capture,
        ${agentSessions.messages} as messages, ${agentSessions.readyMessageCount} as ready_count
      from scoped join ${agentSessions} on ${agentSessions.id} = scoped.id
      where true
      ${filters.source ? sql`and scoped.source = ${filters.source}` : sql``}
      ${filters.repository ? sql`and scoped.repository_key = ${filters.repository}` : sql``}
    ), activity_failures as (
      select s.id, entry.kind, entry.value ->> 'line' as line, entry.value ->> 'index' as position,
        case entry.kind when 'tool' then concat_ws(' / ', entry.value ->> 'mcpServer', entry.value ->> 'name')
        when 'child' then coalesce(entry.value ->> 'name', 'Unnamed child agent')
        else entry.value ->> 'name' end as label
      from sessions s cross join lateral (
        select 'tool' as kind, value from jsonb_array_elements(s.activity -> 'tools')
        union all select 'skill', value from jsonb_array_elements(s.activity -> 'skills')
        union all select 'child', value from jsonb_array_elements(s.activity -> 'children')
      ) entry where entry.value ->> 'status' = 'failed'
    ), reasons as (
      select f.id, f.line, f.position, case ${reasonCases} end as label
      from activity_failures f join sessions s on s.id = f.id
      cross join lateral jsonb_array_elements(s.capture -> 'tools') as payload(value)
      where f.kind = 'tool' and payload.value ->> 'line' = f.line and payload.value ->> 'index' = f.position
        and payload.value ->> 'output' is not null
    ), signals as (
      select s.id, entry.value ->> 'line' as line, case entry.value ->> 'role'
        when 'user' then case when ${reportedSessionFriction(sql`entry.value`, "frustration")} then 'reported-frustration' end
        when 'assistant' then case when ${reportedSessionFriction(sql`entry.value`, "correction")} then 'agent-correction' end
      end as kind
      from sessions s cross join lateral jsonb_array_elements(s.messages) with ordinality as entry(value, position)
      where entry.position <= s.ready_count
    ), evidence as (
      select id, kind, label, concat(kind, '-', line, '-', position) as anchor,
        line::bigint as line, position::bigint as position from activity_failures
      union all select id, 'reason', label, concat('tool-', line, '-', position), line::bigint, position::bigint
        from reasons where label is not null
      union all select id, kind, case when kind = 'reported-frustration' then 'Reported frustration' else 'Agent corrected itself' end,
        concat('message-', line), line::bigint, 0 from signals where kind is not null
    ), affected as (
      select e.kind, e.label, s.id, s.source, s.title, s.is_current, s.started_at,
        count(*) as occurrences, (array_agg(e.anchor order by e.line, e.position))[1] as anchor
      from evidence e join sessions s on s.id = e.id
      group by e.kind, e.label, s.id, s.source, s.title, s.is_current, s.started_at
    ), totals as (
      select kind, label, count(*) filter (where is_current) as current_sessions,
        count(*) filter (where not is_current) as prior_sessions,
        coalesce(sum(occurrences) filter (where is_current), 0) as current_events,
        coalesce(sum(occurrences) filter (where not is_current), 0) as prior_events
      from affected group by kind, label
    ), ranked as (
      select *, row_number() over (partition by kind order by
        (current_sessions + prior_sessions >= 2) desc, current_sessions desc, prior_sessions desc, label) as rank
      from totals
    ), patterns as (
      select r.*, (
        select jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'source', e.source,
          'startedAt', e.started_at, 'anchor', e.anchor) order by e.is_current desc, e.started_at desc, e.id)
        from (select * from affected a where a.kind = r.kind and a.label = r.label
          order by row_number() over (partition by a.is_current order by a.started_at desc, a.id), a.is_current desc limit 3) e
      ) as examples from ranked r where r.rank <= 6
    ), coverage as (
      select s.is_current, count(*) as session_count, count(s.activity) as activity_count,
        count(*) filter (where s.activity is null or s.activity ->> 'truncated' = 'true') as incomplete_count,
        count(*) filter (where exists (select 1 from jsonb_array_elements(s.capture -> 'tools') as t(value)
          where t.value ->> 'output' <> '')) as output_count
      from sessions s group by s.is_current
    )
    select jsonb_build_object(
      'current', (select jsonb_build_object('sessions', coalesce(session_count, 0),
        'activitySessions', coalesce(activity_count, 0), 'incompleteActivitySessions', coalesce(incomplete_count, 0),
        'capturedOutputSessions', coalesce(output_count, 0)) from (values (true)) p(current) left join coverage c on c.is_current = p.current),
      'prior', (select jsonb_build_object('sessions', coalesce(session_count, 0),
        'activitySessions', coalesce(activity_count, 0), 'incompleteActivitySessions', coalesce(incomplete_count, 0),
        'capturedOutputSessions', coalesce(output_count, 0)) from (values (false)) p(current) left join coverage c on c.is_current = p.current),
      'repositories', coalesce((select jsonb_agg(jsonb_build_object('key', repository_key, 'name', name) order by lower(name), repository_key)
        from (select repository_key, max(repository_name) as name from scoped where repository_key is not null group by repository_key) repos), '[]'::jsonb),
      'patterns', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'label', label,
        'currentSessions', current_sessions, 'priorSessions', prior_sessions, 'currentEvents', current_events,
        'priorEvents', prior_events, 'examples', examples) order by rank, kind) from patterns), '[]'::jsonb)
    ) as result from accessible
  `);
  return rows[0]?.result;
}
