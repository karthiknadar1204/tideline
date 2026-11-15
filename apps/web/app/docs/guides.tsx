import Link from "next/link";
import { cliInstallCommand } from "../../lib/cli-install";
import { CopyTerminalCommand } from "../copy-terminal-command";
import styles from "./docs.module.css";

function GetStarted() {
  return (
    <>
      <section aria-labelledby="prepare-cli">
        <h2 id="prepare-cli">Install the CLI</h2>
        <p>Use macOS or Linux with Node.js 22.13 or later within Node 22, or Node 24. Run this command in your terminal to install Tideline and open the repository picker.</p>
        <CopyTerminalCommand command={cliInstallCommand()} label="Copy install command" />
        <p>To connect to a specific workspace, open its <strong>Dashboard</strong> or <strong>Sync setup</strong> and select <strong>Copy setup command</strong>. Paste the command into your terminal. You can follow setup progress in the browser.</p>
      </section>
      <section aria-labelledby="first-session">
        <h2 id="first-session">Sync your first session</h2>
        <ol>
          <li>Type to filter the repository picker. Use the arrow keys to move, <kbd>Tab</kbd> to select, and <kbd>Enter</kbd> to continue.</li>
          <li>Review your selection and confirm. The suggested setup imports saved sessions and starts background sync with agent hooks. Select <strong>Customize setup</strong> to change these options or include more session details.</li>
          <li>Approve the connection in the browser with the account that opened workspace setup. The setup page switches to your dashboard once the first session is ready.</li>
          <li>If you skipped older sessions, start a new agent session in a selected repository. The dashboard lists the session after processing.</li>
        </ol>
        <p>If you skipped background sync, run <code>tideline sync run</code> to keep syncing in your current terminal.</p>
      </section>
      <p className="mt-5">If your session is missing, see <Link href="/docs/cli#troubleshoot">Troubleshoot sync</Link>.</p>
    </>
  );
}

