#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander";
import { listWorkspaces, login, logout, selectWorkspace, showWorkspace } from "./cli-account";
import { doctor, whoami } from "./cli-diagnostics";
import { importSession } from "./import";
import type { ImportOptions } from "./import";
import cliPackage from "../package.json";

const program = new Command()
  .name("tideline")
  .description("Tideline command line interface")
  .option("--code <code>", "Connect to a setup page in your browser")
  .version(cliPackage.version);

const autoUpdateCommands = new Set(["tideline", "login", "whoami", "enable", "disable", "upload"]);
program.hook("preAction", async (_program, command) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI || !autoUpdateCommands.has(command.name())) return;
  const options = command.optsWithGlobals();
  if (options.code || options.json || options.retry || command.args.length) return;
  const { offerInteractiveUpdate } = await import("./cli-update");
  await offerInteractiveUpdate();
});

program
  .command("login")
  .description("Approve the CLI in your browser")
  .option("--no-browser", "Show the approval link without opening your browser")
  .action(login);

program.command("logout").description("Sign out and revoke this CLI's access").action(logout);
program.command("whoami").description("Show the signed-in account, workspace, and upload failures")
  .option("--json", "Print JSON").action(whoami);
program.command("doctor").description("Check sign-in, API connectivity, agent storage, and sync")
  .option("--json", "Print JSON").action(doctor);
program.command("update").description("Check for a release and update an installed CLI")
  .option("--check", "Check for an update without installing")
  .option("--yes", "Install the release without prompting")
  .action(async (options) => {
    const { updateCli } = await import("./cli-update");
    await updateCli(options);
  });

const report = program.command("report").description("Manage saved reports");
report.command("link <report> <session>")
  .description("Link an already-synced session to a report you authored")
  .option("--source <agent>", "Use a native session ID for codex, claude-code, cursor, or opencode")
  .option("--workspace <id>", "Choose a workspace")
  .option("--json", "Print JSON")
  .action(async (report, session, options) => {
    const { linkReportSession } = await import("./report-link");
    await linkReportSession(report, session, options);
  });

report.command("sync").description("Sync new messages from sessions approved for report follow-up").action(async () => {
  const { syncReportFollowers } = await import("./report-follow-up");
  await syncReportFollowers({ manual: true });
});

program.command("mcp").description("Serve one workspace to an MCP client over stdio")
  .requiredOption("--workspace <id>", "Workspace ID this connection can access")
  .action(async ({ workspace }: { workspace: string }) => {
    const { serveMcp } = await import("./mcp");
    await serveMcp(workspace);
  });

const workspace = program.command("workspace").description("List and select your workspaces");
workspace.command("list").description("List workspaces available to your account").option("--json", "Print JSON").action(listWorkspaces);
workspace.command("show").description("Show the current workspace").option("--workspace <id>", "Workspace ID")
  .option("--json", "Print JSON").action(showWorkspace);
workspace.command("use <id>").description("Use a workspace as the destination").action(selectWorkspace);
program.command("set-org <id>").description("Use a workspace as the destination").action(selectWorkspace);
program.command("github").description("Sync GitHub repository activity").command("sync")
  .description("Import recent merged pull requests and GitHub Actions runs through gh")
  .option("--project <directory>", "Repository checkout", ".")
  .option("--workspace <id>", "Choose a workspace")
  .action(async (options) => {
    const { syncGitHub } = await import("./github-activity");
    await syncGitHub(options);
  });

function importFlags(command: Command) {
  return command.option("--source <source>", "Agent source (defaults to Codex for a JSONL file)")
    .option("--analysis <report>", "Link this session to a saved report")
    .option("--follow", "Sync new messages for seven days (with --analysis --sanitized)")
    .option("--sanitized", "Confirm the selected file is safe to upload")
    .option("--dry-run", "Preview the import without sending data");
}

async function runImport(fileOrSession: string, options: ImportOptions & { analysis?: string; follow?: boolean }) {
  if (options.follow && !options.analysis) throw new InvalidArgumentError("Use --follow with --analysis and --sanitized.");
  if (!options.analysis) {
    await importSession(fileOrSession, options);
    return;
  }
  const { importReportSession } = await import("./report-import");
  await importReportSession(fileOrSession, { ...options, analysis: options.analysis });
}

importFlags(program.command("import <file-or-session>").description("Import one sanitized Codex or Claude Code session"))
  .option("--workspace <id>", "Destination workspace ID (defaults to your signed-in workspace)")
  .option("--no-browser", "Show the approval link without opening your browser")
  .action(runImport);

