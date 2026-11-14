import { sessionSourceLabel, WORKSPACE_SESSION_PAGE_SIZE } from "@tideline/contracts";
import type { WorkspaceSessionSearchQuery, WorkspaceSessionSearchResponse } from "@tideline/contracts";
import Form from "next/form";
import Link from "next/link";
import { parseSessionFilters, sessionFilterParams, sessionHasFilters, sessionListHref } from "../../../lib/session-filters";
import { formatCount } from "../../../lib/usage";
import { searchWorkspaceSessions } from "../../../lib/workspace";
import { RefreshSessions } from "./refresh-sessions";

const sessionDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
const field = "min-h-10 w-full min-w-0 rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-panel)] px-3 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--workspace-accent)]";
const outlineLink = "inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-panel)] px-3 text-sm font-medium hover:bg-[var(--workspace-subtle)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)]";
const labelClass = "block min-w-0 space-y-1.5 text-xs font-medium text-[var(--workspace-muted)]";

function Filters({ workspaceId, filters, data, invalid }: {
  workspaceId: string;
  filters: WorkspaceSessionSearchQuery;
  data: WorkspaceSessionSearchResponse;
  invalid: boolean;
}) {
  const home = `/workspace/${workspaceId}`;
  const advanced = Boolean(filters.model || filters.from || filters.to);
  return (
    <Form action={home} role="search" aria-label="Search and filter sessions" className="space-y-4 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-5">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label className={labelClass}>
          <span>Search sessions</span>
          <input className={field} type="search" name="query" placeholder="Words in a title or conversation" maxLength={200} defaultValue={filters.query} />
        </label>
        <button type="submit" className="min-h-10 rounded-lg bg-[var(--workspace-button)] px-5 text-sm font-semibold text-[var(--workspace-button-text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)]">Search</button>
      </div>
      <div className="grid gap-3 min-[370px]:grid-cols-2 lg:grid-cols-[minmax(10rem,1fr)_minmax(12rem,1fr)_auto] lg:items-end">
        <div className={labelClass}>
          <label htmlFor="sessions-agent">Agent</label>
          <select id="sessions-agent" name="source" defaultValue={filters.source ?? ""} className={field}>
            <option value="">All agents</option>
            {Object.entries(sessionSourceLabel).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
          </select>
        </div>
        <div className={labelClass}>
          <label htmlFor="sessions-repository">Repository</label>
          <select id="sessions-repository" name="repository" defaultValue={filters.repository ?? ""} className={field}>
            <option value="">All repositories</option>
            {data.repositories.map(({ key, name }) => <option key={key} value={key}>{name}</option>)}
            {filters.repository && !data.repositories.some(({ key }) => key === filters.repository) && (
              <option value={filters.repository}>Unavailable repository</option>
            )}
          </select>
        </div>
        {sessionHasFilters(filters) && <Link href={home} className={`${outlineLink} justify-self-start`}>Clear filters</Link>}
      </div>
      <details open={advanced || invalid} className="border-t border-[var(--workspace-border)] pt-3">
        <summary className="w-fit cursor-pointer text-sm font-medium text-[var(--workspace-accent)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">
          More filters <span className="ml-1 font-normal text-[var(--workspace-muted)]">· Model and dates</span>
        </summary>
        <div className="mt-3 grid gap-3 min-[500px]:grid-cols-2 lg:grid-cols-3">
          <div className={labelClass}>
            <label htmlFor="sessions-model">Model</label>
            <select id="sessions-model" name="model" defaultValue={filters.model ?? ""} className={field}>
              <option value="">All models</option>
              {data.models.map((model) => <option key={model} value={model}>{model}</option>)}
              {filters.model && !data.models.includes(filters.model) && <option value={filters.model}>{filters.model}</option>}
            </select>
          </div>
          <label className={labelClass}>
            <span>From (UTC)</span>
            <input className={field} type="date" name="from" defaultValue={filters.from} />
          </label>
          <label className={labelClass}>
            <span>To (UTC)</span>
            <input className={field} type="date" name="to" defaultValue={filters.to} />
          </label>
        </div>
      </details>
      {invalid && <p role="alert" className="text-sm text-[var(--workspace-muted)]">Check your filters and make sure the start date comes before or on the end date.</p>}
    </Form>
  );
}

function SessionList({ id, filters, data }: {
  id: string;
  filters: WorkspaceSessionSearchQuery;
  data: WorkspaceSessionSearchResponse;
}) {
  const pages = Math.ceil(data.total / WORKSPACE_SESSION_PAGE_SIZE);
  const first = (data.page - 1) * WORKSPACE_SESSION_PAGE_SIZE + 1;
  const last = first - 1 + data.sessions.length;
  const query = sessionFilterParams({ ...filters, page: data.page }).toString();
  return (
    <section aria-labelledby="session-results" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="session-results" className="text-base font-semibold">{sessionHasFilters(filters) ? "Search results" : "Recent sessions"}</h2>
        <p className="text-xs tabular-nums text-[var(--workspace-muted)]" aria-live="polite">
          {pages > 1 ? `${formatCount(first)}–${formatCount(last)} of ` : ""}
          {formatCount(data.total)} {data.total === 1 ? "session" : "sessions"}
        </p>
      </div>
      {data.sessions.length ? (
        <ul className="divide-y divide-[var(--workspace-border)] overflow-hidden rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)]">
          {data.sessions.map((session) => (
            <li key={session.id}>
              <Link
                className="block space-y-2 px-4 py-3.5 hover:bg-[var(--workspace-subtle)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--workspace-accent)] sm:px-5"
                href={`/workspace/${id}/sessions/${session.id}${query ? `?${query}` : ""}`}
                prefetch={false}
              >
                <span className="block font-medium [overflow-wrap:anywhere]">{session.title}</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[var(--workspace-muted)]">
                  <span className="rounded-md bg-[var(--workspace-accent-soft)] px-2 py-0.5 font-medium text-[var(--workspace-accent)]">
                    {sessionSourceLabel[session.source]}
                  </span>
                  {session.analytics?.repository && <span className="break-all font-mono">{session.analytics.repository.name}</span>}
                  <time className="tabular-nums" dateTime={session.startedAt} title="Session start date (UTC)">
                    {sessionDate.format(new Date(session.startedAt))}
                  </time>
                  <span className="tabular-nums">{formatCount(session.messageCount)} {session.messageCount === 1 ? "message" : "messages"}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-2 rounded-xl border border-dashed border-[var(--workspace-border)] px-5 py-10 text-center">
          <p className="font-medium">{sessionHasFilters(filters) ? "No matching sessions" : "No sessions yet"}</p>
          {sessionHasFilters(filters) ? (
            <p className="text-sm text-[var(--workspace-muted)]">Try a different search or <Link href={`/workspace/${id}`} className="text-[var(--workspace-accent)] underline underline-offset-2">clear your filters</Link>.</p>
          ) : (
            <p className="text-sm text-[var(--workspace-muted)]"><Link href={`/workspace/${id}/settings#sync-setup`} className="text-[var(--workspace-accent)] underline underline-offset-2">Set up sync</Link> to see your first session.</p>
          )}
        </div>
      )}
      {pages > 1 && (
        <nav aria-label="Session pages" className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm tabular-nums text-[var(--workspace-muted)]">Page {data.page} of {pages}</span>
          <div className="flex gap-2">
            {data.page > 1 && <Link href={sessionListHref(id, { ...filters, page: data.page - 1 })} className={outlineLink}>Previous</Link>}
            {data.page < pages && <Link href={sessionListHref(id, { ...filters, page: data.page + 1 })} className={outlineLink}>Next</Link>}
          </div>
        </nav>
      )}
    </section>
  );
}

export default async function WorkspacePage({ params, searchParams }: PageProps<"/workspace/[id]">) {
  const { id } = await params;
  const { filters, invalid } = parseSessionFilters(await searchParams);
  const data = await searchWorkspaceSessions(id, filters);

  return (
    <main className="space-y-6 pt-7 sm:pt-9">
      {!sessionHasFilters(filters) && data.page === 1 && <RefreshSessions />}
      <header>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Sessions</h1>
      </header>
      <Filters key={`${sessionFilterParams(filters)}:${invalid}`} workspaceId={id} filters={filters} data={data} invalid={invalid} />
      <SessionList id={id} filters={filters} data={data} />
    </main>
  );
}