function CliGuide() {
  return (
    <>
      <section aria-labelledby="run-command">
        <h2 id="run-command">Run a command</h2>
        <p><Link href="/docs/get-started#prepare-cli">Install Tideline</Link>, then run <code>tideline</code> followed by a command. Add <code>--help</code> to see the command’s flags.</p>
        <CopyTerminalCommand command="tideline --help" label="Copy CLI help command" />
        <p>If your terminal cannot find <code>tideline</code>, run it as <code>~/.local/bin/tideline</code> or add <code>~/.local/bin</code> to your <code>PATH</code>.</p>
        <p>Use <code>tideline --version</code> to see the installed version. Run <code>tideline update --check</code> to review the available release, or <code>tideline update</code> to install it after confirmation.</p>
      </section>
      <section aria-labelledby="account">
        <h2 id="account">Account and workspace</h2>
        <CommandTable rows={[
          ["login", "Approve the CLI in your browser for commands like pull and MCP."],
          ["logout", "Revoke the CLI credential and any local collector for the same workspace."],
          ["whoami", "Show the signed-in account, workspace, and upload failures."],
          ["workspace list", "List the personal and team workspaces you can access."],
          ["workspace show", "Show the selected workspace. Use --workspace to look up a different one."],
          ["workspace use <id>", "Select the workspace for queries and new collectors. set-org <id> does the same."],
          ["doctor", "Check sign-in, API connectivity, local agent storage, and sync."],
        ]} />
        <p>Use <code>--json</code> with <code>whoami</code>, <code>doctor</code>, <code>workspace list</code>, or <code>workspace show</code> for machine-readable output. Use <code>--no-browser</code> on <code>login</code> or <code>onboard</code> to open the approval link yourself.</p>
      </section>
      <section aria-labelledby="sync">
        <h2 id="sync">Control sync</h2>
        <CommandTable rows={[
          ["onboard", "Choose repositories, approve them, and get a dashboard link. Use the command from your workspace to follow setup progress in the browser."],
          ["sync setup", "Change which repositories upload. Clear the selection to pause uploads for all repositories after confirmation."],
          ["sync run", "Sync in the current terminal."],
          ["sync once", "Scan and upload approved sessions once, then exit."],
          ["sync start / sync stop", "Start or stop background sync."],
          ["sync autostart enable | status | disable", "Manage automatic startup on macOS or Linux with systemd. Use the installed CLI."],
          ["sync status", "Show selected repositories and upload status."],
          ["sync retry / upload --retry", "Retry queued or failed uploads from approved repositories."],
          ["sync revoke", "End the collector’s authorization. Run onboard again to connect it to a different workspace."],
        ]} />
        <p><code>connect</code>, <code>enable</code>, <code>disable</code>, and <code>upload</code> also open the repository picker. To select folders in a script, pass <code>--project /path/to/repository --conversations</code>. Add <code>--history</code> for older sessions or <code>--background</code> to start sync immediately.</p>
        <p>To include recorded files, setup, and tool details for Codex and Claude Code, run <code>tideline sync setup --session-details</code>. Add <code>--history</code> if you also want to collect these details from older sessions in the repositories you select.</p>
        <p>With session details enabled, add <code>--subagent-transcripts</code> to collect bounded excerpts of linked Codex and Claude Code child conversations up to four levels deep. You can read them in the parent session’s <strong>Subagents</strong> tab.</p>
        <p>Add <code>--hooks</code> to install Codex and Claude Code hooks that wake a running collector. Review them with <code>tideline hooks status</code>. If Codex prompts for trust, review the new Tideline commands in Codex’s <code>/hooks</code> menu. Run <code>tideline hooks remove</code> to remove them.</p>
        <p>Add <code>--full-transcripts</code> to sync the redacted Codex and Claude Code JSONL logs and supported embedded images. Keep <code>--session-details</code> and <code>--subagent-transcripts</code> enabled to add separate streams for verified child agents. Open <strong>Transcript</strong> in the session to read them.</p>
        <p>Add <code>--repository-instructions</code> to sync supported instruction files from the selected Git checkouts. Add <code>--repository-context</code> to sync redacted skill and agent definitions, tracked change counts, and metadata for agent, package, and skill files. JSON configurations can include counts of configured MCP servers, dependencies, or scripts. Open a repository’s <strong>Context</strong> tab to view the snapshot.</p>
      </section>
      <section aria-labelledby="import-export">
        <h2 id="import-export">Import, export, and query</h2>
        <CommandTable rows={[
          ["import <file> --workspace <id> --dry-run", "Preview a single sanitized Codex JSONL file. Use --source claude-code for a Claude Code log. Review the file and use --sanitized to upload it."],
          ["report link <report-id> <session-id>", "Cite a synced session in a report you authored in the same workspace. Use --source with a native agent session ID."],
          ["import <session-id> --analysis <report-id> --sanitized", "Import and cite a local Codex or Claude Code session by its native ID. Review the session before passing --sanitized and approve the upload in your browser."],
          ["import <session-id> --analysis <report-id> --sanitized --follow", "Sync new conversation messages from that Codex or Claude Code session for seven days. Follow-up stays in the report’s workspace and redacts supported secret patterns."],
          ["report sync", "Check every approved report conversation for new messages now."],
          ["pull --repo my-repo --out ./tideline-export", "Save matching conversations as JSONL files with a local manifest."],
          ['count "test failed" --in ./tideline-export', "Count matching messages in a local export. Use --unit session to count conversations."],
          ['sql "SELECT source, count(*) FROM sessions GROUP BY source"', "Query synced records with read-only SQLite. Use --in for a local export or --out for a new CSV or JSONL file."],
        ]} />
        <p>Run <code>login</code> before querying the workspace. <code>pull</code>, <code>count</code>, and <code>sql</code> accept <code>--repo</code>, <code>--source</code>, <code>--from</code>, and <code>--to</code>. Dates are inclusive UTC days in <code>YYYY-MM-DD</code> format. SQL tables include <code>sessions</code>, <code>messages</code>, <code>models</code>, <code>activity</code>, <code>commits</code>, and <code>safety_findings</code>.</p>
        <p>Add <code>--details</code> to <code>pull</code> or live <code>sql</code> to include captured tool text, diffs, and setup. Use <code>--pattern</code> to match a regular expression. Regex counts use the latest default pull when available. Pass <code>--live</code> to query the workspace or <code>--in</code> to select a local export.</p>
        <p>Add <code>--transcripts</code> to <code>pull</code> to also save the archived JSONL and embedded images for matching sessions.</p>
        <p>Count tool calls with <code>--unit call</code> and narrow the match with <code>--field tool-input</code> or <code>--field tool-output</code>. SQL tables for details include <code>calls</code>, <code>prompts</code>, <code>agent_runs</code>, <code>agent_messages</code>, <code>file_changes</code>, and <code>session_setup</code>.</p>
        <p>Run <code>tideline github sync</code> from a GitHub checkout to import recent merged PRs and GitHub Actions runs. Sign in first with <code>gh auth login</code>. Open <strong>Reports → GitHub</strong> to browse the imported activity. In a session’s <strong>Review</strong> tab, open the pull requests, workflow runs, and CI jobs tied to its verified commits.</p>
        <p>To keep GitHub activity updated automatically, run <code>tideline sync setup --github-activity</code> and select your checkouts. GitHub credentials stay in your local <code>gh</code> installation. Run setup with <code>--no-github-activity</code> to turn it off.</p>
        <p>Open <strong>Reports → Trends</strong> to compare completed UTC date ranges. Use the filters to compare an agent or repository, then open the sessions behind recorded failures or frustration.</p>
        <p>Open <strong>Reports → Session intelligence</strong> to find recurring failures, common error reasons, and explicit feedback. Each pattern shows affected sessions and recorded events for both periods. Select an example to open its original message or tool call.</p>
      </section>
      <section aria-labelledby="troubleshoot">
        <h2 id="troubleshoot">Troubleshoot sync</h2>
        <ul>
          <li><strong>No repositories appear.</strong> Start a session in Codex, Claude Code, Cursor, or OpenCode. Run <code>doctor</code> to check local agent storage.</li>
          <li><strong>A session is missing.</strong> Check the repository and collector state with <code>sync status</code>. If you skipped history, start a new session or enable history through <code>sync setup</code>. Remove active dashboard filters before checking again.</li>
          <li><strong>Background sync is stopped.</strong> Run <code>sync start</code>. After a failed upload, check the cause and run <code>sync retry</code>.</li>
          <li><strong>Approval expired.</strong> Run <code>login</code> to renew a CLI login. If your sync collector’s approval expired, run <code>sync revoke</code> followed by <code>onboard</code> to approve it again.</li>
        </ul>
      </section>
    </>
  );
}