const sync = program.command("sync").description("Automatically sync sessions from selected projects");
const hooks = program.command("hooks").description("Manage local agent lifecycle hooks that wake Tideline sync");
for (const [action, description] of [
  ["install", "Install hooks for approved local sync"],
  ["remove", "Remove hooks from this sync setup"],
  ["status", "Show installed hooks for this sync setup"],
] as const) {
  hooks.command(action).description(description)
    .addOption(new Option("--agent <name>", "Choose the agent settings to use").choices(["all", "codex", "claude-code"]).default("all"))
    .action(async ({ agent }: { agent: string }) => {
      const { configureNativeHooks } = await import("./native-hooks");
      await configureNativeHooks(action, agent);
    });
}
hooks.command("__wake <agent> <event>", { hidden: true }).action(async (agent: string, event: string) => {
  const { runNativeHook } = await import("./native-hooks");
  await runNativeHook(agent, event);
});

hooks.command("__report-follow-up <agent> <session>", { hidden: true }).action(async (source: string, sessionId: string) => {
  const { syncReportFollowers } = await import("./report-follow-up");
  await syncReportFollowers({ source, sessionId });
});

const runSetup = async (options: Parameters<typeof import("./sync").setupSync>[0]) => {
  const { setupSync } = await import("./sync");
  await setupSync(options);
};

program.action(({ code }: { code?: string }) => runSetup({ browser: true, code, onboarding: true }));

function setupOptions(command: Command) {
  return command
    .option("--workspace <id>", "Destination workspace ID for a new collector (defaults to your selected workspace)")
    .option("--project <directory...>", "Project directories to sync without the picker")
    .option("--history", "Include older sessions in the selected projects")
    .option("--no-history", "Start with new sessions in newly selected projects")
    .option("--background", "Start the collector in the background")
    .option("--no-background", "Set up sync without starting the background collector")
    .option("--hooks", "Install native Codex and Claude Code hooks after sync approval")
    .option("--no-hooks", "Keep existing agent hook settings")
    .option("--conversations", "Approve uploading conversations and available metadata from --project")
    .option("--session-details", "Also upload recorded tool text, file changes, and setup from Codex and Claude Code")
    .option("--no-session-details", "Stop including session details in future uploads")
    .option("--full-transcripts", "Also sync sanitized Codex and Claude Code raw logs and embedded images")
    .option("--no-full-transcripts", "Stop syncing raw logs and embedded images")
    .option("--subagent-transcripts", "Also upload redacted subagent conversations from Codex and Claude Code with session details")
    .option("--no-subagent-transcripts", "Stop including subagent conversations in future uploads")
    .option("--repository-instructions", "Also upload redacted agent instruction files from selected Git checkouts")
    .option("--no-repository-instructions", "Stop uploading repository instruction snapshots")
    .option("--repository-context", "Also sync redacted skills and agent definitions, and metadata about setup files in selected Git checkouts")
    .option("--no-repository-context", "Stop uploading expanded repository context")
    .option("--github-activity", "Also sync merged pull requests and Actions runs from the selected GitHub checkouts")
    .option("--no-github-activity", "Stop automatic GitHub activity uploads for this selection")
    .option("--credential-file", "Use an owner-only file in place of the system keychain")
    .option("--no-browser", "Show the approval link without opening your browser");
}

setupOptions(sync.command("setup").description("Choose repositories, import history, and configure sync")).action(runSetup);
setupOptions(program.command("connect").description("Connect local repositories to a workspace")).action(runSetup);
setupOptions(program.command("onboard").description("Connect your first repositories to the dashboard"))
  .action((options, command: Command) => runSetup({ ...options, code: command.optsWithGlobals().code, onboarding: true }));

async function retry() {
  const { retrySync } = await import("./sync");
  await retrySync();
}

setupOptions(program.command("enable").description("Choose repositories to enable for sync")).action(runSetup);
setupOptions(program.command("disable").description("Deselect repositories or pause all uploads")).action(runSetup);

const importOnly = new Set(["source", "analysis", "sanitized", "dryRun", "follow"]);
const sharedUploadOptions = new Set(["workspace", "browser"]);
const upload = importFlags(setupOptions(program.command("upload [file-or-session]")
  .description("Choose repositories, or upload one sanitized session")));
upload.option("--retry", "Retry queued and previously failed uploads").action(async (fileOrSession, options) => {
  const supplied = Object.keys(options).filter((key) => upload.getOptionValueSource(key) === "cli");
  if (options.retry) {
    if (fileOrSession || supplied.some((key) => key !== "retry")) {
      throw new InvalidArgumentError("Use --retry by itself to retry uploads from your current setup.");
    }
    await retry();
  } else if (fileOrSession) {
    if (supplied.some((key) => !importOnly.has(key) && !sharedUploadOptions.has(key))) {
      throw new InvalidArgumentError("Use import options when uploading a session file or ID.");
    }
    await runImport(fileOrSession, options);
  } else {
    if (supplied.some((key) => importOnly.has(key))) throw new InvalidArgumentError("Pass a session file or ID when using import options.");
    await runSetup(options);
  }
});

