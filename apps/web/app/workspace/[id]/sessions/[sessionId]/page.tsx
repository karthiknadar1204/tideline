import { sessionSourceLabel, WORKSPACE_SESSION_PAGE_SIZE } from "@tideline/contracts";
import type { SessionDetail, WorkspaceSessionSearchQuery } from "@tideline/contracts";
import Link from "next/link";
import { Suspense } from "react";
import { parseSessionFilters, sessionDetailHref, sessionListHref } from "../../../../../lib/session-filters";
import { readSessionShare } from "../../../../../lib/session-shares";
import { formatCost, formatCount, summarizeSession } from "../../../../../lib/usage";
import { readWorkspaceAccess, readWorkspaceSession, searchWorkspaceSessions } from "../../../../../lib/workspace";
import { SessionReview } from "../../session-review";
import { SessionUsage } from "../../usage-summary";
import { SessionRefresh } from "../session-refresh";
import styles from "../sessions.module.css";
import { SessionFiles, SessionSetup } from "./capture";
import { DeleteSessionButton } from "./delete-session-button";
import { SessionReader } from "./reader";
import { SessionShare } from "./session-share";
import { SessionSubagents } from "./subagents";
import { FullTranscript } from "./full-transcript";
import { SessionGitHubEvidence } from "./github-evidence";
import { buildSessionTimeline } from "./timeline";

const startedDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

async function SessionNavigation({ workspaceId, sessionId, filters }: {
  workspaceId: string;
  sessionId: string;
  filters: WorkspaceSessionSearchQuery;
}) {
  const list = await searchWorkspaceSessions(workspaceId, filters);
  const position = list.sessions.findIndex(({ id }) => id === sessionId);
  if (position < 0) return null;

  let previous = list.sessions[position - 1];
  let next = list.sessions[position + 1];
  let previousPage = list.page;
  let nextPage = list.page;
  if (position === 0 && list.page > 1) {
    const other = await searchWorkspaceSessions(workspaceId, { ...filters, page: list.page - 1 });
    previous = other.sessions[other.sessions.length - 1];
    previousPage = other.page;
  }
  if (position === list.sessions.length - 1 && list.page * WORKSPACE_SESSION_PAGE_SIZE < list.total) {
    const other = await searchWorkspaceSessions(workspaceId, { ...filters, page: list.page + 1 });
    next = other.sessions[0];
    nextPage = other.page;
  }
  if (!previous && !next) return null;

  return (
    <nav className={styles.readerLinks} aria-label="Session navigation">
      {previous && <Link aria-label="Previous session" title="Previous session" href={sessionDetailHref(workspaceId, previous.id, { ...filters, page: previousPage })} prefetch={false}>←</Link>}
      {next && <Link aria-label="Next session" title="Next session" href={sessionDetailHref(workspaceId, next.id, { ...filters, page: nextPage })} prefetch={false}>→</Link>}
    </nav>
  );
}

function ContextStats({ session, workspaceId, filters }: {
  session: SessionDetail;
  workspaceId: string;
  filters: WorkspaceSessionSearchQuery;
}) {
  const { tokens, cost } = summarizeSession(session.analytics);
  const models = session.analytics?.models.flatMap(({ model }) => model ? [model] : []) ?? [];

  return (
    <section className={styles.contextSection} aria-labelledby="context-stats">
      <h2 id="context-stats">Session stats</h2>
      <dl>
        <div className={styles.contextPair}><dt>Messages</dt><dd>{formatCount(session.messageCount)}</dd></div>
        {session.activity && (
          <>
            <div className={styles.contextPair}><dt>Tool calls</dt><dd>{formatCount(session.activity.tools.length)}</dd></div>
            <div className={styles.contextPair}><dt>Skills</dt><dd>{formatCount(session.activity.skills.length)}</dd></div>
            <div className={styles.contextPair}><dt>Subagents</dt><dd>{formatCount(session.activity.children.length)}</dd></div>
          </>
        )}
        <div className={styles.contextPair}>
          <dt>Tokens</dt>
          <dd>{tokens.value === null ? "Unavailable" : formatCount(tokens.value)}
            {tokens.value !== null && !tokens.complete && <span className={styles.metricNote}>Partial</span>}
          </dd>
        </div>
        <div className={styles.contextPair}>
          <dt>Est. cost</dt>
          <dd>{cost.value === null ? "Unavailable" : formatCost(cost.value)}
            {cost.value !== null && !cost.complete && <span className={styles.metricNote}>Partial</span>}
          </dd>
        </div>
      </dl>
      {!!models.length && (
        <ul aria-label="Session models" className={styles.contextModels}>
          {models.slice(0, 4).map((model) => (
            <li key={model}><Link className={styles.textLink} href={sessionListHref(workspaceId, { ...filters, model, page: 1 })}>{model}</Link></li>
          ))}
          {models.length > 4 && <li className={styles.muted}>View all models in Usage.</li>}
        </ul>
      )}
    </section>
  );
}