function Dashboard() {
  return (
    <>
      <section aria-labelledby="workspace-activity">
        <h2 id="workspace-activity">Explore workspace activity</h2>
        <p>In <strong>Dashboard</strong>, choose a metric, date range, or agent. Select a chart bar to open its sessions. Use <strong>Repositories</strong> to see one repository at a time, and <strong>Skills</strong> or <strong>MCP</strong> to see recorded usage and jump to the latest matching session.</p>
      </section>
      <section aria-labelledby="sessions">
        <h2 id="sessions">Find and read sessions</h2>
        <p>A session is a coding conversation saved by an agent. Open <strong>Sessions</strong> to search its title or text. Filter by repository and agent, or expand <strong>More filters</strong> for model and UTC dates.</p>
        <p>Open a session to read the conversation and any recorded tool calls, skills, and child agent runs. A tool marked <strong>Returned</strong> produced a result. Its child agent can still be running. Tideline shows the last status recorded in the parent session.</p>
        <p>When session details are enabled, expand a tool in <strong>Timeline</strong> to read its recorded input and output. Open <strong>Files</strong> for diffs recorded by the agent, or <strong>Setup</strong> for available runtime settings.</p>
        <p>Open <strong>Transcript</strong> to inspect redacted source records beyond the conversation view. You can download the JSONL or individual images from this view.</p>
        <p>When the collector can verify a commit reported in the session, the session shows its SHA and a link for GitHub or GitLab origins. Safety findings show the rule and log line for a possible credential or risky command. Review the finding in context.</p>
      </section>
      <section aria-labelledby="reports">
        <h2 id="reports">Read usage reports</h2>
        <p>In <strong>Reports</strong>, choose a period, agent, or repository, then select <strong>Apply</strong>. Use <strong>Download CSV</strong> to export that view. Model and repository breakdowns use the usage the agent reported.</p>
        <p>Estimated cost uses standard API token rates. <strong>Partial</strong> shows the portion Tideline can count or price. <strong>Unavailable</strong> appears when a number cannot be calculated. Subscription charges and discounts can differ from the estimate.</p>
      </section>
      <section aria-labelledby="budgets">
        <h2 id="budgets">Set a budget or goal</h2>
        <p>Workspace admins and owners can open <strong>Settings</strong> → <strong>Usage limits</strong> to set a monthly estimated spend budget, plus a weekly or monthly goal for tokens or estimated spend. Goals can cover all agents or one agent.</p>
        <p>Periods use UTC and weeks start on Monday. Tideline puts each session in the period in which it started. Budgets and goals display progress in the dashboard.</p>
      </section>
      <section aria-labelledby="teams">
        <h2 id="teams">Work with a team</h2>
        <p>Open <strong>Workspaces</strong> and use <strong>New team workspace</strong> to create one. Owners and admins can invite people from <strong>Members</strong>. Send the invitation link to the teammate. To accept within seven days, they sign in with the verified email address you invited.</p>
        <p>Members can read and sync sessions and read reports. Admins can also manage settings, invitations, members, and session sharing. Owners can assign the admin role.</p>
      </section>
      <section aria-labelledby="sharing">
        <h2 id="sharing">Share a conversation</h2>
        <p>As an owner or admin, open the session and review the conversation. Use <strong>Share session</strong> to create a snapshot link. Anyone with the link can read the snapshot. Later messages remain in the workspace. Revoke the link from the same session to end access.</p>
      </section>
    </>
  );
}

