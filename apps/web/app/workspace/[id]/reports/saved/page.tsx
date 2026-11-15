import { savedReportPage } from "@tideline/contracts";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatSavedReportDate, listSavedReports, savedReportVisibilityLabel } from "../../../../../lib/saved-reports";
import { ReportNavigation } from "../report-navigation";

export default async function SavedReportsPage({ params, searchParams }: PageProps<"/workspace/[id]/reports/saved">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const page = savedReportPage.safeParse(query.page).data ?? 1;
  const workspace = `/workspace/${encodeURIComponent(id)}`;
  const base = `${workspace}/reports/saved`;
  const list = await listSavedReports(id, page);
  if (page > 1 && !list.reports.length) redirect(base);

  return (
    <main className="space-y-6 pt-7 sm:pt-9">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Reports</h1>
        <p className="text-sm text-[var(--workspace-muted)]">Reports saved by you or shared with this workspace.</p>
      </header>
      <ReportNavigation workspaceId={id} active="saved" />
      {list.reports.length ? (
        <ul className="divide-y divide-[var(--workspace-border)] overflow-hidden rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)]" aria-label="Saved reports">
          {list.reports.map((report) => (
            <li key={report.id}>
              <Link href={`${base}/${report.id}`} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-4 hover:bg-[var(--workspace-subtle)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--workspace-accent)] sm:px-5">
                <span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">{report.title}</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--workspace-muted)]">
                  <span>{savedReportVisibilityLabel[report.visibility]}</span>
                  <time dateTime={report.createdAt}>{formatSavedReportDate(report.createdAt)}</time>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <section className="rounded-xl border border-dashed border-[var(--workspace-border)] bg-[var(--workspace-panel)] px-5 py-12 text-center" aria-labelledby="saved-reports-empty">
          <h2 className="font-semibold" id="saved-reports-empty">No saved reports</h2>
          <p className="mt-2 text-sm text-[var(--workspace-muted)]">Connect an agent to Tideline MCP and ask it to save a report.</p>
          <Link className="mt-4 inline-block text-sm font-medium text-[var(--workspace-accent)] underline underline-offset-4" href={`${workspace}/settings/integrations`}>Set up MCP</Link>
        </section>
      )}
      {(page > 1 || list.nextPage) && (
        <nav className="flex flex-wrap items-center gap-4 text-sm" aria-label="Report pages">
          {page > 1 && <Link className="text-[var(--workspace-accent)] underline underline-offset-4" href={`${base}?page=${page - 1}`}>Previous page</Link>}
          <span className="text-[var(--workspace-muted)]">Page {page}</span>
          {list.nextPage && <Link className="text-[var(--workspace-accent)] underline underline-offset-4" href={`${base}?page=${list.nextPage}`}>Next page</Link>}
        </nav>
      )}
    </main>
  );
}