export default async function SessionPage({ params, searchParams }: PageProps<"/workspace/[id]/sessions/[sessionId]">) {
  const { id, sessionId } = await params;
  const { filters } = parseSessionFilters(await searchParams);
  const [workspace, session] = await Promise.all([
    readWorkspaceAccess(id),
    readWorkspaceSession(id, sessionId),
  ]);
  const mayShare = workspace.role === "owner" || workspace.role === "admin";
  const share = mayShare ? await readSessionShare(id, sessionId) : undefined;
  const lastMessage = session.messages.at(-1);
  const agent = sessionSourceLabel[session.source];
  const repo = session.analytics?.repository;
  const context = (
    <>
      <ContextStats session={session} workspaceId={id} filters={filters} />
      {mayShare && lastMessage && <SessionShare
        workspaceId={id}
        sessionId={sessionId}
        displayed={{ messageCount: session.messageCount, lastMessageLine: lastMessage.line }}
        status={share}
      />}
      {mayShare && <DeleteSessionButton workspaceId={id} sessionId={sessionId} filters={filters} />}
    </>
  );

  return (
    <main className={styles.page}>
      <header className={styles.readerHeader}>
        <div className="min-w-0">
          <nav aria-label="Session path" className={styles.readerPath}>
            <Link className={styles.textLink} href={sessionListHref(id, filters)}>Back to sessions</Link>
            {repo && (
              <>
                <span aria-hidden="true">/</span>
                <Link className={styles.textLink} href={`/workspace/${id}/repositories?${new URLSearchParams({ repository: repo.key })}`}>{repo.name}</Link>
              </>
            )}
          </nav>
          <h1 className={styles.readerTitle}>{session.title}</h1>
          <div className={styles.readerMeta}>
            <span className={styles.agent}>{agent}</span>
            <time dateTime={session.startedAt}>{startedDate.format(new Date(session.startedAt))} UTC</time>
          </div>
        </div>
        <div className={styles.readerLinks}>
          <Suspense fallback={null}><SessionNavigation workspaceId={id} sessionId={sessionId} filters={filters} /></Suspense>
          <SessionRefresh label="Refresh session" whenIdle />
        </div>
      </header>
      <SessionReader
        key={session.id}
        {...buildSessionTimeline(session, agent, session.capture)}
        context={context}
        panels={{
          transcript: <FullTranscript url={`/workspace/${id}/sessions/${sessionId}/transcript`} />,
          subagents: <SessionSubagents session={session} capture={session.capture} />,
          files: <SessionFiles capture={session.capture} source={session.source} />,
          setup: <SessionSetup capture={session.capture} session={session} />,
          usage: <SessionUsage analytics={session.analytics} />,
          review: (
            <>
              <SessionReview review={session.review} />
              <Suspense fallback={null}>
                <div className="mt-8"><SessionGitHubEvidence workspaceId={id} sessionId={sessionId} review={session.review} /></div>
              </Suspense>
            </>
          ),
        }}
      />
    </main>
  );
}
