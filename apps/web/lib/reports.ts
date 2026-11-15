import { readDay, sessionSource, shiftDay, utcDay } from "@tideline/contracts";
import type { SessionSource, SessionSummary } from "@tideline/contracts";
import { combineUsage, summarizeSession } from "./usage";
import type { Usage } from "./usage";

export const reportPeriods = [1, 7, 30, 90, "all"] as const;

type ReportParams = Record<string, string | string[] | undefined>;

type ReportFilters = {
  days: (typeof reportPeriods)[number];
  through: string;
  source?: SessionSource;
  repository?: string;
};

type PeriodUsage = {
  period: string;
  sessions: number;
  reportedFrustration: number;
  usage: Usage;
  activity: {
    coveredSessions: number;
    toolCalls: number;
    skills: number;
    childRuns: number;
    truncated: boolean;
  };
};

type ReportSession = SessionSummary & { reportedFrustration?: boolean };

export function readReportFilters(params: ReportParams | URLSearchParams, now = new Date()): ReportFilters {
  function read(key: string) {
    if (params instanceof URLSearchParams) return params.getAll(key).length === 1 ? params.get(key) ?? undefined : undefined;
    return params[key];
  }
  const today = utcDay(now);
  const period = read("days");
  const through = readDay(read("through"));
  const repository = read("repository");
  return {
    days: reportPeriods.find((days) => String(days) === period) ?? 30,
    through: through && through <= today && through >= "0001-01-01" ? through : today,
    source: sessionSource.safeParse(read("source")).data,
    repository: typeof repository === "string" && /^[0-9a-f]{64}$/.test(repository) ? repository : undefined,
  };
}

export function reportFilterParams({ days, through, source, repository }: ReportFilters) {
  const params = new URLSearchParams({ days: String(days), through });
  if (source) params.set("source", source);
  if (repository) params.set("repository", repository);
  return params.toString();
}

function summarizePeriod(period: string, sessions: ReportSession[]): PeriodUsage {
  const activity: PeriodUsage["activity"] = { coveredSessions: 0, toolCalls: 0, skills: 0, childRuns: 0, truncated: false };
  let reportedFrustration = 0;
  for (const { activityCounts, reportedFrustration: reported } of sessions) {
    if (reported) reportedFrustration++;
    if (!activityCounts) continue;
    activity.coveredSessions++;
    activity.toolCalls += activityCounts.tools;
    activity.skills += activityCounts.skills;
    activity.childRuns += activityCounts.children;
    activity.truncated ||= activityCounts.truncated;
  }
  return { period, sessions: sessions.length, reportedFrustration, usage: combineUsage(sessions.map(({ analytics }) => summarizeSession(analytics))), activity };
}

export function buildWorkspaceReport<Session extends ReportSession>(allSessions: Session[], filters: ReportFilters) {
  const firstDay = filters.days === "all" ? undefined : shiftDay(filters.through, 1 - filters.days);
  const granularity = firstDay ? "day" : "month";
  const byPeriod = new Map<string, Session[]>();
  const repositories = new Map<string, string>();
  const sessions = allSessions.filter((session) => {
    const repository = session.analytics?.repository;
    if (repository) repositories.set(repository.key, repository.name);
    const day = session.startedAt.slice(0, 10);
    if ((firstDay && day < firstDay) || day > filters.through || (filters.source && session.source !== filters.source) ||
        (filters.repository && repository?.key !== filters.repository)) return false;
    const period = granularity === "day" ? day : day.slice(0, 7);
    const bucket = byPeriod.get(period) ?? [];
    bucket.push(session);
    byPeriod.set(period, bucket);
    return true;
  });
  const periods = firstDay && filters.days !== "all"
    ? Array.from({ length: filters.days }, (_, offset) => shiftDay(firstDay, offset))
    : Array.from(byPeriod.keys()).sort();
  return {
    sessions,
    timeline: periods.map((period) => summarizePeriod(period, byPeriod.get(period) ?? [])),
    granularity,
    firstDay,
    repositories: [...repositories].map(([key, name]) => ({ key, name }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key)),
  };
}

function csvCell(value: string | number | null) {
  if (value === null) return "";
  const text = typeof value === "string" && /^[\s\uFEFF]*[=+\-@]/u.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function coverage(metric: Usage["tokens"]) {
  if (metric.value === null) return "unavailable";
  return metric.complete ? "complete" : "partial";
}

export function reportCsv({ timeline, granularity }: Pick<ReturnType<typeof buildWorkspaceReport>, "timeline" | "granularity">) {
  const header = [
    granularity === "day" ? "date_utc" : "month_utc", "sessions", "reported_tokens", "token_coverage", "estimated_cost_usd", "cost_coverage",
    "sessions_with_activity", "tool_calls", "skill_events", "child_agent_runs", "activity_truncated",
  ];
  const rows = timeline.map(({ period, sessions, usage, activity }) => [
    period, sessions, usage.tokens.value, coverage(usage.tokens), usage.cost.value, coverage(usage.cost),
    activity.coveredSessions, activity.coveredSessions ? activity.toolCalls : null,
    activity.coveredSessions ? activity.skills : null, activity.coveredSessions ? activity.childRuns : null,
    activity.coveredSessions ? String(activity.truncated) : null,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
