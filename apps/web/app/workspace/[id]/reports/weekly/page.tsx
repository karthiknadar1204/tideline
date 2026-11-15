import Link from "next/link";
import { sessionSourceLabel } from "@tideline/contracts";
import { digestComparison, formatDigestWeek } from "@tideline/contracts/digest";
import { sessionDetailHref, sessionListHref } from "../../../../../lib/session-filters";
import { formatCount } from "../../../../../lib/usage";
import type { UsageRow } from "../../../../../lib/usage";
import { readWorkspaceAccess } from "../../../../../lib/workspace";
import { ReportNavigation } from "../report-navigation";
import { saveWeeklyDigest } from "./actions";
import { readWeeklyDigest } from "./digest";

const panel = "min-w-0 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-5";
const action = "inline-flex min-h-9 items-center justify-center rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-panel)] px-3 text-sm font-semibold hover:bg-[var(--workspace-subtle)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)]";
const textLink = "text-sm font-medium text-[var(--workspace-accent)] hover:underline focus-visible:underline";

function TopUsage({ label, rows, href }: { label: string; rows: UsageRow[]; href: (key: string) => string }) {
  return (
    <section className={panel} aria-label={label}>
      <h2 className="font-semibold">{label}</h2>
      {rows.length === 0 && <p className="mt-2 text-sm text-[var(--workspace-muted)]">No data recorded.</p>}
      <ul className="mt-2 divide-y divide-[var(--workspace-border)] text-sm">
        {rows.map(({ key, name, sessionCount }) => key && (
          <li key={key} className="flex items-baseline justify-between gap-3 py-2">
            <Link className={`${textLink} min-w-0 break-words`} href={href(key)} prefetch={false}>{name}</Link>
            <span className="shrink-0 tabular-nums text-[var(--workspace-muted)]">{formatCount(sessionCount)} {sessionCount === 1 ? "session" : "sessions"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function WeeklyReportsPage({ params, searchParams }: PageProps<"/workspace/[id]/reports/weekly">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const [digest, workspace] = await Promise.all([readWeeklyDigest(id, query.week), readWorkspaceAccess(id)]);
  const { periods: weeks, current, prior, errors, notable, repositories, models } = digest;
  const base = `/workspace/${encodeURIComponent(id)}/reports/weekly`;
  const filters = { ...weeks.current, page: 1 };
  const failed = { ...filters, failedTools: "yes" } as const;

  return (
    <main className="space-y-6 pt-7 sm:pt-9">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Weekly digest</h1>
          <p className="mt-2 text-sm text-[var(--workspace-muted)]">{formatDigestWeek(weeks.current)} · UTC</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {workspace.role === "owner" && <Link className={action} href={`/workspace/${encodeURIComponent(id)}/settings/digest`}>Email schedule</Link>}
          <a className={action} href={`${base}/export?week=${weeks.current.from}`}>Download Markdown</a>
          <form action={saveWeeklyDigest.bind(null, id, weeks.current.from)}>
            <button type="submit" className={action}>Save privately</button>
          </form>
        </div>
      </header>
      <ReportNavigation workspaceId={id} active="weekly" />
      {query.save === "failed" && <p role="alert" className="text-sm text-[var(--workspace-muted)]">Could not save this digest. Try again.</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--workspace-muted)]">Compared with {formatDigestWeek(weeks.prior)} · UTC</p>
        <nav className="flex flex-wrap gap-2" aria-label="Digest weeks">
          {weeks.older && <Link className={action} href={`${base}?week=${weeks.older}`}>Previous week</Link>}
          {weeks.newer && <Link className={action} href={`${base}?week=${weeks.newer}`}>Next week</Link>}
          {weeks.newer && weeks.newer !== weeks.latest && <Link className={action} href={base}>Latest week</Link>}
        </nav>
      </div>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {digestComparison(digest).map(({ label, value, previous }) => (
          <div className={panel} key={label}>
            <dt className="text-sm text-[var(--workspace-muted)]">{label}</dt>
            <dd className="mt-2 break-words text-xl font-semibold tabular-nums tracking-tight sm:text-2xl">{value}</dd>
            <dd className="mt-1 text-xs text-[var(--workspace-muted)]">Prior week: {previous}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-4 lg:grid-cols-2">
        <TopUsage label="Top repositories" rows={repositories} href={(repository) => sessionListHref(id, { ...filters, repository })} />
        <TopUsage label="Top models" rows={models} href={(model) => sessionListHref(id, { ...filters, model })} />
        <section className={panel} aria-labelledby="digest-failures">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 className="font-semibold" id="digest-failures">Recorded tool failures</h2>
            {errors.length > 0 && <Link className={textLink} href={sessionListHref(id, failed)} prefetch={false}>View all</Link>}
          </div>
          {errors.length === 0 && <p className="mt-2 text-sm text-[var(--workspace-muted)]">No failures recorded.</p>}
          {errors.length > 0 && (
            <ul className="mt-2 divide-y divide-[var(--workspace-border)] text-sm">
              {errors.map((session) => (
                <li key={session.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <Link className={`${textLink} min-w-0 break-words`} href={sessionDetailHref(id, session.id, failed)} prefetch={false}>{session.title}</Link>
                  <span className="text-[var(--workspace-muted)]">{sessionSourceLabel[session.source]}</span>
                </li>
              ))}
            </ul>
          )}
          {Boolean(current.incompleteActivity || prior.incompleteActivity) && (
            <p className="mt-2 text-xs text-[var(--workspace-muted)]">
              Incomplete or unavailable activity in {formatCount(current.incompleteActivity)} sessions this week and {formatCount(prior.incompleteActivity)} in the prior week.
            </p>
          )}
        </section>
        <section className={panel} aria-labelledby="digest-notable">
          <h2 className="font-semibold" id="digest-notable">Notable sessions</h2>
          {notable.length === 0 && <p className="mt-2 text-sm text-[var(--workspace-muted)]">No sessions in this week.</p>}
          {notable.length > 0 && (
            <ul className="mt-2 divide-y divide-[var(--workspace-border)] text-sm">
              {notable.map(({ session, reasons }) => (
                <li key={session.id} className="space-y-1 py-2">
                  <Link className={`${textLink} break-words`} href={sessionDetailHref(id, session.id, filters)} prefetch={false}>{session.title}</Link>
                  <p className="text-[var(--workspace-muted)]">{reasons.join(" · ")}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
