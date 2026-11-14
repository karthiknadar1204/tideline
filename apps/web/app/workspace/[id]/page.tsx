import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { listWorkspaceSessions, requestWorkspace } from "../../../lib/workspace";
import { WorkspaceActivity } from "./activity-summary";
import { RefreshSessions } from "./refresh-sessions";
import { WorkspaceUsage } from "./usage-summary";

export default async function WorkspacePage({ params }: PageProps<"/workspace/[id]">) {
  const { id } = await params;
  const [workspace, sessions] = await Promise.all([
    requestWorkspace(encodeURIComponent(id), "GET"),
    listWorkspaceSessions(id),
  ]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-5 pb-12 sm:px-8">
      <RefreshSessions />
      <header className="flex items-center justify-between border-b border-current/15 py-5">
        <Link className="font-semibold tracking-tight" href="/">Tideline</Link>
        <UserButton />
      </header>
      <div className="space-y-3 pt-16">
        <p className="font-mono text-sm opacity-75">Private workspace</p>
        <h1 className="text-4xl font-semibold tracking-tight">{workspace.name}</h1>
      </div>
      <WorkspaceUsage sessions={sessions} />
      <WorkspaceActivity sessions={sessions} />
      <section className="mt-10 space-y-4" aria-labelledby="sessions">
        <h2 id="sessions" className="text-xl font-semibold">Sessions</h2>
        {sessions.length ? (
          <ul className="divide-y divide-current/15 rounded-lg border border-current/15">
            {sessions.map((session) => (
              <li key={session.id}>
                <Link className="block space-y-1 p-4 hover:bg-current/5" href={`/workspace/${id}/sessions/${session.id}`}>
                  <span className="block font-medium [overflow-wrap:anywhere]">{session.title}</span>
                  <span className="block text-sm opacity-75">
                    {session.source === "claude-code" ? "Claude Code" : "Codex"} · {session.messageCount} {session.messageCount === 1 ? "message" : "messages"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm opacity-75">Imported sessions will appear here.</p>
        )}
      </section>
    </main>
  );
}
