import Link from "next/link";
import { formatSavedReportDate, readSavedReport, savedReportVisibilityLabel } from "../../../../../../lib/saved-reports";
import { DeleteReportButton } from "./delete-report-button";
import { ReportMarkdown } from "./report-markdown";

export default async function SavedReportPage({ params }: PageProps<"/workspace/[id]/reports/saved/[reportId]">) {
  const { id, reportId } = await params;
  const report = await readSavedReport(id, reportId);
  const workspace = `/workspace/${encodeURIComponent(id)}`;

  return (
    <main className="max-w-4xl space-y-6 pt-7 sm:pt-9">
      <header className="space-y-3">
        <Link className="text-sm text-[var(--workspace-accent)] underline underline-offset-4" href={`${workspace}/reports/saved`}>Saved reports</Link>
        <h1 className="break-words text-3xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">{report.title}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--workspace-muted)]">
          <span>{savedReportVisibilityLabel[report.visibility]}</span>
          <time dateTime={report.createdAt}>{formatSavedReportDate(report.createdAt)} UTC</time>
        </div>
      </header>
      <article aria-label="Report content" className="min-w-0 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-6">
        <ReportMarkdown markdown={report.markdown} />
      </article>
      {report.sessionIds.length > 0 && (
        <section className="space-y-2" aria-labelledby="cited-sessions">
          <h2 className="font-semibold" id="cited-sessions">Cited sessions</h2>
          <ul className="flex flex-wrap gap-x-4 gap-y-2">
            {report.sessionIds.map((sessionId, index) => (
              <li key={sessionId}>
                <Link className="text-sm text-[var(--workspace-accent)] underline underline-offset-4" href={`${workspace}/sessions/${sessionId}`} prefetch={false}>Open session {index + 1}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {report.isAuthor && <DeleteReportButton workspaceId={id} reportId={reportId} />}
    </main>
  );
}
