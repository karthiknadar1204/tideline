import Link from "next/link";
import { readWorkspaceSession } from "../../../../../lib/workspace";
import { SessionUsage } from "../../usage-summary";

export default async function SessionPage({ params }: PageProps<"/workspace/[id]/sessions/[sessionId]">) {
  const { id, sessionId } = await params;
  const session = await readWorkspaceSession(id, sessionId);
  const agent = session.source === "claude-code" ? "Claude Code" : "Codex";

  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-5 py-12 sm:px-8">
      <Link className="text-sm underline underline-offset-4" href={`/workspace/${id}`}>
        Back to workspace
      </Link>
      <header className="mt-10 space-y-2 border-b border-current/15 pb-6">
        <p className="text-sm opacity-75">{agent} session</p>
        <h1 className="text-3xl font-semibold tracking-tight break-words">{session.title}</h1>
      </header>
      <SessionUsage analytics={session.analytics} />
      <ol className="mt-8 space-y-4">
        {session.messages.map((message) => (
          <li className="rounded-lg border border-current/15 px-5 py-4" key={message.line}>
            <p className="text-sm font-semibold">{message.role === "user" ? "User" : agent}</p>
            <p className="mt-2 break-words whitespace-pre-wrap">{message.text}</p>
          </li>
        ))}
      </ol>
    </main>
  );
}
