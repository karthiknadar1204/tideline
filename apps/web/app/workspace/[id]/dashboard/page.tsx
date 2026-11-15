import { auth } from "@clerk/nextjs/server";
import { readReportFilters } from "../../../../lib/reports";
import { analyticsHref, analyticsSessionsHref, buildWorkspaceAnalytics, readAnalyticsMetric, summarizeMemberMetric } from "../../../../lib/workspace-analytics";
import { workspaceMemberLabels } from "../../../../lib/workspace-members";
import { hasWorkspaceCliApproval, listWorkspaceInsightSessions, readWorkspaceAccess, readWorkspaceTeam } from "../../../../lib/workspace";
import { FirstSessionSetup } from "../first-session-setup";
import { AnalyticsControls } from "./analytics-controls";
import { GitHubSummary } from "./github-summary";
import { AnalyticsSeries, MemberUsage, UsageTable } from "./analytics";
import styles from "./analytics.module.css";

export default async function DashboardPage({ params, searchParams }: PageProps<"/workspace/[id]/dashboard">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const workspace = `/workspace/${encodeURIComponent(id)}`;
  const path = `${workspace}/dashboard`;
  const repositories = `${workspace}/repositories`;
  const access = await readWorkspaceAccess(id);
  const [sessions, teamData] = await Promise.all([
    listWorkspaceInsightSessions(id),
    access.kind === "team" ? Promise.all([readWorkspaceTeam(id), auth()]) : undefined,
  ]);
  if (!sessions.length) {
    const approved = await hasWorkspaceCliApproval(id);
    return <main className={styles.page}><FirstSessionSetup workspace={access} approved={approved} /></main>;
  }

  const now = new Date();
  const filters = readReportFilters(query, now);
  const metric = readAnalyticsMetric(query.metric);
  const report = buildWorkspaceAnalytics(sessions, filters);
  const memberRows = teamData && summarizeMemberMetric(
    report.sessions,
    workspaceMemberLabels(teamData[0].members, teamData[1].userId),
    metric,
  );

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Dashboard</h1>
        <AnalyticsControls key={analyticsHref(path, filters)} path={path} filters={filters} metric={metric} today={now.toISOString().slice(0, 10)} />
      </header>

      <AnalyticsSeries path={path} workspaceId={id} metric={metric} filters={filters} report={report} />

      <GitHubSummary workspaceId={id} filters={filters} />

      {memberRows && (
        <MemberUsage rows={memberRows} metric={metric} workspaceId={id} filters={filters} firstDay={report.firstDay} />
      )}

      <div className={styles.breakdowns}>
        <UsageTable title="Repositories" rows={report.repositories.slice(0, 6)}
          hrefFor={({ key }) => key ? analyticsHref(repositories, { ...filters, repository: key }, { metric }) : undefined}
          more={analyticsHref(repositories, { ...filters, repository: undefined }, { metric })}
        />
        <UsageTable title="Models" rows={report.models.slice(0, 6)}
          hrefFor={({ key }) => key ? analyticsSessionsHref(id, filters, report.firstDay, { model: key }) : undefined}
        />
      </div>
    </main>
  );
}
