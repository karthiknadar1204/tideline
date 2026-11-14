import { UserButton } from "@clerk/nextjs";
import { sessionSourceLabel } from "@tideline/contracts";
import type { SessionSummary } from "@tideline/contracts";
import Link from "next/link";
import { formatCount } from "../../../lib/usage";
import { listWorkspaceSessions, readWorkspaceUsageTargets, requestWorkspace } from "../../../lib/workspace";
import { WorkspaceActivity } from "./activity-summary";
import { RefreshSessions } from "./refresh-sessions";
import { SyncSetup } from "./sync-setup";
import { UsageTargets } from "./usage-targets";
import { WorkspaceUsage } from "./usage-summary";

const sessionDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

function SessionList({ workspaceId, sessions }: { workspaceId: string; sessions: SessionSummary[] }) {
  return (
    <section className="space-y-4" aria-labelledby="sessions">
      <div className="flex items-baseline gap-3">
        <h2 id="sessions" className="scroll-mt-6 text-xl font-semibold">Sessions</h2>
        <span className="text-sm tabular-nums text-[var(--workspace-muted)]">{formatCount(sessions.length)}</span>
      </div>
      {sessions.length ? (
        <ul className="divide-y divide-[var(--workspace-border)] overflow-hidden rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)]">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link
                className="block space-y-2 px-4 py-3.5 hover:bg-[var(--workspace-subtle)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--workspace-accent)] sm:px-5"
                href={`/workspace/${workspaceId}/sessions/${session.id}`}
              >
                <span className="block font-medium [overflow-wrap:anywhere]">{session.title}</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[var(--workspace-muted)]">
                  <span className="rounded-md bg-[var(--workspace-accent-soft)] px-2 py-0.5 font-medium text-[var(--workspace-accent)]">
                    {sessionSourceLabel[session.source]}
                  </span>
                  {session.analytics?.repository && (
                    <span className="break-all font-mono">{session.analytics.repository.name}</span>
                  )}
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
        <p className="rounded-xl border border-dashed border-[var(--workspace-border)] px-5 py-8 text-sm text-[var(--workspace-muted)]">
          Set up sync to see your first session here.
        </p>
      )}
    </section>
  );
}

export default async function WorkspacePage({ params }: PageProps<"/workspace/[id]">) {
  const { id } = await params;
  const [workspace, sessions, targets] = await Promise.all([
    requestWorkspace(encodeURIComponent(id), "GET"),
    listWorkspaceSessions(id),
    readWorkspaceUsageTargets(id),
  ]);

  return (
    <main className="tideline-workspace min-h-dvh bg-[var(--workspace-bg)] text-[var(--workspace-text)]">
      <RefreshSessions />
      <div className="mx-auto w-full max-w-7xl px-5 pb-16 sm:px-8 lg:px-12">
        <header className="flex items-center justify-between border-b border-[var(--workspace-border)] py-4">
          <Link className="font-semibold tracking-tight" href="/">Tideline</Link>
          <UserButton />
        </header>
        <div className="space-y-2 py-8 sm:py-11">
          <p className="text-sm font-medium text-[var(--workspace-muted)]">Private workspace</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{workspace.name}</h1>
        </div>
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_19rem] xl:gap-10">
          <div className="min-w-0 lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1">
            <SyncSetup workspaceId={id} />
            <nav className="flex flex-wrap gap-4 px-1 pt-4 text-sm text-[var(--workspace-muted)]" aria-label="Workspace sections">
              <a className="hover:text-[var(--workspace-accent)] hover:underline" href="#sessions">Sessions</a>
              <a className="hover:text-[var(--workspace-accent)] hover:underline" href="#usage-overview">Usage</a>
              <a className="hover:text-[var(--workspace-accent)] hover:underline" href="#workspace-activity">Activity</a>
            </nav>
          </div>
          <div className="min-w-0 lg:col-start-1 lg:row-start-1">
            <SessionList workspaceId={id} sessions={sessions} />
            <WorkspaceUsage sessions={sessions} />
            <UsageTargets workspaceId={id} targets={targets} sessions={sessions} />
            <WorkspaceActivity sessions={sessions} />
          </div>
        </div>
      </div>
    </main>
  );
}
