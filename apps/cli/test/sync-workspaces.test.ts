import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("named collectors keep their repository choices and reject ambiguous destinations", {
  skip: process.platform === "win32" || !process.versions.bun,
  timeout: 15_000,
}, async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-workspace-routes-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const primary = randomUUID();
  const second = randomUUID();
  const missing = randomUUID();
  const config = join(root, "private");
  const other = join(config, "workspaces", second);
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await Promise.all([config, other, alpha, beta].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const api = "http://127.0.0.1:1";
  const now = new Date().toISOString();
  for (const [workspaceId, directory] of [[primary, config], [second, other]]) {
    const path = join(directory, "sync.sqlite");
    await writeFile(path, "", { mode: 0o600 });
    const storage = new DatabaseSync(path);
    storage.exec("CREATE TABLE config (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    storage.prepare("INSERT INTO config VALUES (1, ?)").run(JSON.stringify({
      workspaceId, apiOrigin: api, account: randomUUID(), credentialStore: "file", startedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), codexRoot: root, claudeRoot: root, projects: [],
    }));
    storage.close();
  }

  const env = { ...process.env, TIDELINE_SYNC_HOME: config, TIDELINE_SYNC_PROFILE: "", TIDELINE_API_URL: api };
  const cli = (...args: string[]) => execute(process.execPath, [entry, "sync", ...args], { env, timeout: 5_000 });
  const setup = (workspace: string, path: string) => cli("setup", "--workspace", workspace, "--project", path, "--conversations");
  await setup(primary, alpha);
  await setup(second, beta);
  await assert.rejects(setup(second, alpha), /is already routed to workspace/);
  await assert.rejects(cli("status", "--workspace", missing), /Set up sync for this workspace/);
  assert.match((await cli("status")).stdout, new RegExp(`Workspace: ${primary}`));
  assert.match((await cli("status", "--workspace", second)).stdout, new RegExp(`Workspace: ${second}`));
  assert.deepEqual(JSON.parse((await cli("workspaces", "--json")).stdout), [
    { workspaceId: primary, projects: [alpha], active: true },
    { workspaceId: second, projects: [beta], active: true },
  ]);

  await rm(join(config, "sync.sqlite"));
  await assert.rejects(cli("status"), /Choose a collector with --workspace/);
  assert.match((await cli("status", "--workspace", second)).stdout, new RegExp(`Workspace: ${second}`));
});
