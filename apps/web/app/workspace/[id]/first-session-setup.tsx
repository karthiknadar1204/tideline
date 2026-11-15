import type { WorkspaceAccess } from "@tideline/contracts";
import Link from "next/link";
import { cliInstallCommand } from "../../../lib/cli-install";
import { teamLink } from "../../../lib/team-ui";
import { CopyTerminalCommand } from "../../copy-terminal-command";
import { RefreshSessions } from "./refresh-sessions";

export function FirstSessionSetup({ workspace, approved }: { workspace: WorkspaceAccess; approved: boolean }) {
  const command = cliInstallCommand(workspace.id);
  return (
    <div className="mx-auto max-w-3xl space-y-5 py-4 sm:py-10">
      <RefreshSessions />
      <section aria-labelledby="first-session-title" className="space-y-7 rounded-2xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-5 sm:p-9">
        <header className="space-y-2">
          <h1 id="first-session-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">{approved ? "Your CLI is approved" : "Connect your coding sessions"}</h1>
          <p className="max-w-lg text-sm leading-relaxed text-[var(--workspace-muted)]">
            {approved ? "Your first session will appear here when it finishes syncing." : "Run one command in your terminal to bring sessions into this workspace."}
          </p>
        </header>
        {approved ? (
          <>
            <p className="text-sm leading-relaxed">Start a new session in one of the repositories you selected. If you included history, Tideline will sync those sessions too.</p>
            <details className="space-y-3 text-sm">
              <summary className="w-fit cursor-pointer font-medium text-[var(--workspace-accent)]">Set up another terminal</summary>
              <CopyTerminalCommand command={command} label="Copy setup command" />
            </details>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <CopyTerminalCommand command={command} label="Copy setup command" />
              <p className="text-xs text-[var(--workspace-muted)]">macOS or Linux · Node.js 22.13+ or 24</p>
            </div>
            <ol className="grid gap-5 text-sm sm:grid-cols-2">
              <li className="space-y-1.5">
                <h2 className="font-semibold">1. Choose repositories</h2>
                <p className="text-[var(--workspace-muted)]">Review what will sync. Older conversations are optional.</p>
              </li>
              <li className="space-y-1.5">
                <h2 className="font-semibold">2. Approve in your browser</h2>
                <p className="text-[var(--workspace-muted)]">Use this account. This page updates after you approve.</p>
              </li>
            </ol>
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--workspace-border)] pt-4">
          <span role="status" className="flex items-center gap-2 text-xs font-medium text-[var(--workspace-muted)]">
            <span aria-hidden="true" className={`size-2 rounded-full ${approved ? "bg-[var(--workspace-accent)]" : "border border-current"}`} />
            {approved ? "Waiting for the first session" : "Waiting for CLI approval"}
          </span>
          <Link className={teamLink} href="/docs/cli#troubleshoot">Troubleshoot setup</Link>
        </div>
      </section>
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-1 text-xs text-[var(--workspace-muted)]">
        <p>{workspace.kind === "team" ? "Team members can read sessions synced here." : "Sessions are private to this workspace until you share them."}</p>
        <Link href="/docs/data-and-privacy" className="underline decoration-[var(--workspace-border)] underline-offset-4">What gets uploaded</Link>
      </div>
    </div>
  );
}
