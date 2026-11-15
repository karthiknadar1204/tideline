import { modelTokens, standardSessionRates, workspaceSessionSearchQuery } from "@tideline/contracts";
import type { WorkspaceSessionSearchQuery } from "@tideline/contracts";
import { and, between, eq, gte, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { agentSessions, workspaceMembers, workspaces } from "./schema";
import { sessionReportedFrustration } from "./session-frustration";

const modelRates = JSON.stringify(standardSessionRates);
const tokenFields = modelTokens.keyof().options;
const pricedTokenFields = ["input", "cachedInput", "output", "cacheWrite5m", "cacheWrite1h"] as const;

export const sessionModels = sql`jsonb_array_elements(${agentSessions.readyAnalytics} -> 'models')`;

export function sessionActivityRows(kind: "tools" | "skills" | "children") {
  return sql`jsonb_array_elements(${agentSessions.readyActivity} -> ${kind}::text)`;
}

function withinRange(metric: () => SQL, min: number | undefined, max: number | undefined) {
  if (min === undefined) return max === undefined ? undefined : lte(metric(), max);
  return max === undefined ? gte(metric(), min) : between(metric(), min, max);
}

function tokenTotal() {
  const tokens = sql.join(tokenFields.map((field) => sql`(usage.value -> 'tokens' ->> ${field}::text)::numeric`), sql` + `);
  return sql`(select sum(${tokens}) from ${sessionModels} as usage(value))`;
}

function estimatedCost() {
  const cost = sql.join(pricedTokenFields.map((field) => sql`(priced.tokens ->> ${field}::text)::numeric
    * coalesce((priced.rates ->> ${field}::text)::numeric, 0)`), sql` + `);
  return sql`(
    select sum((${cost}) / 1000000)
    from ${sessionModels} as usage(value)
    cross join lateral (
      select usage.value -> 'tokens' as tokens,
        ${modelRates}::jsonb -> ${agentSessions.source}::text -> (usage.value ->> 'model') as rates
    ) as priced
    where priced.rates is not null and (priced.tokens ->> 'cacheWriteUnknown')::numeric = 0
      and ((priced.tokens ->> 'cacheWrite5m')::numeric = 0 or priced.rates ? 'cacheWrite5m')
      and ((priced.tokens ->> 'cacheWrite1h')::numeric = 0 or priced.rates ? 'cacheWrite1h')
  )`;
}

function durationMinutes() {
  const recordedEnd = sql`(${agentSessions.messages} -> (${agentSessions.readyMessageCount} - 1) ->> 'timestamp')::timestamptz`;
  return sql`greatest(0, extract(epoch from (${recordedEnd} - ${agentSessions.startedAt}::timestamptz)) / 60)`;
}

function matchingSessionId(id: string) {
  return or(eq(agentSessions.id, id), eq(agentSessions.sourceSessionId, id));
}

function searchText(query: string) {
  const id = workspaceSessionSearchQuery.shape.sessionId.safeParse(query).data;
  return or(
    id === undefined ? undefined : matchingSessionId(id),
    sql`strpos(lower(${agentSessions.title}), lower(${query})) > 0`,
    sql`exists (
      select 1 from jsonb_array_elements(${agentSessions.messages}) with ordinality as entry(message, position)
      where entry.position <= ${agentSessions.readyMessageCount}
        and entry.message ->> 'role' in ('user', 'assistant')
        and strpos(lower(entry.message ->> 'text'), lower(${query})) > 0
    )`,
  );
}

export const recordedToolFailure = sql<boolean>`exists (
  select 1 from ${sessionActivityRows("tools")} as tool(value) where tool.value ->> 'status' = 'failed'
)`;

export function advancedSessionSearch(filters: WorkspaceSessionSearchQuery) {
  return and(
    filters.sessionId === undefined ? undefined : matchingSessionId(filters.sessionId),
    filters.query === undefined ? undefined : searchText(filters.query),
    filters.member === undefined ? undefined : and(eq(agentSessions.uploadedBy, filters.member), sql`exists (
      select 1 from ${workspaces} where ${workspaces.id} = ${agentSessions.workspaceId} and ${workspaces.kind} = 'team'
        and (${workspaces.ownerId} = ${filters.member} or exists (
          select 1 from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${workspaces.id}
            and ${workspaceMembers.userId} = ${filters.member} and ${workspaceMembers.removedAt} is null
        ))
    )`),
    filters.skill === undefined ? undefined : sql`exists (
      select 1 from ${sessionActivityRows("skills")} as skill(value) where skill.value ->> 'name' = ${filters.skill}
    )`,
    filters.subagent === undefined ? undefined : sql`exists (
      select 1 from ${sessionActivityRows("children")} as child(value) where child.value ->> 'name' = ${filters.subagent}
    )`,
    filters.failedTools === undefined ? undefined : filters.failedTools === "yes" ? recordedToolFailure :
      sql`${agentSessions.readyActivity} is not null and
        not coalesce((${agentSessions.readyActivity} ->> 'truncated')::boolean, false) and not (${recordedToolFailure})`,
    filters.frustration === "reported" ? sessionReportedFrustration : undefined,
    withinRange(estimatedCost, filters.minCost, filters.maxCost),
    withinRange(tokenTotal, filters.minTokens, filters.maxTokens),
    withinRange(durationMinutes, filters.minDurationMinutes, filters.maxDurationMinutes),
    withinRange(() => sql`${agentSessions.readyMessageCount}`, filters.minMessages, filters.maxMessages),
  );
}
