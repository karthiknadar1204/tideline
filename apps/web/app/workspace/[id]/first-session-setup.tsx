import type { WorkspaceAccess } from "@tideline/contracts";
import Link from "next/link";
import { checkoutCli } from "../../../lib/cli-command";
import { teamLink, teamPanel } from "../../../lib/team-ui";
import { CopyTerminalCommand } from "../../copy-terminal-command";
import { RefreshSessions } from "./refresh-sessions";

export function FirstSessionSetup({ workspace }: { workspace: WorkspaceAccess }) {
  const { id, kind } = workspace;
  return (
    <section aria-labelledby="first-session-setup" className="grid gap-6 rounded-2xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,19rem)] lg:gap-10 lg:p-9">
      <div className="min-w-0 space-y-5">
        <div className="space-y-2">
          <h2 id="first-session-setup" className="text-2xl font-semibold tracking-tight">Sync your first session</h2>
          <p className="max-w-xl text-sm leading-relaxed text-[var(--workspace-muted)]">
            Bring in conversations from Codex, Claude Code, Cursor, or OpenCode. This command connects the CLI to this workspace.
          </p>
        </div>
        <div className="space-y-2">
          <p className="text-sm leading-relaxed">Run this from the Tideline checkout. See the <Link href="/docs/get-started" className={teamLink}>setup guide</Link> for prerequisites.</p>
          <CopyTerminalCommand command={`${checkoutCli} onboard --workspace ${id}`} label="Copy setup command" />
        </div>
        <div className="space-y-3 border-t border-[var(--workspace-border)] pt-4 text-sm leading-relaxed">
          <div>
            <h3 className="font-semibold">Choose repositories and approve</h3>
            <p className="mt-1 text-[var(--workspace-muted)]">Review which repositories can upload conversation text and available metadata. Choose whether to include earlier sessions, then approve in the browser with this account.</p>
          </div>
          <p className="text-[var(--workspace-muted)]">
            {kind === "team" ? "Members of this team can read synced sessions." : "Synced sessions stay in your personal workspace until you choose to share one."}
          </p>
        </div>
      </div>
      <div className="min-w-0 space-y-4 lg:self-start">
        <div className={teamPanel}>
          <div className="space-y-2">
            <h3 className="font-semibold">Waiting for the first session</h3>
            <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">This page updates as sessions arrive. If you skipped history, start a new agent session in a selected repository. If you skipped background sync, follow the CLI instructions to start syncing.</p>
          </div>
          <RefreshSessions showButton />
        </div>
        <details className="rounded-xl border border-[var(--workspace-border)] p-4 text-sm">
          <summary className="cursor-pointer font-medium text-[var(--workspace-accent)] focus-visible:outline-2 focus-visible:outline-offset-2">Try a sample session</summary>
          <p className="my-3 leading-relaxed text-[var(--workspace-muted)]">This command uploads a synthetic Codex conversation from the Tideline checkout. Approve the upload in your browser.</p>
          <CopyTerminalCommand command={`${checkoutCli} import packages/test-fixtures/codex/sanitized-session.jsonl --workspace ${id} --sanitized`} label="Copy sample command" />
        </details>
      </div>
    </section>
  );
}
