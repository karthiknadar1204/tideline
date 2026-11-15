import Link from "next/link";
import { teamLink, teamPanel } from "../../../../lib/team-ui";
import { CopyTerminalCommand } from "../../../copy-terminal-command";

export function McpSetup({ workspaceId }: { workspaceId: string }) {
  const command = `codex mcp add tideline -- "$HOME/.local/bin/tideline" mcp --workspace ${workspaceId}`;

  return (
    <section className={teamPanel} aria-labelledby="mcp-setup">
      <h2 className="font-semibold" id="mcp-setup">Connect an agent with MCP</h2>
      <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
        A connected agent can read sessions and save reports in this workspace. Install the CLI and run <code>tideline login</code> before connecting Codex.
      </p>
      <CopyTerminalCommand command={command} label="Copy Codex setup" />
      <Link className={teamLink} href="/docs/mcp">MCP setup guide</Link>
    </section>
  );
}
