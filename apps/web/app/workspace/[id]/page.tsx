import { sessionSourceLabel, WORKSPACE_SESSION_PAGE_SIZE } from "@tideline/contracts";
import type { WorkspaceSessionSearchQuery, WorkspaceSessionSearchResponse } from "@tideline/contracts";
import Form from "next/form";
import Link from "next/link";
import { parseSessionFilters, sessionDetailHref, sessionFilterParams, sessionHasFilters, sessionListHref } from "../../../lib/session-filters";
import { formatCost, formatCount, summarizeSession } from "../../../lib/usage";
import { hasWorkspaceCliApproval, readWorkspaceAccess, searchWorkspaceSessions } from "../../../lib/workspace";
import { FirstSessionSetup } from "./first-session-setup";
import { SessionMenu } from "./sessions/session-menu";
import { SessionRefresh } from "./sessions/session-refresh";
import styles from "./sessions/sessions.module.css";

const sessionDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const sortChoices = [
  { key: undefined, label: "Recently synced" },
  { key: "newest", label: "Newest started" },
  { key: "oldest", label: "Oldest started" },
] as const;

function Filters({ workspaceId, filters, data, invalid }: {
  workspaceId: string;
  filters: WorkspaceSessionSearchQuery;
  data: WorkspaceSessionSearchResponse;
  invalid: boolean;
}) {
  const home = `/workspace/${workspaceId}`;
  const selectedRepository = data.repositories.find(({ key }) => key === filters.repository);
  const refinements = [
    ["repository", filters.repository && (selectedRepository?.name ?? "Unavailable repository")],
    ["source", filters.source && sessionSourceLabel[filters.source]],
    ["model", filters.model],
    ["from", filters.from && `From ${filters.from}`],
    ["to", filters.to && `Through ${filters.to}`],
  ] as const;
  const active = refinements.filter(([, label]) => label);
  const clear = sessionListHref(workspaceId, { page: 1, sort: filters.sort });

  return (
    <div className={styles.controls}>
      <Form action={home} role="search" aria-label="Search and filter sessions" className={styles.toolbar}>
        {filters.sort && <input type="hidden" name="sort" value={filters.sort} />}
        <div className={styles.search}>
          <label htmlFor="session-query" className="sr-only">Search sessions</label>
          <input id="session-query" className={styles.searchField} type="search" name="query" placeholder="Search titles and conversations" maxLength={200} defaultValue={filters.query ?? ""} />
          <button type="submit" className={styles.control}>Search</button>
        </div>
        <SessionMenu initiallyOpen={invalid} label={<>Filters{active.length > 0 && <span className={styles.filterCount}>{active.length}</span>} <span aria-hidden="true">⌄</span></>}>
          <div className={styles.popover}>
            <div className={styles.filterFields}>
              <div className={styles.label}>
                <label htmlFor="session-repository">Repository</label>
                <select id="session-repository" className={styles.field} name="repository" defaultValue={filters.repository ?? ""}>
                  <option value="">All repositories</option>
                  {data.repositories.map(({ key, name }) => <option key={key} value={key}>{name}</option>)}
                  {filters.repository && !selectedRepository && <option value={filters.repository}>Unavailable repository</option>}
                </select>
              </div>
              <div className={styles.label}>
                <label htmlFor="session-agent">Agent</label>
                <select id="session-agent" className={styles.field} name="source" defaultValue={filters.source ?? ""}>
                  <option value="">All agents</option>
                  {Object.entries(sessionSourceLabel).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
                </select>
              </div>
              <div className={styles.label}>
                <label htmlFor="session-model">Model</label>
                <select id="session-model" className={styles.field} name="model" defaultValue={filters.model ?? ""}>
                  <option value="">All models</option>
                  {data.models.map((model) => <option key={model} value={model}>{model}</option>)}
                  {filters.model && !data.models.includes(filters.model) && <option value={filters.model}>{filters.model}</option>}
                </select>
              </div>
              <div className={styles.filterDates}>
                <label className={styles.label}>
                  <span>From (UTC)</span>
                  <input className={styles.field} type="date" name="from" defaultValue={filters.from ?? ""} />
                </label>
                <label className={styles.label}>
                  <span>Through (UTC)</span>
                  <input className={styles.field} type="date" name="to" defaultValue={filters.to ?? ""} />
                </label>
              </div>
            </div>
            <div className={styles.filterActions}>
              {sessionHasFilters(filters) && <Link className={styles.textLink} href={clear}>Clear all</Link>}
              <button type="submit" className={`${styles.control} ${styles.primaryControl}`}>Apply filters</button>
            </div>
          </div>
        </SessionMenu>
        <SessionMenu label={<>Sort <span aria-hidden="true">↕</span></>}>
          <div className={`${styles.popover} ${styles.sortMenu}`} aria-label="Sort sessions">
            {sortChoices.map(({ key, label }) => (
              <Link key={label} aria-current={filters.sort === key ? "true" : undefined} href={sessionListHref(workspaceId, { ...filters, sort: key, page: 1 })}>
                {label}
              </Link>
            ))}
          </div>
        </SessionMenu>
      </Form>
      {!!active.length && (
        <div className={styles.filterChips} aria-label="Active filters">
          {active.map(([field, label]) => (
            <Link className={styles.chip} key={field} href={sessionListHref(workspaceId, { ...filters, [field]: undefined, page: 1 })} aria-label={`Remove filter ${label}`}>
              {label} <span aria-hidden="true">×</span>
            </Link>
          ))}
        </div>
      )}
      {invalid && <p role="alert" className={styles.muted}>Check the filters and make sure the start date is on or before the end date.</p>}
    </div>
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
  const hasFilters = sessionHasFilters(filters);
  const clear = sessionListHref(id, { page: 1, sort: filters.sort });
  const pageFilters = { ...filters, page: data.page };

  return (
    <section aria-labelledby="session-results" className={styles.results}>
      <div className={styles.resultHeader}>
        <h2 id="session-results" className="sr-only">{hasFilters ? "Search results" : "Recent sessions"}</h2>
        <p className={styles.muted} aria-live="polite">
          {pages > 1 ? `${formatCount(first)}–${formatCount(last)} of ` : ""}
          {formatCount(data.total)} {data.total === 1 ? "session" : "sessions"}
        </p>
        {hasFilters && <Link className={styles.textLink} href={clear}>Clear filters</Link>}
      </div>
      {data.sessions.length ? (
        <div className={styles.list}>
          <div className={styles.columns} aria-hidden="true">
            <span>Session</span><span>Agent</span><span>Started (UTC)</span><span>Tokens</span><span>Est. cost</span>
          </div>
          <ul>
            {data.sessions.map((session) => {
              const usage = summarizeSession(session.analytics);
              return (
                <li key={session.id}>
                  <Link className={styles.sessionRow} href={sessionDetailHref(id, session.id, pageFilters)} prefetch={false}>
                    <span className={styles.sessionIdentity}>
                      <span className={styles.sessionTitle}>{session.title}</span>
                      <span className={styles.sessionMeta}>
                        {session.analytics?.repository && <span>{session.analytics.repository.name}</span>}
                        <span>{formatCount(session.messageCount)} {session.messageCount === 1 ? "message" : "messages"}</span>
                      </span>
                    </span>
                    <span className={styles.agent}>{sessionSourceLabel[session.source]}</span>
                    <time className={styles.sessionTime} dateTime={session.startedAt}>{sessionDate.format(new Date(session.startedAt))}</time>
                    <span className={styles.rowMetric} aria-label={usage.tokens.value === null ? "Token count unavailable" : `${formatCount(usage.tokens.value)} reported tokens`}>
                      {usage.tokens.value === null ? "—" : formatCount(usage.tokens.value)}
                      {usage.tokens.value !== null && !usage.tokens.complete && <span className={styles.metricNote}>Partial</span>}
                    </span>
                    <span className={styles.rowMetric} aria-label={usage.cost.value === null ? "Estimated cost unavailable" : `${formatCost(usage.cost.value)} estimated cost`}>
                      {usage.cost.value === null ? "—" : formatCost(usage.cost.value)}
                      {usage.cost.value !== null && !usage.cost.complete && <span className={styles.metricNote}>Partial</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className={styles.empty}>
          <p>{hasFilters ? "No matching sessions" : "No sessions yet"}</p>
          {hasFilters ? <Link className={styles.textLink} href={clear}>Clear filters</Link> : (
            <Link href={`/workspace/${id}/settings/uploads#sync-setup`} className={styles.textLink}>Set up sync</Link>
          )}
        </div>
      )}
      {pages > 1 && (
        <nav aria-label="Session pages" className={styles.pagination}>
          <span className={styles.muted}>Page {data.page} of {pages}</span>
          <div>
            {data.page > 1 && <Link href={sessionListHref(id, { ...filters, page: data.page - 1 })} className={styles.control}>Previous</Link>}
            {data.page < pages && <Link href={sessionListHref(id, { ...filters, page: data.page + 1 })} className={styles.control}>Next</Link>}
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
  const unfilteredFirstPage = !sessionHasFilters(filters) && data.page === 1;
  const firstSession = unfilteredFirstPage && !invalid && filters.page === 1 && !filters.sort && data.total === 0
    ? await readWorkspaceAccess(id)
    : null;

  return (
    <main className={styles.page}>
      {firstSession ? <FirstSessionSetup workspace={firstSession} approved={await hasWorkspaceCliApproval(id)} /> : (
        <>
          <header className={styles.headingRow}>
            <h1>Sessions</h1>
            <SessionRefresh label="Refresh sessions" whenIdle={unfilteredFirstPage} />
          </header>
          <Filters key={`${sessionFilterParams(filters)}:${invalid}`} workspaceId={id} filters={filters} data={data} invalid={invalid} />
          <SessionList id={id} filters={filters} data={data} />
        </>
      )}
    </main>
  );
}
