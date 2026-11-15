import Link from "next/link";
import { cliInstallCommand } from "../../../lib/cli-install";
import { teamLink, teamPanel } from "../../../lib/team-ui";
import { PairedCliSetup } from "./paired-cli-setup";

export function SyncSetup({ workspaceId }: { workspaceId: string }) {
  return (
    <section aria-labelledby="sync-setup" className={teamPanel}>
      <div className="space-y-1">
        <h2 id="sync-setup" className="font-semibold">Connect a computer</h2>
        <p className="text-sm text-[var(--workspace-muted)]">Install the CLI, choose repositories, and approve the connection in your browser.</p>
      </div>
      <PairedCliSetup workspaceId={workspaceId} fallbackCommand={cliInstallCommand(workspaceId)} />
      <Link className={teamLink} href="/docs/cli">CLI commands and sync</Link>
    </section>
  );
}
