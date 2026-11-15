import type { SessionSummary } from "@tideline/contracts";
import { sessionSourceLabel } from "@tideline/contracts";
import Link from "next/link";
import { readReportFilters } from "../../../../lib/reports";
import { formatCount } from "../../../../lib/usage";
import { analyticsHref, analyticsSessionsHref, buildWorkspaceAnalytics, readAnalyticsMetric } from "../../../../lib/workspace-analytics";
import { listWorkspaceInsightSessions } from "../../../../lib/workspace";
import { AnalyticsControls } from "../dashboard/analytics-controls";
import { AnalyticsSeries, UsageTable } from "../dashboard/analytics";
import styles from "../dashboard/analytics.module.css";
import { readRepositoryFilesParams, RepositoryFiles, RepositoryInstructions } from "./evidence";

const recentLimit = 20;
const sessionDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

function RepositorySessions({ path, sessions, listHref }: {
  path: string;
  sessions: SessionSummary[];
  listHref: string;
}) {
  const query = listHref.slice(path.length);
  const recent = [...sessions].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, recentLimit);
  return (
    <section aria-labelledby="repository-sessions" className={styles.repoList}>
      <div className={styles.sectionHeading}>
        <h2 id="repository-sessions">Sessions</h2>
        {sessions.length > 0 && <Link href={listHref}>Open in Sessions <span aria-hidden>→</span></Link>}
      </div>
      {recent.length ? (
        <ul>
          {recent.map((session) => (
            <li key={session.id}>
              <Link href={`${path}/sessions/${session.id}${query}`}>
                <span>{session.title}<small>{sessionSourceLabel[session.source]} · {sessionDate.format(new Date(session.startedAt))}</small></span>
                <span aria-hidden>→</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className={styles.emptyTable}>No sessions during this period.</p>}
    </section>
  );
}

export default async function RepositoriesPage({ params, searchParams }: PageProps<"/workspace/[id]/repositories">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const workspace = `/workspace/${encodeURIComponent(id)}`;
  const path = `${workspace}/repositories`;
  const now = new Date();
  const filters = readReportFilters(query, now);
  const metric = readAnalyticsMetric(query.metric);
  const view = query.view === "sessions" || query.view === "files" || query.view === "instructions" ? query.view : undefined;
  const sessions = await listWorkspaceInsightSessions(id);
  const report = buildWorkspaceAnalytics(sessions, filters);
  const repository = sessions.find(({ analytics }) => analytics?.repository?.key === filters.repository)?.analytics?.repository;
  const today = now.toISOString().slice(0, 10);
  const controlsKey = analyticsHref(path, filters, { view });

  if (!filters.repository || !repository) {
    const repositories = report.repositories.filter(({ key }) => key !== null);
    return (
      <main className={styles.page}>
        <header className={styles.header}>
          <div>
            <h1>Repositories</h1>
            <p>{formatCount(repositories.length)} with synced sessions</p>
          </div>
          <AnalyticsControls key={controlsKey} path={path} filters={filters} metric={metric} today={today} />
        </header>
        {filters.repository && (
          <p className={styles.emptyTable}>This repository is unavailable. <Link href={path}>Browse all repositories</Link>.</p>
        )}
        <UsageTable title="Repository activity" rows={repositories}
          hrefFor={({ key }) => key ? analyticsHref(path, { ...filters, repository: key }, { metric }) : undefined} />
      </main>
    );
  }

  const listHref = analyticsSessionsHref(id, filters, report.firstDay);
  return (
    <main className={styles.page}>
      <Link className={styles.back} href={analyticsHref(path, { ...filters, repository: undefined }, { metric })}>← Repositories</Link>
      <header className={styles.header}>
        <h1>{repository.name}</h1>
        {view !== "instructions" && <AnalyticsControls key={controlsKey} path={path} filters={filters} metric={metric} today={today} view={view} />}
      </header>
      <nav className={styles.tabs} aria-label="Repository views">
        <Link href={analyticsHref(path, filters, { metric })} aria-current={view ? undefined : "page"}>Overview</Link>
        <Link href={analyticsHref(path, filters, { metric, view: "sessions" })} aria-current={view === "sessions" ? "page" : undefined}>Sessions</Link>
        <Link href={analyticsHref(path, filters, { metric, view: "files" })} aria-current={view === "files" ? "page" : undefined}>Files</Link>
        <Link href={analyticsHref(path, filters, { metric, view: "instructions" })} aria-current={view === "instructions" ? "page" : undefined}>Context</Link>
        <Link href={analyticsHref(`${workspace}/skills`, filters)}>Skills</Link>
        <Link href={analyticsHref(`${workspace}/mcp`, filters)}>MCP</Link>
        <Link href={analyticsHref(`${workspace}/reports/github`, { ...filters, source: undefined })}>GitHub</Link>
      </nav>
      {!view && (
        <>
          <AnalyticsSeries path={path} workspaceId={id} metric={metric} filters={filters} report={report} />
          <UsageTable title="Models" rows={report.models}
            hrefFor={({ key }) => key ? analyticsSessionsHref(id, filters, report.firstDay, { model: key }) : undefined} />
        </>
      )}
      {view === "files" ? (
        <RepositoryFiles workspaceId={id} repository={repository.key} href={analyticsHref(path, filters, { metric, view })}
          filters={readRepositoryFilesParams(query, { from: report.firstDay, to: filters.through, source: filters.source })} />
      ) : view === "instructions" ? (
        <RepositoryInstructions workspaceId={id} repository={repository.key} />
      ) : <RepositorySessions path={workspace} sessions={report.sessions} listHref={listHref} />}
    </main>
  );
}
