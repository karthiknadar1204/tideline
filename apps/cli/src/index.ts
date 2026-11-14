#!/usr/bin/env node
import { Command } from "commander";
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

const sync = program.command("sync").description("Automatically sync new sessions from a selected project");

sync
  .command("setup")
  .description("Approve conversation sync for one project and workspace")
  .requiredOption("--workspace <id>", "Destination personal workspace ID")
  .requiredOption("--project <directory>", "Project directory to sync")
  .option("--conversations", "Allow conversation text, usage, activity, commit links, and safety findings from new sessions")
  .option("--credential-file", "Use an owner-only file in place of the system keychain")
  .option("--no-browser", "Show the approval link without opening your browser")
  .action(async (options) => {
    const { setupSync } = await import("./sync");
    await setupSync(options);
  });

sync.command("run").description("Watch for new Codex and Claude Code sessions").action(async () => {
  const { runSync } = await import("./sync");
  await runSync();
});

sync.command("status").description("Show the selected project and sync status").action(async () => {
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
