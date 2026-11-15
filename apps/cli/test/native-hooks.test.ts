import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { watchCollectorWake } from "../src/sync-wake";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

test("installed Codex and Claude Code hooks preserve peer settings, reject unapproved cwd, and wake the collector locally", {
  skip: process.platform === "win32" || !process.versions.bun,
  timeout: 20_000,
}, async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-native-hooks-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sync = join(root, "test's sync");
  const codex = join(root, "codex home");
  const claude = join(root, "claude home");
  const approved = join(root, "approved");
  const unapproved = join(root, "unapproved");
  const launchDirectory = join(root, "install's bin", "bin");
  const runtime = join(root, "install's bin", "share", "tideline");
  await Promise.all([sync, codex, claude, approved, unapproved, launchDirectory, runtime].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const bundle = await Bun.build({ entrypoints: [entry], target: "node" });
  assert.ok(bundle.success);
  const code = Buffer.from(await bundle.outputs[0].arrayBuffer());
  const digest = createHash("sha256").update(code).digest("hex");
  await writeFile(join(runtime, `${digest}.mjs`), code, { mode: 0o600 });
  const launcher = join(launchDirectory, "tideline");
  const origin = "http://127.0.0.1:3001";
  await writeFile(launcher,
    `#!/bin/sh\nexport TIDELINE_WEB_URL='http://localhost:3000'\nexport TIDELINE_API_URL='${origin}'\n` +
    `bin_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || exit 1\nexec node "$bin_dir/../share/tideline/${digest}.mjs" "$@"\n`,
    { mode: 0o700 });
  const settings = { codex: join(codex, "hooks.json"), claude: join(claude, "settings.json") };
  const codexBefore = { description: "Other hooks", hooks: { Stop: [{ hooks: [{ type: "command", command: "other-codex-command" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-pre-use" }] }] } };
  const claudeBefore = { permissions: { deny: ["Bash(curl:*)"] }, hooks: { SessionStart: [{ matcher: "startup", hooks: [
    { type: "command", command: "other-claude-command", timeout: 15 },
  ] }] } };
  const notify = 'notify = ["previous-notifier", "turn-end"]\n';
  await Promise.all([
    writeFile(settings.codex, JSON.stringify(codexBefore), { mode: 0o600 }),
    writeFile(settings.claude, JSON.stringify(claudeBefore), { mode: 0o600 }),
    writeFile(join(codex, "config.toml"), notify, { mode: 0o600 }),
  ]);
  const database = join(sync, "sync.sqlite");
  await writeFile(database, "", { mode: 0o600 });
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE config (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  const config = {
    apiOrigin: origin, workspaceId: randomUUID(), account: randomUUID(), projects: [{ directory: approved, since: "1970-01-01T00:00:00.000Z" }],
    startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), credentialStore: "file",
    codexRoot: join(codex, "sessions"), claudeRoot: join(claude, "projects"),
  };
  db.prepare("INSERT INTO config (id, value) VALUES (1, ?)").run(JSON.stringify(config));
  db.close();
  const env = { ...process.env, HOME: root, TIDELINE_SYNC_HOME: sync, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude };
  const cli = (...args: string[]) => execute(launcher, ["hooks", ...args], { env, timeout: 5_000 });
  assert.match((await cli("status")).stdout, /Codex: not installed.*Claude Code: not installed/is);
  await cli("install");
  assert.match((await cli("status")).stdout, /Codex: installed.*Claude Code: installed/is);
  const codexText = await readFile(settings.codex, "utf8");
  const claudeText = await readFile(settings.claude, "utf8");
  const codexConfig = JSON.parse(codexText);
  const claudeConfig = JSON.parse(claudeText);
  assert.deepEqual(codexConfig.hooks.Stop[0], codexBefore.hooks.Stop[0]);
  assert.deepEqual(claudeConfig.hooks.SessionStart[0], claudeBefore.hooks.SessionStart[0]);
  assert.equal(await readFile(join(codex, "config.toml"), "utf8"), notify);
  const beforeStat = await lstat(settings.codex);
  await cli("install");
  assert.equal((await lstat(settings.codex)).ino, beforeStat.ino, "A repeated install does not replace settings.");
  assert.equal(await readFile(settings.codex, "utf8"), codexText);
  assert.equal(await readFile(settings.claude, "utf8"), claudeText);

  const codexStop = codexConfig.hooks.Stop[1].hooks[0].command;
  const claudeStop = claudeConfig.hooks.Stop[0].hooks[0].command;
  const sentinel = join(sync, "collector.wake");
  const marker = "THIS_PRIVATE_ASSISTANT_REPLY_STAYS_IN_STDIN";
  const runHook = (command: string, cwd: string) => {
    const payload = { hook_event_name: "Stop", cwd: approved, session_id: randomUUID(),
      last_assistant_message: marker, transcript_path: join(unapproved, "invalid.jsonl") };
    return execute("/bin/sh", ["-c", `printf %s ${shellQuote(JSON.stringify(payload))} | ${command}`], { env, cwd, timeout: 5_000 });
  };
  const disallowed = await runHook(codexStop, unapproved);
  assert.equal(disallowed.stdout, '{"continue":true}\n');
  await assert.rejects(lstat(sentinel), { code: "ENOENT" });

  const watcher = watchCollectorWake(sync);
  context.after(() => watcher.close());
  for (const command of [codexStop, claudeStop]) {
    const controller = new AbortController();
    const waiting = watcher.wait(controller.signal, 10_000);
    try {
      const result = await runHook(command, approved);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(marker));
      await Promise.race([waiting, delay(2_500, undefined, { signal: controller.signal }).then(() => {
        throw new Error("The hook did not wake the watcher before its polling fallback.");
      })]);
      assert.equal(await readFile(sentinel, "utf8"), "1");
      assert.equal((await lstat(sentinel)).mode & 0o777, 0o600);
    } finally {
      controller.abort();
    }
  }
  await cli("remove", "--agent", "codex");
  assert.match((await cli("status")).stdout, /Codex: not installed.*Claude Code: installed/is);
  await cli("remove");
  assert.deepEqual(JSON.parse(await readFile(settings.codex, "utf8")), codexBefore);
  assert.deepEqual(JSON.parse(await readFile(settings.claude, "utf8")), claudeBefore);

  await unlink(settings.codex);
  await symlink(settings.claude, settings.codex);
  await assert.rejects(cli("install"), /regular hook settings file/u);
  assert.deepEqual(JSON.parse(await readFile(settings.claude, "utf8")), claudeBefore);
});
