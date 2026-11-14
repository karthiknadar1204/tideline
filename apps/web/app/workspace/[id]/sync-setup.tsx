import { CopyTerminalCommand } from "./copy-terminal-command";

export function SyncSetup({ workspaceId }: { workspaceId: string }) {
  return (
    <section aria-labelledby="sync-setup" className="space-y-3 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-5">
      <h2 id="sync-setup" className="font-semibold">Sync from your computer</h2>
      <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
        Run this in the Tideline checkout. Choose repositories, decide whether to include older sessions, and approve in your browser.
      </p>
      <CopyTerminalCommand command={`onboard --workspace ${workspaceId}`} label="Copy command" />
      <details className="border-t border-[var(--workspace-border)] pt-3 text-sm">
        <summary className="cursor-pointer font-medium text-[var(--workspace-muted)] hover:text-[var(--workspace-accent)]">Setup and sync options</summary>
        <p className="mt-2 leading-relaxed text-[var(--workspace-muted)]">
          Build the CLI first with <code className="text-xs [overflow-wrap:anywhere]">bun run --filter @tideline/cli build</code>.
        </p>
        <p className="mt-2 leading-relaxed text-[var(--workspace-muted)]">
          Choose background sync to keep it running after closing the terminal. Use <code className="text-xs">sync status</code> to check progress and <code className="text-xs">sync setup</code> to change your selection.
        </p>
      </details>
    </section>
  );
}
