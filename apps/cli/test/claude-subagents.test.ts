import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sessionImportRequest } from "@tideline/contracts";
import type { SessionImportRequest } from "@tideline/contracts";
import { readClaudeSession } from "../src/claude-session";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const secret = "ghp_0123456789abcdefghijklmnopqrstuv";
const jsonl = (...records: object[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

test("Claude sidecars require opt-in, scope, and a verified parent call; sidecar updates sync without new parent messages", {
  skip: process.platform === "win32" || !process.versions.bun,
  timeout: 40_000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-claude-subagent-")));
  const id = randomUUID();
  const account = randomUUID();
  const workspaceId = randomUUID();
  const sync = join(root, "sync");
  const project = join(root, "approved");
  const outside = join(root, "outside");
  const claudeRoot = join(root, "claude");
  const logs = join(claudeRoot, "project");
  const parent = join(logs, `${id}.jsonl`);
  const sidecars = join(logs, id, "subagents");
  const timestamp = new Date().toISOString();
  await Promise.all([mkdir(sync, { mode: 0o700 }), mkdir(project), mkdir(outside), mkdir(sidecars, { recursive: true })]);
  const record = (role: "user" | "assistant", content: string | object[], fields: object = {}) => ({
    type: role, timestamp, sessionId: id, cwd: project, userType: "external", isSidechain: false,
    message: { role, content, ...(role === "assistant" ? { id: randomUUID(), model: "claude-sonnet-4-6" } : {}) }, ...fields,
  });
  const launch = (agentId: string) => [record("assistant", [{ type: "tool_use", id: `call-${agentId}`, name: "Agent", input: { subagent_type: "Explore" } }]),
    record("user", [{ type: "tool_result", tool_use_id: `call-${agentId}`, content: "Agent started" }], { toolUseResult: { agentId, status: "running" } })];
  const child = (agentId: string, role: "user" | "assistant", content: string | object[], fields: object = {}) =>
    record(role, content, { agentId, isSidechain: true, ...fields });
  const launchIn = (parentAgentId: string, agentId: string) => launch(agentId).map((item) => ({
    ...item, agentId: parentAgentId, isSidechain: true,
  }));
  const supportedPath = join(sidecars, "agent-visible.jsonl");
  const grandchildPath = join(sidecars, "agent-grandchild.jsonl");
  const greatGrandchildPath = join(sidecars, "agent-great-grandchild.jsonl");
  await writeFile(parent, jsonl(record("user", "Review deployment tests"),
    ...launch("visible"), ...launch("wrong-parent"), ...launch("symlinked"), ...launch("hardlinked"), ...launch("wrong-scope"),
    record("assistant", "The review is in progress.")));
  await writeFile(supportedPath, jsonl(child("visible", "user", "Inspect only test files"), child("visible", "assistant", [
    { type: "text", text: `<system-reminder>HIDDEN REMINDER</system-reminder>First child answer: ${secret}` },
    { type: "thinking", thinking: "HIDDEN THINKING" }, { type: "image", source: { data: "HIDDEN IMAGE" } },
  ]), child("visible", "user", [{ type: "tool_result", content: "HIDDEN RESULT", tool_use_id: "tool-child" }]),
    ...launchIn("visible", "grandchild")));
  await writeFile(grandchildPath, jsonl(...launchIn("grandchild", "great-grandchild"), ...launchIn("grandchild", "visible")));
  await writeFile(greatGrandchildPath, jsonl(child("great-grandchild", "assistant", "Great-grandchild response")));
  await Promise.all([
    writeFile(join(sidecars, "agent-wrong-parent.jsonl"), jsonl(child("wrong-parent", "user", "Wrong parent content", { sessionId: randomUUID() }))),
    writeFile(join(sidecars, "agent-unreferenced.jsonl"), jsonl(child("unreferenced", "user", "Unreferenced content"))),
    writeFile(join(sidecars, "agent-wrong-scope.jsonl"), jsonl(child("wrong-scope", "user", "Wrong scope content", { cwd: outside }))),
    writeFile(join(outside, "symlink.jsonl"), jsonl(child("symlinked", "user", "Symlinked content"))),
    writeFile(join(outside, "hardlink.jsonl"), jsonl(child("hardlinked", "user", "Hardlinked content"))),
  ]);
  await symlink(join(outside, "symlink.jsonl"), join(sidecars, "agent-symlinked.jsonl"));
  await link(join(outside, "hardlink.jsonl"), join(sidecars, "agent-hardlinked.jsonl"));

  const received: SessionImportRequest["session"][] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/cli/sync/inventory") { response.writeHead(204).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = sessionImportRequest.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!body.success || request.url !== "/v1/cli/sync/sessions" || body.data.workspaceId !== workspaceId) {
      response.writeHead(400).end(); return;
    }
    received.push(body.data.session);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id, alreadyReceived: false }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = { ...process.env, HOME: root, TIDELINE_API_URL: `http://127.0.0.1:${address.port}`, TIDELINE_SYNC_HOME: sync };
  const cli = (...args: string[]) => execute(process.execPath, [entry, "sync", ...args], { env, timeout: 18_000 });
  const database = join(sync, "sync.sqlite");
  await writeFile(database, "", { mode: 0o600 });
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE config (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO config (id, value) VALUES (1, ?)").run(JSON.stringify({
    apiOrigin: env.TIDELINE_API_URL, workspaceId, account, projects: [{ directory: project, since: "1970-01-01T00:00:00.000Z" }],
    startedAt: timestamp, expiresAt: new Date(Date.now() + 120_000).toISOString(), credentialStore: "file",
    codexRoot: join(root, "codex"), claudeRoot, sessionDetails: true, subagentTranscripts: true,
  }));
  db.close();
  await writeFile(join(sync, `sync-${account}.token`), `tdsync_${"0".repeat(64)}`, { mode: 0o600 });

  async function waitForDeliveries(count: number) {
    for (let attempts = 0; attempts < 170 && received.length < count; attempts++) await delay(100);
    assert.equal(received.length, count);
  }

  try {
    const withoutOptIn = await readClaudeSession(parent, { live: true, projectDirectory: project, captureDetails: true });
    assert.equal(withoutOptIn?.session.capture?.subagents, undefined);
    await cli("start");
    await waitForDeliveries(1);
    const initial = received[0];
    assert.equal(initial.sourceSessionId, id);
    assert.equal(initial.events.length, 2);
    assert.equal(initial.activity?.children.length, 5);
    assert.equal(initial.capture?.subagents?.source, "claude-code-sidecar");
    assert.equal(initial.capture?.subagents?.transcripts.length, 3);
    assert.deepEqual(initial.capture?.subagents?.transcripts.map(({ parentAgentId }) => parentAgentId), [undefined, "visible", "grandchild"]);
    assert.equal(initial.capture?.subagents?.transcripts[1].messages.length, 0, "An intermediate run may contain only the calls to its children.");
    assert.equal(initial.capture?.subagents?.truncated, true, "The claimed link back to an ancestor is skipped.");
    const transcript = initial.capture?.subagents?.transcripts[0];
    assert.ok(transcript);
    assert.deepEqual([transcript.line, transcript.index], [initial.activity?.children[0].line, initial.activity?.children[0].index]);
    assert.deepEqual(transcript.messages.map(({ text }) => text), ["Inspect only test files", "First child answer: [REDACTED TOKEN]"]);
    assert.doesNotMatch(JSON.stringify(initial.capture?.subagents), /ghp_|HIDDEN|unreferenced|Wrong|Symlinked|Hardlinked/u);
    await appendFile(greatGrandchildPath, jsonl(child("great-grandchild", "assistant", "Follow-up without any new parent record")));
    await waitForDeliveries(2);
    const updated = received[1];
    assert.equal(updated.capture?.throughLine, initial.capture?.throughLine);
    assert.deepEqual(updated.events, initial.events);
    assert.equal(updated.capture?.subagents?.transcripts[2].messages.at(-1)?.text, "Follow-up without any new parent record");
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