function McpGuide() {
  return (
    <>
      <section aria-labelledby="connect">
        <h2 id="connect">Connect Codex</h2>
        <ol>
          <li><Link href="/docs/get-started#prepare-cli">Install the CLI</Link>. Run the login command and approve it in your browser.</li>
          <li>Open <strong>Settings</strong> → <strong>Integrations</strong> in the workspace your agent should use. Select <strong>Copy Codex setup</strong>.</li>
          <li>Run the copied command in your terminal, then start a new Codex session.</li>
        </ol>
        <CopyTerminalCommand command="tideline login" label="Copy sign-in command" />
      </section>
      <section aria-labelledby="other-clients">
        <h2 id="other-clients">Connect another MCP client</h2>
        <p>Configure the client to run Tideline over stdio. Use the absolute path to the installed CLI and the workspace ID from its URL.</p>
        <div className={styles.snippet}><code>{"$HOME/.local/bin/tideline mcp --workspace WORKSPACE_ID"}</code></div>
        <p>Each MCP connection uses the CLI login and the workspace in its command. Run <code>logout</code> to revoke that CLI login.</p>
      </section>
      <section aria-labelledby="tools">
        <h2 id="tools">Query sessions and save reports</h2>
        <CommandTable heading="Tool" rows={[
          ["search_sessions", "Find sessions by title or transcript text, with agent, repository, model, and date filters."],
          ["get_session", "Read session metadata and conversation excerpts. Request details to include activity and safety information where available."],
          ["save_report", "Save a Markdown report with optional links to source sessions in the connected workspace."],
        ]} />
        <p>Ask the agent to save a report when you want it in <strong>Reports</strong> → <strong>Saved reports</strong>. Reports are private by default. Ask for workspace visibility to share a report with team members.</p>
      </section>
    </>
  );
}

