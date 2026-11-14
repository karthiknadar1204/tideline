"use client";

import { useState } from "react";

export function SyncSetup({ workspaceId }: { workspaceId: string }) {
  const command = `node --env-file=apps/cli/.env.local apps/cli/dist/index.js sync setup --workspace ${workspaceId}`;
  const [copyStatus, setCopyStatus] = useState<"ready" | "copied" | "manual">("ready");

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("manual");
    }
  }

  return (
    <section aria-labelledby="sync-setup" className="space-y-3 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-5">
      <h2 id="sync-setup" className="font-semibold">Sync from your computer</h2>
      <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
        Run this in the Tideline checkout. Choose repositories, decide whether to include older sessions, and approve in your browser.
      </p>
      <div className="space-y-2">
        <code className="block whitespace-pre-wrap rounded-lg bg-[var(--workspace-subtle)] px-3 py-2.5 text-xs leading-relaxed [overflow-wrap:anywhere]">
          {command}
        </code>
        <button
          type="button"
          onClick={copyCommand}
          className="rounded-md border border-[var(--workspace-border)] px-3 py-1.5 text-xs font-medium text-[var(--workspace-accent)] hover:bg-[var(--workspace-accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)]"
        >
          Copy command
        </button>
        <span role="status" className="ml-2 text-xs text-[var(--workspace-muted)]">
          {copyStatus === "copied" ? "Copied" : copyStatus === "manual" ? "Select the command to copy it." : ""}
        </span>
      </div>
      <details className="border-t border-[var(--workspace-border)] pt-3 text-sm">
        <summary className="cursor-pointer font-medium text-[var(--workspace-muted)] hover:text-[var(--workspace-accent)]">Setup and sync options</summary>
        <p className="mt-2 leading-relaxed text-[var(--workspace-muted)]">
          Build the CLI first with <code className="text-xs [overflow-wrap:anywhere]">bun run --filter @tideline/cli build</code>. On Linux, add <code className="text-xs">--credential-file</code> to setup.
        </p>
        <p className="mt-2 leading-relaxed text-[var(--workspace-muted)]">
          Choose background sync to keep it running after closing the terminal. Use <code className="text-xs">sync status</code> on this computer to check progress.
        </p>
      </details>
    </section>
  );
}
