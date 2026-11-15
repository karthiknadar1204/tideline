import type { WorkspaceInsightSessionSummary, WorkspaceSessionSearchQuery } from "@tideline/contracts";
import { buildWorkspaceReport, readReportFilters, reportFilterParams } from "./reports";
import { sessionListHref } from "./session-filters";
import { combineUsage, formatCost, formatCount, summarizeSession, summarizeWorkspace } from "./usage";

export const analyticsMetrics = {
  sessions: "Sessions",
  cost: "Estimated cost",
  tokens: "Reported tokens",
  tools: "Tool calls",
  children: "Child agent runs",
  frustration: "Reported frustration",
} as const;

export type AnalyticsMetric = keyof typeof analyticsMetrics;
export type AnalyticsFilters = ReturnType<typeof readReportFilters>;
export type RepositoryView = "sessions" | "files" | "instructions";
type TimelineEntry = ReturnType<typeof buildWorkspaceReport>["timeline"][number];
type MetricValue = { value: number | null; complete: boolean };

const metricOrder: AnalyticsMetric[] = ["sessions", "cost", "tokens", "tools", "children", "frustration"];
const fraction = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

export function readAnalyticsMetric(value: string | string[] | undefined): AnalyticsMetric {
  return metricOrder.find((metric) => metric === value) ?? "sessions";
}

function observedActivity({ sessions, activity }: TimelineEntry, key: "toolCalls" | "childRuns"): MetricValue {
  return {
    value: sessions === 0 || activity.coveredSessions ? activity[key] : null,
    complete: activity.coveredSessions === sessions && !activity.truncated,
  };
}

export function timelineMetric(entry: TimelineEntry, metric: AnalyticsMetric): MetricValue {
  switch (metric) {
    case "sessions": return { value: entry.sessions, complete: true };
    case "cost": return entry.sessions ? entry.usage.cost : { value: 0, complete: true };
    case "tokens": return entry.sessions ? entry.usage.tokens : { value: 0, complete: true };
    case "tools": return observedActivity(entry, "toolCalls");
    case "children": return observedActivity(entry, "childRuns");
    case "frustration": return frustrationRate(entry.reportedFrustration, entry.sessions);
  }
}

export function formatAnalyticsMetric(metric: AnalyticsMetric, value: number) {
  if (metric === "cost") return formatCost(value);
  if (metric === "frustration") return fraction.format(value);
  return formatCount(value);
}

function frustrationRate(reported: number, total: number): MetricValue {
  return { value: total ? reported / total : null, complete: true };
}

export function buildWorkspaceAnalytics(allSessions: WorkspaceInsightSessionSummary[], filters: AnalyticsFilters) {
  const report = buildWorkspaceReport(allSessions, filters);
  const usage = summarizeWorkspace(report.sessions);
  const metrics = metricOrder.map((id) => {
    if (id === "cost" || id === "tokens") return { id, ...usage.total[id] };
    if (id === "frustration") {
      const reported = report.timeline.reduce((count, period) => count + period.reportedFrustration, 0);
      return { id, ...frustrationRate(reported, report.sessions.length) };
    }
    const points = report.timeline.filter((entry) => entry.sessions > 0).map((entry) => timelineMetric(entry, id));
    const available = points.flatMap(({ value }) => value === null ? [] : [value]);
    return {
      id,
      value: id === "sessions" ? report.sessions.length : available.length ? available.reduce((a, b) => a + b, 0) : null,
      complete: points.every(({ complete }) => complete),
    };
  });
  return { ...report, ...usage, metrics };
}

export function summarizeMemberMetric(sessions: WorkspaceInsightSessionSummary[], labels: ReadonlyMap<string, string>, metric: AnalyticsMetric) {
  const groups = new Map<string, {
    name: string;
    memberId?: string;
    sessions: WorkspaceInsightSessionSummary[];
  }>();
  for (const session of sessions) {
    const member = session.member;
    const label = member.kind === "active" ? labels.get(member.id) : undefined;
    const id = member.kind === "active" && label ? member.id : undefined;
    const key = id ? `member:${id}` : member.kind === "former" ? "former" : "unknown";
    const existing = groups.get(key);
    if (existing) existing.sessions.push(session);
    else groups.set(key, {
      name: label ?? (member.kind === "former" ? "Former members" : "Unknown uploader"),
      memberId: id,
      sessions: [session],
    });
  }

  function total(group: WorkspaceInsightSessionSummary[]): MetricValue {
    if (metric === "sessions") return { value: group.length, complete: true };
    if (metric === "frustration") {
      return frustrationRate(group.filter(({ reportedFrustration }) => reportedFrustration).length, group.length);
    }
    if (metric === "cost" || metric === "tokens") {
      return combineUsage(group.map(({ analytics }) => summarizeSession(analytics)))[metric];
    }
    const key = metric === "tools" ? "tools" : "children";
    let value: number | null = null;
    let complete = true;
    for (const { activityCounts } of group) {
      if (activityCounts) value = (value ?? 0) + activityCounts[key];
      complete &&= activityCounts !== null && !activityCounts.truncated;
    }
    return { value, complete };
  }

  return Array.from(groups, ([key, group]) => ({
    key, name: group.name, memberId: group.memberId, ...total(group.sessions),
  })).sort((first, second) => (second.value ?? -1) - (first.value ?? -1) || first.name.localeCompare(second.name));
}

export function analyticsHref(path: string, filters: AnalyticsFilters, options: { metric?: AnalyticsMetric; view?: RepositoryView } = {}) {
  const query = new URLSearchParams(reportFilterParams(filters));
  if (options.metric && options.metric !== "sessions") query.set("metric", options.metric);
  if (options.view) query.set("view", options.view);
  return `${path}?${query}`;
}

export function analyticsSessionsHref(workspaceId: string, filters: AnalyticsFilters, firstDay?: string, options: {
  repository?: string;
  model?: string;
  period?: string;
  member?: string;
  metric?: AnalyticsMetric;
} = {}) {
  let from = firstDay;
  let to = filters.through;
  if (options.period) {
    if (options.period.length === 10) {
      from = options.period;
      to = options.period;
    } else {
      from = `${options.period}-01`;
      const end = new Date(from);
      end.setUTCMonth(end.getUTCMonth() + 1, 0);
      const monthEnd = end.toISOString().slice(0, 10);
      if (monthEnd < to) to = monthEnd;
    }
  }
  const scope: WorkspaceSessionSearchQuery = {
    page: 1,
    source: filters.source,
    repository: options.repository ?? filters.repository,
    model: options.model,
    ...(options.member ? { member: options.member } : {}),
    frustration: options.metric === "frustration" ? "reported" : undefined,
    from,
    to,
  };
  return sessionListHref(workspaceId, scope);
}
