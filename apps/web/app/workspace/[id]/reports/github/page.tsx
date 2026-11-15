import Link from "next/link";
import { readGitHubActivity } from "../../../../../lib/github-activity";
import { readReportFilters, reportFilterParams, reportPeriods } from "../../../../../lib/reports";
import { ReportNavigation } from "../report-navigation";
import styles from "../../dashboard/analytics.module.css";

export default async function GitHubActivityPage({ params, searchParams }: PageProps<"/workspace/[id]/reports/github">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const filters = readReportFilters(query);
  const kind = query.kind === "merge" || query.kind === "ci" ? query.kind : undefined;
  const base = `/workspace/${id}/reports`;
  const path = `${base}/github`;
  const { events, hasMore } = await readGitHubActivity(id, filters, kind);
  const labels = [[undefined, "All"], ["merge", "Merged PRs"], ["ci", "CI runs"]] as const;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>GitHub activity</h1>
        <form className={styles.controls} action={path} aria-label="GitHub activity dates">
          {filters.repository && <input type="hidden" name="repository" value={filters.repository} />}
          {kind && <input type="hidden" name="kind" value={kind} />}
          <select aria-label="Time period" name="days" defaultValue={filters.days}>
            {reportPeriods.map((days) => <option key={days} value={days}>{days === "all" ? "All time" : days === 1 ? "One day" : `Last ${days} days`}</option>)}
          </select>
          <label className={styles.date}>Through <input type="date" name="through" aria-label="Through date" defaultValue={filters.through}
            max={new Date().toISOString().slice(0, 10)} /></label>
          <button className="p-2 text-sm font-medium underline" type="submit">Apply</button>
        </form>
      </header>
      <ReportNavigation workspaceId={id} active="github" />
      <nav className="flex flex-wrap gap-3 text-sm" aria-label="GitHub activity type">
        {labels.map(([selection, description]) => {
          const search = new URLSearchParams(reportFilterParams({ ...filters, source: undefined }));
          if (selection) search.set("kind", selection);
          return <Link key={description} href={`${path}?${search}`} aria-current={kind === selection ? "page" : undefined}
            className={kind === selection ? "font-semibold underline" : "hover:underline"}>{description}</Link>;
        })}
      </nav>
      {hasMore && <p className="text-sm text-[var(--workspace-muted)]">Showing the 1,000 most recent events in this range.</p>}
      {events.length ? (
        <div className={`${styles.tablePanel} ${styles.tableScroll}`}>
          <table className={styles.table}>
            <caption className="sr-only">Merged pull requests and GitHub Actions runs</caption>
            <thead><tr><th scope="col">Event</th><th scope="col">Repository</th><th scope="col">Status</th><th scope="col">Date (UTC)</th></tr></thead>
            <tbody>
              {events.map(({ repository, event }) => (
                <tr key={`${repository}:${event.kind}:${event.id}`}>
                  <td><a className="hover:underline" href={`https://github.com/${repository}/${event.kind === "merge" ? "pull" : "actions/runs"}/${event.id}`} target="_blank" rel="noreferrer">{event.title}</a></td>
                  <td>{repository}</td>
                  <td>{event.status.replaceAll("_", " ")}</td>
                  <td><time dateTime={event.at}>{event.at.slice(0, 10)}</time></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <section className="rounded-xl border p-6 space-y-2">
          <h2 className="font-semibold">No GitHub activity in this view</h2>
          <p className="text-sm text-[var(--workspace-muted)]">From a GitHub checkout, run <code>tideline github sync</code> to import recent merged pull requests and workflow runs.</p>
          <p className="text-sm text-[var(--workspace-muted)]">For automatic collection, run <code>tideline sync setup --github-activity</code> and choose your checkouts.</p>
        </section>
      )}
    </main>
  );
}
