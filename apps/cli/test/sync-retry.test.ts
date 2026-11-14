import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sessionImportRequest } from "@tideline/contracts";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("manual retry rebuilds approved failed uploads once and resumes a queued upload in background", {
  skip: process.platform === "win32" || !process.versions.bun,
  timeout: 25_000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-retry-")));
  const syncHome = join(root, "sync");
  const project = join(root, "approved");
  const removed = join(root, "removed");
  const codexRoot = join(root, "sessions");
  await Promise.all([mkdir(syncHome, { mode: 0o700 }), mkdir(project), mkdir(removed), mkdir(codexRoot)]);

  const calls = new Map<string, number>();
  const delivered = new Set<string>();
  const responses = new Map<string, number>();
  const workspaceId = randomUUID();
  const protectedServerText = "private diagnostic text must never reach the terminal";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = sessionImportRequest.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!input.success || request.url !== "/v1/cli/sync/sessions" || input.data.workspaceId !== workspaceId) {
      response.writeHead(400).end();
      return;
    }
    const id = input.data.session.sourceSessionId;
    calls.set(id, (calls.get(id) ?? 0) + 1);
    const status = responses.get(id) ?? 202;
    if (status !== 202) {
      response.writeHead(status).end(protectedServerText);
      return;
    }
    const alreadyReceived = delivered.has(id);
    delivered.add(id);
    response.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ id, alreadyReceived }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = { ...process.env, TIDELINE_API_URL: `http://127.0.0.1:${address.port}`, TIDELINE_SYNC_HOME: syncHome };
  const run = (...args: string[]) => exec(process.execPath, [entry, ...args], { env, timeout: 14_000 });
  const cli = (...args: string[]) => run("sync", ...args);
  const account = randomUUID();
  const database = join(syncHome, "sync.sqlite");
  await writeFile(database, "", { mode: 0o600 });
  const at = new Date().toISOString();
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE config (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE uploads (
      session_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, message_count INTEGER NOT NULL,
      tail_line INTEGER NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('queued', 'received', 'failed')),
      body TEXT, queued_at INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO config (id, value) VALUES (1, ?)").run(JSON.stringify({
    apiOrigin: env.TIDELINE_API_URL, workspaceId, account, startedAt: at, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    projects: [{ directory: project, since: at }], credentialStore: "file", codexRoot, claudeRoot: join(root, "claude"),
  }));
  await writeFile(join(syncHome, `sync-${account}.token`), `tdsync_${"0".repeat(64)}`, { mode: 0o600 });

  async function addSession(directory = project) {
    const id = randomUUID();
    const records = [
      { type: "session_meta", timestamp: at, payload: { id, cwd: directory } },
      { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic retry session" }] } },
    ];
    await writeFile(join(codexRoot, `${id}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return id;
  }

  async function until(condition: () => boolean) {
    for (let attempts = 0; attempts < 60 && !condition(); attempts++) await delay(100);
    assert.ok(condition());
  }

  try {
    const legacy = await addSession();
    const excluded = await addSession(removed);
    const untouched = await addSession();
    const insert = db.prepare("INSERT INTO uploads VALUES (?, ?, 1, 2, 'failed', NULL, ?)");
    const fingerprint = createHash("sha256").update("old projection").digest("hex");
    insert.run(`codex:${legacy}`, fingerprint, Date.now());
    insert.run(`codex:${excluded}`, fingerprint, Date.now());
    db.close();

    responses.set(legacy, 409);
    await assert.rejects(cli("retry"), (error: Error & { stdout?: string; stderr?: string }) => {
      assert.match(error.stdout ?? "", /Still failed: 2/);
      assert.doesNotMatch(`${error.stdout} ${error.stderr}`, /private diagnostic text/);
      return true;
    });
    assert.equal(calls.get(legacy), 1, "A permanent response terminates that retry attempt");
    assert.equal(calls.has(excluded), false, "The previous failed ID does not bypass project authorization");
    assert.equal(calls.has(untouched), false, "A one-shot retry only visits the existing queue and failed uploads");
    const status = (await cli("status")).stdout;
    assert.match(status, /HTTP 409: 1/);
    assert.match(status, /Unknown failure: 1/);
    assert.doesNotMatch(status, /private diagnostic text/);

    responses.delete(legacy);
    await assert.rejects(run("upload", "--retry"), (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? "", /Still failed: 1/);
      return true;
    });
    assert.deepEqual(delivered, new Set([legacy]));
    assert.equal(calls.get(legacy), 2);

    responses.set(untouched, 503);
    await cli("start");
    await until(() => calls.has(untouched));
    assert.match((await cli("status")).stdout, /Queued: 1/);
    responses.delete(untouched);
    assert.match((await cli("retry")).stdout, /Retry requested/);
    await until(() => delivered.has(untouched));
    assert.equal(calls.get(legacy), 2, "The background worker leaves an already received snapshot alone");
    assert.equal(calls.has(excluded), false);

    const waiting = await addSession();
    responses.set(waiting, 503);
    await until(() => calls.has(waiting));
    await cli("stop");
    const control = new DatabaseSync(database);
    try {
      control.prepare("UPDATE background SET phase = 'starting', started_at = ? WHERE singleton = 1").run(0);
    } finally {
      control.close();
    }
    responses.delete(waiting);
    await assert.rejects(cli("retry"), (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? "", /Received: 3\. Still failed: 1/);
      return true;
    });
    assert.ok(delivered.has(waiting), "An abandoned launch reservation does not keep imports queued");
  } finally {
    try {
      await cli("stop");
    } finally {
      server.close();
      server.closeAllConnections();
      await rm(root, { recursive: true, force: true });
    }
  }
});
