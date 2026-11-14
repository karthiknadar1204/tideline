"use client";

import { useState } from "react";
import { teamPanel, teamSecondaryButton } from "../../../../lib/team-ui";

export function McpSetup({ workspaceId }: { workspaceId: string }) {
  const command = `codex mcp add tideline -- node --env-file="$PWD/apps/cli/.env.local" "$PWD/apps/cli/dist/index.js" mcp --workspace ${workspaceId}`;
  const [status, setStatus] = useState("");

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus("Copied");
    } catch {
      setStatus("Select the command to copy it.");
    }
  }

  return (
    <section className={teamPanel} aria-labelledby="mcp-setup">
      <h2 className="font-semibold" id="mcp-setup">Connect an agent with MCP</h2>
      <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
        A connected agent can read sessions from this workspace and save analyses under Reports. It uses your CLI sign-in.
      </p>
      <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
        After building the CLI and signing in, run this command from the Tideline checkout to connect Codex.
      </p>
      <code className="block whitespace-pre-wrap rounded-lg bg-[var(--workspace-subtle)] px-3 py-2.5 text-xs leading-relaxed [overflow-wrap:anywhere]">{command}</code>
      <div className="flex flex-wrap items-center gap-3">
        <button className={teamSecondaryButton} type="button" onClick={copyCommand}>Copy Codex setup</button>
        <span role="status" className="text-xs text-[var(--workspace-muted)]">{status}</span>
      </div>
      <details className="border-t border-[var(--workspace-border)] pt-3 text-sm">
        <summary className="cursor-pointer font-medium text-[var(--workspace-muted)] hover:text-[var(--workspace-accent)]">CLI setup and other MCP clients</summary>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--workspace-subtle)] px-3 py-2.5 text-xs leading-relaxed"><code>{"bun run --filter @tideline/cli build\nnode --env-file=apps/cli/.env.local apps/cli/dist/index.js login"}</code></pre>
        <p className="mt-3 leading-relaxed text-[var(--workspace-muted)]">
          For another MCP client, use stdio with the <code className="text-xs">node</code> command shown above. Replace <code className="text-xs">$PWD</code> with the absolute path to the Tideline checkout.
        </p>
      </details>
    </section>
  );
}
