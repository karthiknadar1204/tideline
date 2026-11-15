import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cliBundle = process.env.TIDELINE_TEST_CLI_BUNDLE;
const entry = cliBundle ? resolve(cliBundle) : fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("file import and native analysis import preserve the sanitized-upload boundary", {
  skip: process.platform === "win32" || (!process.versions.bun && !cliBundle),
}, async (context) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tideline-report-import-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const codexHome = join(directory, "codex");
  const claudeHome = join(directory, "claude");
  const codexSessions = join(codexHome, "sessions");
  const claudeSessions = join(claudeHome, "projects", "fixture");
  await Promise.all([mkdir(codexSessions, { recursive: true }), mkdir(claudeSessions, { recursive: true })]);

  const workspace = randomUUID();
  const report = randomUUID();
  const session = randomUUID();
  async function fixture(source: string, originalId: string, candidate: string) {
    const path = new URL(`../../../packages/test-fixtures/${source}/sanitized-session.jsonl`, import.meta.url);
    const data = await readFile(path, "utf8");
    await writeFile(candidate, data.replaceAll(originalId, session).replaceAll("/synthetic-omitted-path/example", directory));
  }

  const file = join(codexSessions, "session.jsonl");
  await fixture("codex", "019a82c9-9a00-7584-9e60-a41beb24bbd3", file);
  const run = (command: string, ...args: string[]) => exec(process.execPath, [entry, command, ...args, "--workspace", workspace], {
    timeout: 10_000,
    env: { ...process.env, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, TIDELINE_SYNC_HOME: join(directory, "account"),
      TIDELINE_API_URL: "http://127.0.0.1:1", TIDELINE_CLERK_ISSUER: "" },
  });
  const cli = (...args: string[]) => run("import", ...args);

  const manual = await cli(file, "--dry-run");
  assert.match(manual.stdout, new RegExp(`Codex session: ${session} with 2 text messages`));
  assert.match(manual.stdout, /Dry run complete\. No data was sent/);
  assert.equal((await run("upload", file, "--dry-run")).stdout, manual.stdout);
  await assert.rejects(run("upload", "--dry-run"), /Pass a session file or ID/);
  await assert.rejects(run("upload", file, "--dry-run", "--background"), /Use import options/);
  await assert.rejects(cli(file), /then pass --sanitized/);

  const preview = await cli(session.toUpperCase(), "--analysis", report, "--dry-run");
  assert.match(preview.stdout, new RegExp(`Codex session: ${session} with 2 text messages`));
  assert.match(preview.stdout, new RegExp(`Would link the session to report ${report}`));
  assert.doesNotMatch(preview.stdout, /MUST_NOT_UPLOAD/);
  const filePreview = await cli(file, "--analysis", report, "--dry-run");
  assert.match(filePreview.stdout, new RegExp(`Would link the session to report ${report}`));
  await assert.rejects(cli(randomUUID(), "--analysis", report, "--dry-run"), /No matching local/);

  const claudeFile = join(claudeSessions, "session.jsonl");
  await symlink(file, claudeFile);
  const withoutSymlink = await cli(session, "--analysis", report, "--dry-run");
  assert.match(withoutSymlink.stdout, /Codex session:/);
  await rm(claudeFile);
  await fixture("claude-code", "10fabcd2-55cc-4f72-91e7-d2cb2273bbd3", claudeFile);
  await assert.rejects(cli(session, "--analysis", report, "--dry-run"), /More than one local agent/);
  const selected = await cli(session, "--source", "claude-code", "--analysis", report, "--dry-run");
  assert.match(selected.stdout, /Claude Code session:/);
  assert.doesNotMatch(selected.stdout, /MUST_NOT_UPLOAD/);
});
