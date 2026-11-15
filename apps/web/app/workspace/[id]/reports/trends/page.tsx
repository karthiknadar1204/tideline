import { sessionSourceLabel } from "@tideline/contracts";
import Link from "next/link";
import { reportFilterParams } from "../../../../../lib/reports";
import { sessionDetailHref, sessionListHref } from "../../../../../lib/session-filters";
import { formatCost, formatCount } from "../../../../../lib/usage";
import type { Usage, UsageRow } from "../../../../../lib/usage";
import { readTrendFilters, readWorkspaceTrends, trendPeriods } from "../../../../../lib/workspace-trends";
import { ReportNavigation } from "../report-navigation";

const utcLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const panel = "min-w-0 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-5";
const muted = "text-[var(--workspace-muted)]";
const textLink = "font-medium text-[var(--workspace-accent)] hover:underline focus-visible:underline";
const control = "min-h-9 w-full rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-bg)] px-2 text-sm";
const utcRange = ({ from, to }: { from: string; to: string }) => utcLabel.formatRange(new Date(from), new Date(to));

function metricLabel(metric: Usage["tokens"], format: (value: number) => string) {
  return metric.value === null ? "Unavailable" : `${format(metric.value)}${metric.complete ? "" : " (partial)"}`;
}

function Breakdown({ name, current, prior, href }: {
  name: string; current: UsageRow[]; prior: UsageRow[]; href: (id: string, priorOnly: boolean) => string;
}) {
  const records = new Map(prior.map(({ key, name, sessionCount }) => [key, { key, name, currentCount: 0, priorCount: sessionCount }]));
  for (const { key, name, sessionCount } of current) {
    records.set(key, { key, name, currentCount: sessionCount, priorCount: records.get(key)?.priorCount ?? 0 });
  }
  const rows = [...records.values()].sort((left, right) => Math.max(right.currentCount, right.priorCount) -
    Math.max(left.currentCount, left.priorCount) || left.name.localeCompare(right.name)).slice(0, 6);
  return (
    <section className={panel} aria-label={name}>
      <h2 className="font-semibold">{name}</h2>
      {rows.length ? (
        <table className="mt-2 w-full text-left text-sm">
          <thead className={muted}><tr>
            <th scope="col" className="py-2 font-normal">Name</th>
            <th scope="col" className="px-2 py-2 text-right font-normal">Current</th>
            <th scope="col" className="py-2 text-right font-normal">Prior</th>
          </tr></thead>
          <tbody className="divide-y divide-[var(--workspace-border)]">
            {rows.map(({ key, name, currentCount, priorCount }) => (
              <tr key={key ?? "unknown"}>
                <th scope="row" className="max-w-48 py-2 break-words font-normal">{key ? <Link className={textLink} href={href(key, currentCount === 0)}>{name}</Link> : name}</th>
                <td className="px-2 py-2 text-right tabular-nums">{formatCount(currentCount)}</td>
                <td className={`py-2 text-right tabular-nums ${muted}`}>{formatCount(priorCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className={`mt-2 text-sm ${muted}`}>No sessions in this period.</p>}
    </section>
  );
}

export default async function WorkspaceTrendsPage({ params, searchParams }: PageProps<"/workspace/[id]/reports/trends">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const filters = readTrendFilters(query);
  const { observed, earlier, timeline, previousTimeline, repositories, dates, priorDates, longest, largestEstimate } = await readWorkspaceTrends(id, filters);
  const links = { ...dates, page: 1, source: filters.source, repository: filters.repository };
  const peak = Math.max(1, ...timeline.map(({ sessions }) => sessions), ...previousTimeline.map(({ sessions }) => sessions));
  const maxCoverage = Math.max(observed.incomplete, earlier.incomplete);
  const counts = [
    { name: "Sessions", value: formatCount(observed.sessions), prior: formatCount(earlier.sessions), href: sessionListHref(id, links) },
    { name: "Reported tokens", value: metricLabel(observed.total.tokens, formatCount), prior: metricLabel(earlier.total.tokens, formatCount) },
    { name: "Estimated cost", value: metricLabel(observed.total.cost, formatCost), prior: metricLabel(earlier.total.cost, formatCost) },
    { name: "Sessions with tool failures", value: formatCount(observed.failures), prior: formatCount(earlier.failures), href: sessionListHref(id, { ...links, failedTools: "yes" }) },
    { name: "Reported frustration", value: formatCount(observed.frustration), prior: formatCount(earlier.frustration), href: sessionListHref(id, { ...links, frustration: "reported" }) },
  ];

  return (
    <main className="space-y-6 pt-7 sm:pt-9">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Workspace trends</h1>
        <p className={`text-sm ${muted}`}>{utcRange(dates)} compared with {utcRange(priorDates)} · UTC</p>
      </header>
      <ReportNavigation workspaceId={id} active="trends" />
      <form className={`${panel} grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]`}
        aria-label="Trend filters" action={`/workspace/${id}/reports/trends`}>
        <div className="grid gap-1 text-xs font-medium">
          <label htmlFor="trends-period">Period</label>
          <select id="trends-period" className={control} name="days" defaultValue={filters.days}>
            {trendPeriods.map((days) => <option value={days} key={days}>{days} days</option>)}
          </select>
        </div>
        <div className="grid gap-1 text-xs font-medium">
          <label htmlFor="trends-through">Through (UTC)</label>
          <input id="trends-through" className={`${control} min-w-0`} type="date" name="through" max={filters.latest} defaultValue={filters.through} />
        </div>
        <div className="grid gap-1 text-xs font-medium">
          <label htmlFor="trends-agent">Agent</label>
          <select id="trends-agent" className={control} name="source" defaultValue={filters.source ?? ""}>
            <option value="">All agents</option>
            {Object.entries(sessionSourceLabel).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
        <div className="grid gap-1 text-xs font-medium">
          <label htmlFor="trends-repository">Repository</label>
          <select id="trends-repository" className={control} name="repository" defaultValue={filters.repository ?? ""}>
            <option value="">All repositories</option>
            {filters.repository && !repositories.some(({ key }) => key === filters.repository) &&
              <option value={filters.repository}>Unavailable repository</option>}
            {repositories.map(({ key, name }) => <option key={key} value={key}>{name}</option>)}
          </select>
        </div>
        <button type="submit" className="min-h-9 self-end justify-self-start rounded-lg bg-[var(--workspace-button)] px-4 text-sm font-semibold text-[var(--workspace-button-text)]">Apply</button>
      </form>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {counts.map(({ name, value, prior, href }) => (
          <div key={name} className={panel}>
            <dt className={`text-sm ${muted}`}>{href ? <Link className={textLink} href={href}>{name}</Link> : name}</dt>
            <dd className="mt-2 break-words text-xl font-semibold tabular-nums">{value}</dd>
            <dd className={`mt-1 text-xs ${muted}`}>Prior period {prior}</dd>
          </div>
        ))}
      </dl>

      <section className={panel} aria-labelledby="trend-session-chart">
        <h2 className="font-semibold" id="trend-session-chart">Sessions by day</h2>
        <div className={`mt-2 flex flex-wrap gap-4 text-xs ${muted}`}>
          <span><span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full bg-[var(--workspace-accent)]" />Current period</span>
          <span><span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full bg-[var(--workspace-muted)]" />Prior period</span>
        </div>
        <div className="mt-4 flex h-28 items-end gap-px border-b border-[var(--workspace-border)]" aria-hidden="true">
          {timeline.map(({ period, sessions }, index) => {
            const previous = previousTimeline[index];
            return <div className="flex h-full min-w-0 flex-1 items-end justify-center gap-px" key={period}
              title={`${period}: ${sessions} · ${previous.period}: ${previous.sessions}`}>
              <span className="max-w-5 flex-1 rounded-t-sm bg-[var(--workspace-accent)]" style={{ height: `${100 * sessions / peak}%` }} />
              <span className="max-w-5 flex-1 rounded-t-sm bg-[var(--workspace-muted)] opacity-60" style={{ height: `${100 * previous.sessions / peak}%` }} />
            </div>;
          })}
        </div>
        <details className="mt-3 text-sm">
          <summary className={`cursor-pointer ${textLink}`}>View daily counts</summary>
          <table className="mt-2 w-full text-left tabular-nums">
            <thead className={muted}><tr><th scope="col">Current date</th><th scope="col">Sessions</th><th scope="col">Prior date</th><th scope="col">Sessions</th></tr></thead>
            <tbody className="divide-y divide-[var(--workspace-border)]">
              {timeline.map(({ period, sessions }, index) => <tr key={period}>
                <td>{period}</td><td>{formatCount(sessions)}</td><td>{previousTimeline[index].period}</td><td>{formatCount(previousTimeline[index].sessions)}</td>
              </tr>)}
            </tbody>
          </table>
        </details>
      </section>

      <section className={panel} aria-labelledby="session-intelligence">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold" id="session-intelligence">Session highlights</h2>
          <Link className={`text-sm ${textLink}`} href={`/workspace/${encodeURIComponent(id)}/reports/intelligence?${reportFilterParams(filters)}`}>
            Explore session intelligence
          </Link>
        </div>
        {maxCoverage > 0 && <p className={`mt-2 text-sm ${muted}`}>Tool activity was incomplete or unavailable for {formatCount(observed.incomplete)} current sessions and {formatCount(earlier.incomplete)} prior sessions.</p>}
        {!observed.sessions && <p className={`mt-2 text-sm ${muted}`}>No sessions in the current period.</p>}
        {(longest || largestEstimate) && (
          <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
            {longest && <div><dt className={muted}>Most messages · {formatCount(longest.messageCount)}</dt>
              <dd><Link className={textLink} href={sessionDetailHref(id, longest.id, links)}>{longest.title}</Link></dd></div>}
            {largestEstimate && <div><dt className={muted}>Largest recorded estimate · {formatCost(largestEstimate.value)}</dt>
              <dd><Link className={textLink} href={sessionDetailHref(id, largestEstimate.session.id, links)}>{largestEstimate.session.title}</Link></dd></div>}
          </dl>
        )}
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown name="Sessions by repository" current={observed.repositories} prior={earlier.repositories}
          href={(repository, priorOnly) => sessionListHref(id, { ...links, ...(priorOnly && priorDates), repository })} />
        <Breakdown name="Sessions by model" current={observed.models} prior={earlier.models}
          href={(model, priorOnly) => sessionListHref(id, { ...links, ...(priorOnly && priorDates), model })} />
      </div>
    </main>
  );
}
