import Link from "next/link";
import { sessionSource, sessionSourceLabel } from "@tideline/contracts";
import { buildWorkspaceReport, readReportFilters, reportFilterParams, reportPeriods } from "../../../../lib/reports";
import { formatCount, summarizeWorkspace } from "../../../../lib/usage";
import { listWorkspaceSessions } from "../../../../lib/workspace";
import { WorkspaceActivity } from "../activity-summary";
import { UsageBreakdown, UsageCards } from "../usage-summary";

const dayLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const monthLabel = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });
const rangeLabel = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
const control = "h-10 w-full rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-panel)] px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)]";
const action = "inline-flex min-h-10 items-center justify-center rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-panel)] px-4 text-sm font-semibold hover:bg-[var(--workspace-subtle)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)]";

function SessionTimeline({ timeline, granularity }: Pick<ReturnType<typeof buildWorkspaceReport>, "timeline" | "granularity">) {
  const max = timeline.reduce((peak, { sessions }) => Math.max(peak, sessions), 1);
  const label = granularity === "day" ? dayLabel : monthLabel;
  const periods = new Set([timeline[0].period, timeline[Math.floor(timeline.length / 2)].period, timeline[timeline.length - 1].period]);
  return (
    <section className="space-y-4 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-6" aria-labelledby="daily-session-count">
      <div>
        <h2 id="daily-session-count" className="text-lg font-semibold tracking-tight">Sessions by {granularity}</h2>
        <p className="mt-1 text-sm text-[var(--workspace-muted)]">
          {granularity === "day" ? "Grouped by session start date in UTC." : "Shows months with session starts in UTC."}
        </p>
      </div>
      <div aria-hidden="true" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-2">
        <div className="flex h-32 flex-col justify-between text-right text-xs tabular-nums text-[var(--workspace-muted)]">
          <span>{formatCount(max)}</span>
          <span>0</span>
        </div>
        <div className="relative flex h-32 items-end justify-around gap-px border-y border-[var(--workspace-border)] px-px sm:gap-0.5">
          <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-[var(--workspace-border)]" />
          {timeline.map(({ period, sessions }) => (
            <div
              key={period}
              className={`relative max-w-12 flex-1 rounded-t-sm ${sessions ? "bg-[var(--workspace-accent)]" : "bg-[var(--workspace-border)]"}`}
              style={{ height: sessions ? `${100 * sessions / max}%` : "2px" }}
              title={`${label.format(new Date(period))} · ${formatCount(sessions)} ${sessions === 1 ? "session" : "sessions"}`}
            />
          ))}
        </div>
        <div className="col-start-2 flex justify-between gap-1 text-xs tabular-nums text-[var(--workspace-muted)]">
          {[...periods].map((period) => <time key={period} dateTime={period}>{label.format(new Date(period))}</time>)}
        </div>
      </div>
      <details className="border-t border-[var(--workspace-border)] pt-3 text-sm">
        <summary className="w-fit cursor-pointer font-medium text-[var(--workspace-accent)]">View {granularity === "day" ? "daily" : "monthly"} counts</summary>
        <table className="mt-3 w-full text-left tabular-nums">
          <thead>
            <tr className="border-b border-[var(--workspace-border)] text-[var(--workspace-muted)]">
              <th className="py-2 font-medium" scope="col">{granularity === "day" ? "Date" : "Month"} (UTC)</th>
              <th className="py-2 text-right font-medium" scope="col">Sessions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--workspace-border)]">
            {timeline.map(({ period, sessions }) => (
              <tr key={period}>
                <th className="py-1.5 font-normal" scope="row"><time dateTime={period}>{label.format(new Date(period))}</time></th>
                <td className="py-1.5 text-right">{formatCount(sessions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

export default async function ReportsPage({ params, searchParams }: PageProps<"/workspace/[id]/reports">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const filters = readReportFilters(query);
  const report = buildWorkspaceReport(await listWorkspaceSessions(id), filters);
  const usage = summarizeWorkspace(report.sessions);
  const base = `/workspace/${encodeURIComponent(id)}/reports`;
  const hasMissingRepo = filters.repository && !report.repositories.some(({ key }) => key === filters.repository);
  const end = new Date(filters.through);
  const interval = report.firstDay ? rangeLabel.formatRange(new Date(report.firstDay), end) : `All time through ${rangeLabel.format(end)}`;

  return (
    <main className="space-y-6 pt-7 sm:pt-9">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Reports</h1>
          <p className="mt-2 text-sm text-[var(--workspace-muted)]">{interval} · UTC</p>
        </div>
        <a className={action} href={`${base}/export?${reportFilterParams(filters)}`}>Download CSV</a>
      </header>
      <form
        action={base}
        method="get"
        aria-label="Report filters"
        className="grid grid-cols-2 items-end gap-3 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:grid-cols-4 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
      >
        <div className="min-w-0 space-y-1.5 text-xs font-medium text-[var(--workspace-muted)]">
          <label htmlFor="report-period" className="block">Period</label>
          <select id="report-period" className={control} name="days" defaultValue={String(filters.days)}>
            {reportPeriods.map((days) => <option key={days} value={days}>{days === "all" ? "All time" : `Last ${days} days`}</option>)}
          </select>
        </div>
        <div className="min-w-0 space-y-1.5 text-xs font-medium text-[var(--workspace-muted)]">
          <label htmlFor="report-end" className="block">Ending on</label>
          <input id="report-end" className={`${control} min-w-0`} type="date" name="through" defaultValue={filters.through} min="0001-01-01" max={new Date().toISOString().slice(0, 10)} />
        </div>
        <div className="min-w-0 space-y-1.5 text-xs font-medium text-[var(--workspace-muted)]">
          <label htmlFor="report-agent" className="block">Agent</label>
          <select id="report-agent" className={control} name="source" defaultValue={filters.source ?? ""}>
            <option value="">All agents</option>
            {sessionSource.options.map((source) => <option key={source} value={source}>{sessionSourceLabel[source]}</option>)}
          </select>
        </div>
        <div className="min-w-0 space-y-1.5 text-xs font-medium text-[var(--workspace-muted)]">
          <label htmlFor="report-repository" className="block">Repository</label>
          <select id="report-repository" className={control} name="repository" defaultValue={filters.repository ?? ""}>
            <option value="">All repositories</option>
            {hasMissingRepo && <option value={filters.repository}>Unavailable repository</option>}
            {report.repositories.map(({ key, name }) => <option key={key} value={key}>{name}</option>)}
          </select>
        </div>
        <button
          className="col-span-2 min-h-10 justify-self-start rounded-lg bg-[var(--workspace-button)] px-4 text-sm font-semibold text-[var(--workspace-button-text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)] sm:col-span-4 lg:col-span-1"
          type="submit"
        >
          Apply
        </button>
      </form>

      {report.sessions.length ? (
        <>
          <UsageCards label="Sessions" value={formatCount(report.sessions.length)} usage={usage.total} />
          <SessionTimeline timeline={report.timeline} granularity={report.granularity} />
          <UsageBreakdown usage={usage} />
          <WorkspaceActivity sessions={report.sessions} />
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--workspace-border)] bg-[var(--workspace-panel)] px-5 py-12 text-center">
          <h2 className="font-semibold">No sessions in this report</h2>
          <p className="mt-2 text-sm text-[var(--workspace-muted)]">Try a different date range, agent, or repository.</p>
          <Link className="mt-4 inline-block text-sm font-medium text-[var(--workspace-accent)] underline underline-offset-4" href={base}>
            Reset report filters
          </Link>
        </div>
      )}
    </main>
  );
}
