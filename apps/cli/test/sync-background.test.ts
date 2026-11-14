import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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

test("background sync keeps uploading after the launcher exits and stops on request", {
  skip: process.platform === "win32" || !process.versions.bun,
  timeout: 25_000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-background-")));
  const syncHome = join(root, "sync");
  const codexRoot = join(root, "sessions");
  const project = join(root, "approved");
  await Promise.all([mkdir(syncHome, { mode: 0o700 }), mkdir(codexRoot), mkdir(project)]);

  const delivered = new Set<string>();
  const calls = new Map<string, number>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = sessionImportRequest.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!input.success || request.url !== "/v1/cli/sync/sessions") {
      response.writeHead(400).end();
      return;
    }
    const id = input.data.session.sourceSessionId;
    delivered.add(id);
    calls.set(id, (calls.get(id) ?? 0) + 1);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: randomUUID(), alreadyReceived: false }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = { ...process.env, TIDELINE_API_URL: `http://127.0.0.1:${address.port}`, TIDELINE_SYNC_HOME: syncHome };
  const cli = (...args: string[]) => exec(process.execPath, [entry, "sync", ...args], { env, timeout: 18_000 });
  const account = randomUUID();
  const database = join(syncHome, "sync.sqlite");
  await writeFile(database, "", { mode: 0o600 });
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE config (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO config (id, value) VALUES (1, ?)").run(JSON.stringify({
    apiOrigin: env.TIDELINE_API_URL, workspaceId: randomUUID(), projectDirectory: project, account,
    startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    credentialStore: "file", codexRoot, claudeRoot: join(root, "claude"),
  }));
  db.close();
  await writeFile(join(syncHome, `sync-${account}.token`), `tdsync_${"0".repeat(64)}`, { mode: 0o600 });

  async function addSession() {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    await writeFile(join(codexRoot, `${id}.jsonl`), [
      { type: "session_meta", timestamp, payload: { id, cwd: project } },
      { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic session" }] } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    return id;
  }

  async function waitForDelivery(id: string) {
    for (let attempts = 0; attempts < 60 && !delivered.has(id); attempts++) await delay(100);
    assert.ok(delivered.has(id), "Session written after launcher exit reached the upload API");
  }

  try {
    await cli("start");
    assert.match((await cli("status")).stdout, /Background sync: Running/i);
    await cli("start");
    const first = await addSession();
    await waitForDelivery(first);
    await cli("stop");
    assert.match((await cli("status")).stdout, /Background sync: Stopped/i);
    const second = await addSession();
    await delay(2_200);
    assert.ok(!delivered.has(second));
    await cli("start");
    await waitForDelivery(second);
    assert.deepEqual(delivered, new Set([first, second]));
    assert.equal(calls.get(first), 1, "Restart does not submit an unchanged session again");
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