function DataAndPrivacy() {
  return (
    <>
      <section aria-labelledby="local-sources">
        <h2 id="local-sources">Where the CLI finds sessions</h2>
        <table className={styles.table}>
          <thead><tr><th scope="col">Agent</th><th scope="col">Local source</th></tr></thead>
          <tbody>
            <tr><th scope="row">Codex</th><td>Session JSONL files under <code>~/.codex</code>, or <code>CODEX_HOME</code> if set.</td></tr>
            <tr><th scope="row">Claude Code</th><td>Project JSONL files under <code>~/.claude/projects</code>, or <code>projects</code> within <code>CLAUDE_CONFIG_DIR</code>.</td></tr>
            <tr><th scope="row">Cursor</th><td>Local IDE SQLite data for single-folder workspaces. Set <code>TIDELINE_CURSOR_USER_DIR</code> to choose a different Cursor User directory.</td></tr>
            <tr><th scope="row">OpenCode</th><td>Local session databases. Set <code>OPENCODE_DB</code> if OpenCode uses a custom database file.</td></tr>
          </tbody>
        </table>
      </section>
      <section aria-labelledby="uploads">
        <h2 id="uploads">What uploads contain</h2>
        <p>The CLI sends user and assistant conversation text from approved repositories and any supported metadata. That can include a repository name, agent, model, usage, tool names and status, skill names, child run status, verified commits, and safety findings. The fields depend on the agent and its saved records.</p>
        <p>Cursor sends conversation and repository data and available model names. OpenCode can also include reported token counts. Tideline currently shows cost and activity for supported Codex and Claude Code records.</p>
        <p>Session details are optional. When enabled for Codex or Claude Code, the CLI also sends tool input and output text, recorded repository diffs, and selected setup metadata. These details can include source code and command output. The CLI redacts common credential patterns. Shared session links include the conversation only.</p>
        <p>Each upload includes up to 1 MiB and 500 messages for the conversation and its standard metadata. Optional session details have a separate 512 KiB limit. The collector checks local files and databases about every two seconds while it runs. It queues uploads locally and retries after reconnecting.</p>
        <p>With full transcripts enabled, Tideline also archives redacted JSONL for approved Codex and Claude Code sessions. It saves embedded PNG, JPEG, GIF, and WebP images up to 6 MiB each. Links stay as text. Unsupported attachments are marked, and collection stops if a source record exceeds the local reader limit or leaves the selected checkout. Run <code>tideline sync setup --no-full-transcripts</code> to stop sending this data.</p>
        <p>Sync coverage uses an inventory of session IDs, agent names, and start times for approved repositories. The same report sends repository names and hashed IDs for the status shown in <strong>Settings → Uploads</strong>. The collector sends it at startup and every 30 minutes while running. Set <code>TIDELINE_SESSION_INVENTORY=0</code> in the collector environment to clear the previous report at its next connection and stop sending it.</p>
      </section>
      <section aria-labelledby="access">
        <h2 id="access">Who can read sessions</h2>
        <p>Your personal workspace is private to your account. Members of a team workspace can read the sessions synced there. A session snapshot becomes accessible to anyone with its link when an owner or admin creates one.</p>
        <p>A sync credential is tied to one workspace and expires after 30 days. On macOS the collector uses Keychain by default. On Linux, <code>onboard</code> stores the credential in an owner-only local file.</p>
      </section>
      <section aria-labelledby="stop">
        <h2 id="stop">Stop future uploads</h2>
        <p>Run <code>sync setup</code> and clear a repository to stop collecting from it. To stop sending session details, run <code>tideline sync setup --no-session-details</code>. Use <code>sync stop</code> to stop the background process, or <code>sync revoke</code> to end the collector’s access. Sessions already uploaded stay in the workspace.</p>
      </section>
    </>
  );
}

function CommandTable({ rows, heading = "Command" }: { rows: [string, string][]; heading?: string }) {
  return (
    <table className={styles.table}>
      <thead><tr><th scope="col">{heading}</th><th scope="col">What it does</th></tr></thead>
      <tbody>
        {rows.map(([command, description]) => (
          <tr key={command}><th scope="row"><code>{command}</code></th><td>{description}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export const docsGuides = [
  {
    slug: "get-started", title: "Get started", description: "Install the CLI, choose a repository, and sync your first conversation.",
    sections: [["prepare-cli", "Install the CLI"], ["first-session", "Sync your first session"]],
    Content: GetStarted,
  },
  {
    slug: "cli", title: "CLI reference", description: "Manage your account and sync. Import, export, and query sessions.",
    sections: [["run-command", "Run a command"], ["account", "Account and workspace"], ["sync", "Control sync"], ["import-export", "Import, export, and query"], ["troubleshoot", "Troubleshoot sync"]],
    Content: CliGuide,
  },
  {
    slug: "dashboard", title: "Dashboard and teams", description: "Find conversations, read usage reports, and work with a team.",
    sections: [["sessions", "Find and read sessions"], ["reports", "Read usage reports"], ["budgets", "Set a budget or goal"], ["teams", "Work with a team"], ["sharing", "Share a conversation"]],
    Content: Dashboard,
  },
  {
    slug: "mcp", title: "Connect an agent with MCP", description: "Let an agent query your workspace and save reports from a conversation.",
    sections: [["connect", "Connect Codex"], ["other-clients", "Connect another MCP client"], ["tools", "Query sessions and save reports"]],
    Content: McpGuide,
  },
  {
    slug: "data-and-privacy", title: "Data and privacy", description: "See what the CLI reads and uploads, who can view it, and how to stop sync.",
    sections: [["local-sources", "Where the CLI finds sessions"], ["uploads", "What uploads contain"], ["access", "Who can read sessions"], ["stop", "Stop future uploads"]],
    Content: DataAndPrivacy,
  },
];
