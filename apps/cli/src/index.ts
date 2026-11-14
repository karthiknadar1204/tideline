#!/usr/bin/env node
import { Command, Option } from "commander";
import { importSession } from "./import";
import { login } from "./login";

const program = new Command()
  .name("tideline")
  .description("Tideline command line interface");

program
  .command("login")
  .description("Approve the CLI in your browser")
  .option("--no-browser", "Show the approval link without opening your browser")
  .action(login);

program
  .command("import <file>")
  .description("Import one sanitized Codex or Claude Code session")
  .option("--source <source>", "codex or claude-code", "codex")
  .requiredOption("--workspace <id>", "Destination personal workspace ID")
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

sync
  .command("setup")
  .description("Choose repositories, import history, and configure sync")
  .option("--workspace <id>", "Destination workspace ID (defaults to your personal workspace)")
  .option("--project <directory...>", "Project directories to sync without the picker")
  .option("--history", "Include older sessions in the selected projects")
  .option("--background", "Start the collector in the background")
  .option("--conversations", "Approve uploading conversations and available metadata from --project")
  .option("--credential-file", "Use an owner-only file in place of the system keychain")
  .option("--no-browser", "Show the approval link without opening your browser")
  .action(runSetup);

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
