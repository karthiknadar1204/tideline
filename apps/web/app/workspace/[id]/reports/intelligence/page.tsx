import { sessionSourceLabel } from "@tideline/contracts";
import { intelligenceDateRanges } from "@tideline/contracts/session-intelligence";
import Link from "next/link";
import { sessionDetailHref } from "../../../../../lib/session-filters";
import { formatCount } from "../../../../../lib/usage";
import { failureReasonGuidance, readSessionIntelligence } from "../../../../../lib/workspace-intelligence";
import { readTrendFilters, trendPeriods } from "../../../../../lib/workspace-trends";
import { ReportNavigation } from "../report-navigation";

type Intelligence = Awaited<ReturnType<typeof readSessionIntelligence>>;
type Pattern = Intelligence["patterns"][number];
type Filters = ReturnType<typeof readTrendFilters>;

const dateLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const panel = "min-w-0 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-5";
const muted = "text-[var(--workspace-muted)]";
const control = "min-h-10 w-full min-w-0 rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-bg)] px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)]";
const textLink = "font-medium text-[var(--workspace-accent)] hover:underline focus-visible:underline";
const signalLabels = {
  tool: "Tool failure",
  skill: "Skill failure",
  child: "Subagent failure",
  reason: "Blocker in tool output",
  "reported-frustration": "User feedback",
  "agent-correction": "Agent correction",
} satisfies Record<Pattern["kind"], string>;

function periodLabel({ from, to }: { from: string; to: string }) {
  return dateLabel.formatRange(new Date(from), new Date(to));
}