sync.command("retry").description("Retry queued and previously failed uploads").action(retry);

function queryOptions(command: Command) {
  return command
    .option("--workspace <id>", "Workspace ID (defaults to your personal workspace)")
    .option("--repo <name>", "Repository name")
    .option("--source <agent>", "codex, claude-code, cursor, or opencode")
    .option("--from <date>", "First session start day (YYYY-MM-DD, UTC)")
    .option("--to <date>", "Last session start day (YYYY-MM-DD, UTC, inclusive)");
}

queryOptions(program.command("pull").description("Download synced sessions as JSONL"))
  .option("--out <directory>", "New directory for the export")
  .option("--details", "Include captured tool text, file diffs, and setup tables")
  .option("--transcripts", "Include complete recorded JSONL and private image attachments")
  .option("--github", "Include imported GitHub activity for the selected date range and repository")
  .option("--pattern <regex>", "Export only sessions matching text, a tool call, or a session ID")
  .option("--json", "Print the export summary as JSON")
  .action(async (options) => {
    const { pullSessions } = await import("./session-commands");
    await pullSessions(options);
  });

queryOptions(program.command("count [text]").description("Count sessions or messages matching text"))
  .option("--in <directory>", "Read a local pull export")
  .option("--pull <directory>", "Read a local pull export (alias for --in)")
  .option("--live", "Query the workspace even when a recent local pull is available")
  .option("--pattern <regex>", "Match a regular expression")
  .option("--ignore-case", "Match text regardless of case")
  .addOption(new Option("--field <field>", "Select messages or recorded tool text").choices(["user", "assistant", "all", "tool", "tool-input", "tool-output"]))
  .addOption(new Option("--unit <kind>", "Count messages, sessions, calls, or prompts").choices(["message", "session", "call", "prompt"]))
  .option("--json", "Print the count as JSON")
  .action(async (pattern, options) => {
    const { countSessions } = await import("./session-commands");
    await countSessions(pattern, options);
  });

queryOptions(program.command("sql <query>").description("Run a read-only SQLite query over synced data"))
  .option("--in <directory>", "Read a local pull export")
  .option("--out <file>", "New .jsonl or .csv output file")
  .option("--details", "Query captured tool text, file diffs, and setup")
  .option("--github", "Include imported GitHub activity in a live query")
  .addHelpText("after", "\nTables: sessions, messages, models, activity, commits, safety_findings, calls, prompts, agent_runs, agent_messages, file_changes, session_setup, github_activity.")
  .action(async (query, options) => {
    const { querySessions } = await import("./session-commands");
    await querySessions(query, options);
  });

program.command("__query", { hidden: true }).action(async () => {
  const { runSqlWorker } = await import("./session-commands");
  await runSqlWorker();
});

sync.command("run")
  .description("Sync Codex, Claude Code, Cursor, and OpenCode in this terminal")
  .addOption(new Option("--background-id <id>").hideHelp().conflicts("autostart"))
  .addOption(new Option("--autostart").hideHelp())
  .action(async (options) => {
    const { runSync } = await import("./sync");
    await runSync({ backgroundId: options.backgroundId, autostart: options.autostart });
  });

sync.command("start").description("Start sync in the background").action(async () => {
  const { startBackgroundSync } = await import("./sync-background");
  await startBackgroundSync();
});

sync.command("once").description("Scan and upload approved sessions once, then exit").action(async () => {
  const { syncOnce } = await import("./sync");
  await syncOnce();
});

sync.command("stop").description("Stop background sync").action(async () => {
  const { stopBackgroundSync } = await import("./sync-background");
  await stopBackgroundSync();
});

sync.command("status").description("Show selected projects and upload status").action(async () => {
  const { syncStatus } = await import("./sync");
  await syncStatus();
});

const autostart = sync.command("autostart").description("Manage automatic sync when you sign in to this computer");
for (const [action, description] of [
  ["enable", "Start sync now and after you sign in"],
  ["disable", "Stop sync at login and remove its service"],
  ["status", "Show whether sync at login is enabled and running"],
] as const) {
  autostart.command(action).description(description).action(async () => {
    const { configureSyncAutostart } = await import("./sync-autostart");
    await configureSyncAutostart(action);
  });
}

sync.command("revoke").description("Revoke this collector's upload access").action(async () => {
  const { revokeSync } = await import("./sync");
  await revokeSync();
});

try {
  await program.parseAsync();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Tideline could not finish."}\n`);
  process.exitCode = 1;
}
