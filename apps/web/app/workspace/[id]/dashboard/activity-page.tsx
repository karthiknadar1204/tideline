import { workspaceActivityResponse } from "@tideline/contracts";
import type { WorkspaceActivityKind } from "@tideline/contracts";
import Link from "next/link";
import { buildWorkspaceReport, readReportFilters } from "../../../../lib/reports";
import { formatCount } from "../../../../lib/usage";
import { analyticsHref, analyticsSessionsHref } from "../../../../lib/workspace-analytics";
import { fetchWorkspaceResource } from "../../../../lib/workspace";
import { AnalyticsControls } from "./analytics-controls";
import styles from "./analytics.module.css";

const dateLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const copy = {
  skills: { title: "Skills", noun: "Skill", count: "Events", empty: "No skill events were recorded in this period." },
  mcp: { title: "MCP", noun: "Server", count: "Calls", empty: "No MCP server calls were identified in this period." },
} as const;

export async function ActivityPage({ workspaceId, kind, query }: {
  workspaceId: string;
  kind: WorkspaceActivityKind;
  query: Record<string, string | string[] | undefined>;
}) {
  const workspace = `/workspace/${encodeURIComponent(workspaceId)}`;
  const path = `${workspace}/${kind}`;
  const now = new Date();
  const filters = readReportFilters(query, now);
  const { firstDay } = buildWorkspaceReport([], filters);
  const queryParams = new URLSearchParams({ to: filters.through });
  if (firstDay) queryParams.set("from", firstDay);
  if (filters.source) queryParams.set("source", filters.source);
  if (filters.repository) queryParams.set("repository", filters.repository);

  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/activity/${kind}?${queryParams}`);
  if (!response?.ok) throw new Error(`Could not open workspace ${kind} activity.`);
  const report = workspaceActivityResponse.parse(await response.json());
  const { title, noun, count, empty } = copy[kind];
  const sessionQuery = analyticsSessionsHref(workspaceId, filters, firstDay).slice(workspace.length);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>{title}</h1>
          <p>{kind === "skills" ? "Skills observed in synced coding sessions." : "Servers called by your coding agents."}</p>
        </div>
        <AnalyticsControls key={analyticsHref(path, filters)} path={path} filters={filters} today={now.toISOString().slice(0, 10)} />
      </header>

      <section className={styles.tablePanel} aria-labelledby="workspace-activity-title">
        <div className={styles.sectionHeading}>
          <h2 id="workspace-activity-title">{kind === "skills" ? "Recorded skills" : "MCP server activity"}</h2>
          {kind === "mcp" && <Link href={`${workspace}/settings/integrations`}>Connect Tideline MCP <span aria-hidden>→</span></Link>}
        </div>
        {report.rows.length > 0 ? (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead><tr><th scope="col">{noun}</th><th scope="col">{count}</th><th scope="col">Failures</th><th scope="col">Sessions</th><th scope="col">Latest session</th></tr></thead>
              <tbody>
                {report.rows.map(({ name, calls, failed, sessions, latest }) => (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    <td>{formatCount(calls)}</td>
                    <td>{formatCount(failed)}</td>
                    <td>{formatCount(sessions)}</td>
                    <td><Link href={`${workspace}/sessions/${latest.id}${sessionQuery}`} aria-label={`Open the latest session with ${name}`}>{dateLabel.format(new Date(latest.at))} <span aria-hidden>→</span></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.missing}>
            <p>{report.coveredSessions === 0 ? "No sessions reported activity during this period." : empty}</p>
            {filters.days !== "all" && <Link href={analyticsHref(path, { ...filters, days: "all" })}>Show all time</Link>}
          </div>
        )}
        {report.sessionCount > 0 && (
          <p className={styles.emptyTable}>
            Activity recorded for {formatCount(report.coveredSessions)} of {formatCount(report.sessionCount)} sessions.
            {report.truncatedSessions > 0 && ` ${formatCount(report.truncatedSessions)} reached the activity limit.`}
            {report.limited && " Showing the top 100 by recorded activity."}
          </p>
        )}
      </section>
    </main>
  );
}