function IntelligenceFilters({ workspaceId, filters, repositories }: {
  workspaceId: string;
  filters: Filters;
  repositories: Intelligence["repositories"];
}) {
  return (
    <form aria-label="Session intelligence filters" action={`/workspace/${encodeURIComponent(workspaceId)}/reports/intelligence`}
      className={`${panel} grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]`}>
      <label className="grid min-w-0 gap-1 text-xs font-medium">Period
        <select className={control} name="days" defaultValue={filters.days}>
          {trendPeriods.map((days) => <option key={days} value={days}>{days} days</option>)}
        </select>
      </label>
      <label className="grid min-w-0 gap-1 text-xs font-medium">Through (UTC)
        <input className={control} type="date" name="through" max={filters.latest} defaultValue={filters.through} />
      </label>
      <label className="grid min-w-0 gap-1 text-xs font-medium">Agent
        <select className={control} name="source" defaultValue={filters.source ?? ""}>
          <option value="">All agents</option>
          {Object.entries(sessionSourceLabel).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label className="grid min-w-0 gap-1 text-xs font-medium">Repository
        <select className={control} name="repository" defaultValue={filters.repository ?? ""}>
          <option value="">All repositories</option>
          {filters.repository && !repositories.some(({ key }) => key === filters.repository) &&
            <option value={filters.repository}>Unavailable repository</option>}
          {repositories.map(({ key, name }) => <option key={key} value={key}>{name}</option>)}
        </select>
      </label>
      <button type="submit" className="col-span-2 min-h-10 self-end justify-self-start rounded-lg bg-[var(--workspace-button)] px-4 text-sm font-semibold text-[var(--workspace-button-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)] sm:col-span-4 xl:col-span-1">
        Apply filters
      </button>
    </form>
  );
}

function Coverage({ current, prior }: Pick<Intelligence, "current" | "prior">) {
  const measurements = [
    { label: "Synced sessions", current: current.sessions, prior: prior.sessions },
    { label: "Sessions with activity recorded", current: current.activitySessions, prior: prior.activitySessions },
    { label: "Sessions with incomplete or unavailable activity", current: current.incompleteActivitySessions, prior: prior.incompleteActivitySessions },
    { label: "Sessions with captured tool output", current: current.capturedOutputSessions, prior: prior.capturedOutputSessions },
  ];
  return (
    <details className={`${panel} text-sm`}>
      <summary className="cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--workspace-accent)]">What was recorded</summary>
      <p className={`mt-3 ${muted}`}>Patterns reflect what the sessions recorded. Blocker details depend on captured tool output.</p>
      <table className="mt-2 w-full text-left">
        <thead className={muted}>
          <tr>
            <th scope="col" className="py-2 font-medium">Coverage</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Current</th>
            <th scope="col" className="py-2 text-right font-medium">Prior</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--workspace-border)]">
          {measurements.map(({ label, current, prior }) => (
            <tr key={label}>
              <th scope="row" className="py-2 font-normal">{label}</th>
              <td className="px-3 py-2 text-right tabular-nums">{formatCount(current)}</td>
              <td className="py-2 text-right tabular-nums">{formatCount(prior)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function PatternMetrics({ name, sessions, events }: { name: string; sessions: number; events: number }) {
  return (
    <div className="min-w-0 rounded-lg bg-[var(--workspace-subtle)] px-3 py-2">
      <dt className={`text-xs ${muted}`}>{name}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums">{formatCount(sessions)} {sessions === 1 ? "session" : "sessions"}</dd>
      <dd className={`text-xs tabular-nums ${muted}`}>{formatCount(events)} recorded {events === 1 ? "event" : "events"}</dd>
    </div>
  );
}

function PatternList({ workspaceId, filters, periods, patterns }: {
  workspaceId: string;
  filters: Filters;
  periods: ReturnType<typeof intelligenceDateRanges>;
  patterns: Pattern[];
}) {
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {patterns.map((pattern) => {
        const guidance = pattern.kind === "reason" && Object.hasOwn(failureReasonGuidance, pattern.label)
          ? failureReasonGuidance[pattern.label]
          : undefined;
        return <li className={panel} key={`${pattern.kind}:${pattern.label}`}>
          <p className={`text-xs font-medium ${muted}`}>{signalLabels[pattern.kind]}</p>
          <h3 className="mt-1 break-words text-lg font-semibold [overflow-wrap:anywhere]">{pattern.label}</h3>
          <dl className="mt-3 grid grid-cols-2 gap-2" aria-label="Affected sessions and recorded events">
            <PatternMetrics name="Current period" sessions={pattern.currentSessions} events={pattern.currentEvents} />
            <PatternMetrics name="Prior period" sessions={pattern.priorSessions} events={pattern.priorEvents} />
          </dl>
          {guidance && <p className={`mt-3 text-sm ${muted}`}>{guidance}</p>}
          {pattern.examples.length > 0 && (
            <div className="mt-4">
              <h4 className={`text-xs font-medium ${muted}`}>Session evidence</h4>
              <ul className="mt-1 divide-y divide-[var(--workspace-border)] text-sm">
                {pattern.examples.map(({ id, title, source, startedAt, anchor }) => {
                  const period = startedAt.slice(0, 10) < periods.current.from ? periods.prior : periods.current;
                  const href = sessionDetailHref(workspaceId, id, { ...period, source: filters.source, repository: filters.repository, page: 1 });
                  return (
                    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2" key={`${id}:${anchor}`}>
                      <Link className={`${textLink} min-w-0 break-words [overflow-wrap:anywhere]`}
                        href={`${href}#${encodeURIComponent(anchor)}`} prefetch={false}>{title}</Link>
                      <span className={`text-xs ${muted}`}>
                        {sessionSourceLabel[source]} · <time dateTime={startedAt}>{dateLabel.format(new Date(startedAt))}</time>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </li>;
      })}
    </ul>
  );
}

export default async function SessionIntelligencePage({ params, searchParams }: PageProps<"/workspace/[id]/reports/intelligence">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const filters = readTrendFilters(query);
  const { current, prior, patterns, repositories } = await readSessionIntelligence(id, filters);
  const periods = intelligenceDateRanges(filters);
  const repeated = patterns.filter(({ currentSessions, priorSessions }) => currentSessions + priorSessions > 1);
  const individual = patterns.filter(({ currentSessions, priorSessions }) => currentSessions + priorSessions === 1);
  const hasSessions = current.sessions + prior.sessions > 0;

  return (
    <main className="space-y-6 pt-7 sm:pt-9">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Session intelligence</h1>
        <p className={`text-sm ${muted}`}>{periodLabel(periods.current)} compared with {periodLabel(periods.prior)} · UTC</p>
      </header>
      <ReportNavigation workspaceId={id} active="intelligence" />
      <IntelligenceFilters workspaceId={id} filters={filters} repositories={repositories} />

      <section className="space-y-3" aria-labelledby="recurring-patterns">
        <div>
          <h2 className="text-lg font-semibold" id="recurring-patterns">Recurring patterns</h2>
          <p className={`mt-1 text-sm ${muted}`}>Signals recorded in at least two separate sessions across these periods.</p>
        </div>
        {repeated.length > 0 ? <PatternList workspaceId={id} filters={filters} periods={periods} patterns={repeated} /> : (
          <p className={`${panel} text-sm ${muted}`}>
            {hasSessions ? "No recurring patterns were recorded for these filters." : "No synced sessions match these filters."}
          </p>
        )}
      </section>
      {individual.length > 0 && (
        <details className="space-y-3">
          <summary className="w-fit cursor-pointer text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--workspace-accent)]">Single-session observations</summary>
          <PatternList workspaceId={id} filters={filters} periods={periods} patterns={individual} />
        </details>
      )}
      <Coverage current={current} prior={prior} />
    </main>
  );
}
