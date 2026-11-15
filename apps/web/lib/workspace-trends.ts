import { shiftDay, utcDay, workspaceTrendsSessions } from "@tideline/contracts";
import type { WorkspaceTrendsSession } from "@tideline/contracts";
import { intelligencePeriods } from "@tideline/contracts/session-intelligence";
import { buildWorkspaceReport, readReportFilters } from "./reports";
import { summarizeSession, summarizeWorkspace } from "./usage";
import { fetchWorkspaceResource } from "./workspace";

export const trendPeriods = intelligencePeriods;

export function readTrendFilters(query: Parameters<typeof readReportFilters>[0], now = new Date()) {
  const latest = shiftDay(utcDay(now), -1);
  const filters = readReportFilters(query, new Date(latest));
  const days = trendPeriods.find((days) => days === filters.days) ?? 30;
  const through = filters.through < shiftDay("0001-01-01", days * 2 - 1) ? latest : filters.through;
  return { ...filters, days, through, latest };
}

export async function readWorkspaceTrends(workspaceId: string, filters: ReturnType<typeof readTrendFilters>) {
  const priorEnd = shiftDay(filters.through, -filters.days);
  const priorStart = shiftDay(priorEnd, 1 - filters.days);
  const dates = new URLSearchParams({ from: priorStart, to: filters.through });
  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/trends?${dates}`);
  if (!response?.ok) throw new Error("Could not open workspace trends.");
  const rows = workspaceTrendsSessions.parse(await response.json());
  const current = buildWorkspaceReport(rows, filters);
  const prior = buildWorkspaceReport(rows, { ...filters, through: priorEnd });

  function summarize(sessions: WorkspaceTrendsSession[]) {
    return {
      sessions: sessions.length,
      failures: sessions.filter(({ recordedToolFailure }) => recordedToolFailure).length,
      frustration: sessions.filter(({ reportedFrustration }) => reportedFrustration).length,
      incomplete: sessions.filter(({ activityCounts }) => !activityCounts || activityCounts.truncated).length,
      ...summarizeWorkspace(sessions),
    };
  }

  const longest = current.sessions.reduce<WorkspaceTrendsSession | undefined>(
    (biggest, session) => !biggest || session.messageCount > biggest.messageCount ? session : biggest, undefined,
  );
  const largestEstimate = current.sessions.reduce<{ value: number; session: WorkspaceTrendsSession } | undefined>((biggest, session) => {
    const { value } = summarizeSession(session.analytics).cost;
    return value !== null && value > (biggest?.value ?? 0) ? { value, session } : biggest;
  }, undefined);
  return {
    observed: summarize(current.sessions),
    earlier: summarize(prior.sessions),
    timeline: current.timeline,
    previousTimeline: prior.timeline,
    repositories: current.repositories,
    dates: { from: shiftDay(filters.through, 1 - filters.days), to: filters.through },
    priorDates: { from: priorStart, to: priorEnd },
    longest,
    largestEstimate,
  };
}
