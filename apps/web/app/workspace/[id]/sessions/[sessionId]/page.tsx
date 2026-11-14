import { sessionSourceLabel } from "@tideline/contracts";
import Link from "next/link";
import { parseSessionFilters, sessionListHref } from "../../../../../lib/session-filters";
import { readWorkspaceSession } from "../../../../../lib/workspace";
import { SessionActivity } from "../../activity-summary";
import { RefreshSessions } from "../../refresh-sessions";
import { SessionReview } from "../../session-review";
import { SessionUsage } from "../../usage-summary";

export default async function SessionPage({ params, searchParams }: PageProps<"/workspace/[id]/sessions/[sessionId]">) {
  const { id, sessionId } = await params;
  const session = await readWorkspaceSession(id, sessionId);
  const agent = sessionSourceLabel[session.source];
  const { filters } = parseSessionFilters(await searchParams);

  return (
    <main className="mx-auto w-full max-w-3xl py-8 sm:py-10">
      <RefreshSessions />
      <Link className="text-sm font-medium text-[var(--workspace-accent)] underline underline-offset-4" href={sessionListHref(id, filters)}>
        Back to sessions
      </Link>
      <header className="mt-7 space-y-2 border-b border-[var(--workspace-border)] pb-6">
        <p className="text-sm opacity-75">{agent} session</p>
        <h1 className="text-3xl font-semibold tracking-tight break-words">{session.title}</h1>
        {(session.activity || session.review) && (
          <nav aria-label="Session sections" className="flex flex-wrap gap-x-4 gap-y-2 text-sm underline underline-offset-4">
            {session.activity && <a href="#session-activity">Jump to session activity</a>}
            {session.review && <a href="#session-commits">Git commits</a>}
            {session.review && <a href="#session-safety">Safety findings</a>}
          </nav>
        )}
      </header>
      <SessionUsage analytics={session.analytics} />
      <ol className="mt-8 space-y-4">
        {session.messages.map((message) => (
          <li className="rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-panel)] px-5 py-4" key={message.line}>
            <p className="text-sm font-semibold">{message.role === "user" ? "User" : agent}</p>
            <p className="mt-2 break-words whitespace-pre-wrap">{message.text}</p>
          </li>
        ))}
      </ol>
      <SessionActivity activity={session.activity} />
      <SessionReview review={session.review} />
    </main>
  );
}
