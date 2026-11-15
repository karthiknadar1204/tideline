import { readReportFilters } from "../../../../lib/reports";
import { analyticsHref, analyticsSessionsHref, buildWorkspaceAnalytics, readAnalyticsMetric } from "../../../../lib/workspace-analytics";
import { hasWorkspaceCliApproval, listWorkspaceSessions, readWorkspaceAccess } from "../../../../lib/workspace";
import { FirstSessionSetup } from "../first-session-setup";
import { AnalyticsControls } from "./analytics-controls";
import { AnalyticsSeries, UsageTable } from "./analytics";
import styles from "./analytics.module.css";

export default async function DashboardPage({ params, searchParams }: PageProps<"/workspace/[id]/dashboard">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const workspace = `/workspace/${encodeURIComponent(id)}`;
  const path = `${workspace}/dashboard`;
  const repositories = `${workspace}/repositories`;
  const sessions = await listWorkspaceSessions(id);
  if (!sessions.length) {
    const [access, approved] = await Promise.all([readWorkspaceAccess(id), hasWorkspaceCliApproval(id)]);
    return <main className={styles.page}><FirstSessionSetup workspace={access} approved={approved} /></main>;
  }

  const now = new Date();
  const filters = readReportFilters(query, now);
  const metric = readAnalyticsMetric(query.metric);
  const report = buildWorkspaceAnalytics(sessions, filters);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Dashboard</h1>
        <AnalyticsControls key={analyticsHref(path, filters)} path={path} filters={filters} metric={metric} today={now.toISOString().slice(0, 10)} />
      </header>

      <AnalyticsSeries path={path} workspaceId={id} metric={metric} filters={filters} report={report} />

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
