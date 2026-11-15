import type { WorkspaceAccess } from "@tideline/contracts";
import Link from "next/link";
import { cliInstallCommand } from "../../../lib/cli-install";
import { teamLink } from "../../../lib/team-ui";
import { PairedCliSetup } from "./paired-cli-setup";
import { RefreshSessions } from "./refresh-sessions";

export function FirstSessionSetup({ workspace, approved }: { workspace: WorkspaceAccess; approved: boolean }) {
  return (
    <div className="mx-auto max-w-3xl space-y-4 py-6 sm:py-12">
      <RefreshSessions />
      <section aria-labelledby="first-session-title" className="space-y-6 rounded-2xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-5 sm:p-8">
        <header className="space-y-2">
          <h1 id="first-session-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">Connect your coding sessions</h1>
          <p className="max-w-lg text-sm leading-relaxed text-[var(--workspace-muted)]">
            {approved ? "A CLI is approved for this workspace. Start a session in a selected repository or connect another computer." : "Run a command in your terminal, choose repositories, and watch your setup progress here."}
          </p>
        </header>
        <PairedCliSetup workspaceId={workspace.id} fallbackCommand={cliInstallCommand(workspace.id)} />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--workspace-border)] pt-4 text-xs text-[var(--workspace-muted)]">
          <span>macOS or Linux · Node.js 22.13+ or 24</span>
          <Link className={teamLink} href="/docs/cli#troubleshoot">Troubleshoot setup</Link>
        </div>
      </section>
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-1 text-xs text-[var(--workspace-muted)]">
        <p>{workspace.kind === "team" ? "Team members can read sessions synced here." : "Sessions are private to this workspace until you share them."}</p>
        <Link href="/docs/data-and-privacy" className="underline underline-offset-4">What gets uploaded</Link>
      </div>
    </div>
  );
}
