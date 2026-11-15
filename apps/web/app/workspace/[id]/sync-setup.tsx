import Link from "next/link";
import { cliInstallCommand } from "../../../lib/cli-install";
import { teamLink } from "../../../lib/team-ui";
import { CopyTerminalCommand } from "../../copy-terminal-command";

export function SyncSetup({ workspaceId }: { workspaceId: string }) {
  return (
    <section aria-labelledby="sync-setup" className="space-y-3 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-5">
      <h2 id="sync-setup" className="font-semibold">Sync from your computer</h2>
      <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
        Install the CLI and connect it to this workspace. Run the command in your terminal.
      </p>
      <CopyTerminalCommand command={cliInstallCommand(workspaceId)} label="Copy setup command" />
      <Link className={teamLink} href="/docs/cli">CLI commands and sync</Link>
    </section>
  );
}
