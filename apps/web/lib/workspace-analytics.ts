import type { SessionSummary, WorkspaceSessionSearchQuery } from "@tideline/contracts";
import { buildWorkspaceReport, readReportFilters, reportFilterParams } from "./reports";
import { sessionListHref } from "./session-filters";
import { formatCost, formatCount, summarizeWorkspace } from "./usage";

export const analyticsMetrics = {
  sessions: "Sessions",
  cost: "Estimated cost",
  tokens: "Reported tokens",
  tools: "Tool calls",
  children: "Child agent runs",
} as const;

export type AnalyticsMetric = keyof typeof analyticsMetrics;
export type AnalyticsFilters = ReturnType<typeof readReportFilters>;
type TimelineEntry = ReturnType<typeof buildWorkspaceReport>["timeline"][number];
type MetricValue = { value: number | null; complete: boolean };

const metricOrder: AnalyticsMetric[] = ["sessions", "cost", "tokens", "tools", "children"];

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
  }
}

export function formatAnalyticsMetric(metric: AnalyticsMetric, value: number) {
  return metric === "cost" ? formatCost(value) : formatCount(value);
}

export function buildWorkspaceAnalytics(allSessions: SessionSummary[], filters: AnalyticsFilters) {
  const report = buildWorkspaceReport(allSessions, filters);
  const usage = summarizeWorkspace(report.sessions);
  const metrics = metricOrder.map((id) => {
    if (id === "cost" || id === "tokens") return { id, ...usage.total[id] };
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

export function analyticsHref(path: string, filters: AnalyticsFilters, options: { metric?: AnalyticsMetric; view?: "sessions" } = {}) {
  const query = new URLSearchParams(reportFilterParams(filters));
  if (options.metric && options.metric !== "sessions") query.set("metric", options.metric);
  if (options.view) query.set("view", options.view);
  return `${path}?${query}`;
}

export function analyticsSessionsHref(workspaceId: string, filters: AnalyticsFilters, firstDay?: string, options: {
  repository?: string;
  model?: string;
  period?: string;
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
    from,
    to,
  };
  return sessionListHref(workspaceId, scope);
}
