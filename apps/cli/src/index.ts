#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander";
import { listWorkspaces, login, logout, selectWorkspace, showWorkspace } from "./cli-account";
import { doctor, whoami } from "./cli-diagnostics";
import { importSession } from "./import";

const program = new Command()
  .name("tideline")
  .description("Tideline command line interface");

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

program
  .command("import <file>")
  .description("Import one sanitized Codex or Claude Code session")
  .option("--source <source>", "codex or claude-code", "codex")
  .option("--workspace <id>", "Destination workspace ID (defaults to your signed-in workspace)")
  .option("--sanitized", "Confirm the selected file is safe to upload")
  .option("--dry-run", "Preview the import without sending data")
  .option("--no-browser", "Show the approval link without opening your browser")
  .action(importSession);

const sync = program.command("sync").description("Automatically sync sessions from selected projects");
const runSetup = async (options: Parameters<typeof import("./sync").setupSync>[0]) => {
  const { setupSync } = await import("./sync");
  await setupSync(options);
};

program.action(() => runSetup({ browser: true }));

function setupOptions(command: Command) {
  return command
    .option("--workspace <id>", "Destination workspace ID for a new collector (defaults to your selected workspace)")
    .option("--project <directory...>", "Project directories to sync without the picker")
    .option("--history", "Include older sessions in the selected projects")
    .option("--background", "Start the collector in the background")
    .option("--conversations", "Approve uploading conversations and available metadata from --project")
    .option("--credential-file", "Use an owner-only file in place of the system keychain")
    .option("--no-browser", "Show the approval link without opening your browser");
}

setupOptions(sync.command("setup").description("Choose repositories, import history, and configure sync")).action(runSetup);
setupOptions(program.command("connect").description("Connect local repositories to a workspace")).action(runSetup);

async function retry() {
  const { retrySync } = await import("./sync");
  await retrySync();
}

setupOptions(program.command("enable").description("Choose repositories to enable for sync")).action(runSetup);
setupOptions(program.command("disable").description("Deselect repositories or pause all uploads")).action(runSetup);

const upload = setupOptions(program.command("upload").description("Choose which repositories upload sessions"));
upload.option("--retry", "Retry queued and previously failed uploads").action(async (options) => {
  if (options.retry) {
    if (Object.keys(options).some((key) => key !== "retry" && upload.getOptionValueSource(key) === "cli")) {
      throw new InvalidArgumentError("Use --retry by itself to retry uploads from your current setup.");
    }
    await retry();
  } else await runSetup(options);
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
  .option("--json", "Print the export summary as JSON")
  .action(async (options) => {
    const { pullSessions } = await import("./session-commands");
    await pullSessions(options);
  });

queryOptions(program.command("count [text]").description("Count sessions or messages matching text"))
  .option("--in <directory>", "Read a local pull export")
  .option("--ignore-case", "Match text regardless of case")
  .addOption(new Option("--field <role>", "Message role to search").choices(["user", "assistant", "all"]))
  .addOption(new Option("--unit <kind>", "Count matching messages or sessions").choices(["message", "session"]))
  .option("--json", "Print the count as JSON")
  .action(async (pattern, options) => {
    const { countSessions } = await import("./session-commands");
    await countSessions(pattern, options);
  });

queryOptions(program.command("sql <query>").description("Run a read-only SQLite query over synced data"))
  .option("--in <directory>", "Read a local pull export")
  .option("--out <file>", "New .jsonl or .csv output file")
  .addHelpText("after", "\nTables: sessions, messages, models, activity, commits, safety_findings.")
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
  .addOption(new Option("--background-id <id>").hideHelp())
  .action(async (options) => {
    const { runSync } = await import("./sync");
    await runSync({ backgroundId: options.backgroundId });
  });

sync.command("start").description("Start sync in the background").action(async () => {
  const { startBackgroundSync } = await import("./sync-background");
  await startBackgroundSync();
});

sync.command("stop").description("Stop background sync").action(async () => {
  const { stopBackgroundSync } = await import("./sync-background");
  await stopBackgroundSync();
});

sync.command("status").description("Show selected projects and upload status").action(async () => {
  const { syncStatus } = await import("./sync");
  await syncStatus();
});

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
