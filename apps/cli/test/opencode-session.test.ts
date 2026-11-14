import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { sessionImportRequest } from "@tideline/contracts";
import { discoverOpenCodeSessions, readOpenCodeSessions } from "../src/opencode-session";

const start = Date.parse("2026-11-14T00:00:00.000Z");

async function fixture(context: TestContext, filename: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-opencode-")));
  context.after(() => rm(root, { force: true, recursive: true }));
  const [project, other, storage] = ["project", "project-other", "storage"].map((name) => join(root, name));
  await Promise.all([mkdir(project), mkdir(other), mkdir(storage)]);
  const database = join(storage, filename);
  const db = new DatabaseSync(database);
  context.after(() => db.close());
  return { db, database, project, other, storage };
}

async function projected(root: string, projectDirectory: string) {
  const sessions = [];
  for await (const result of readOpenCodeSessions(root, { live: true, projectDirectory, since: start })) {
    sessions.push(result);
  }
  return sessions;
}

test("OpenCode discovery reads session metadata without a conversation payload column", async (context) => {
  const { db, project, storage } = await fixture(context, "opencode.db");
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, fork_session_id TEXT, time_created INTEGER);
    CREATE TABLE session_message (session_id TEXT, type TEXT);
  `);
  const insert = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)");
  insert.run("ses_history", project, null, null, start - 1_000);
  insert.run("ses_child", project, "ses_history", null, start);
  insert.run("ses_moved", project, null, null, start);
  db.prepare("INSERT INTO session_message VALUES (?, ?)").run("ses_moved", "location-switched");

  const candidates = [];
  for await (const candidate of discoverOpenCodeSessions(storage)) candidates.push(candidate);
  assert.deepEqual(candidates.map(({ source, startedAt, projectDirectory }) => ({ source, startedAt, projectDirectory })), [{
    source: "opencode", startedAt: new Date(start - 1_000).toISOString(), projectDirectory: project,
  }]);
});

test("OpenCode V2 syncs an approved root conversation and extends it after a response completes", async (context) => {
  const { db, database, project, other, storage } = await fixture(context, "opencode-prod.db");
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, fork_session_id TEXT, workspace_id TEXT, time_created INTEGER
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT
    );
    CREATE TABLE session_part (message_id TEXT, session_id TEXT, type TEXT, ordinal INTEGER, data TEXT);
  `);
  await symlink(other, join(project, "outside"), "dir");
  const insertSession = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)");
  const insertMessage = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)");
  const message = (session: string, seq: number, type: string, data: object) => {
    insertMessage.run(`${session}-${seq}`, session, type, seq, start + seq, JSON.stringify(data));
  };
  insertSession.run("ses_allowed", project, null, null, null, start);
  insertSession.run("ses_outside", other, null, null, null, start);
  insertSession.run("ses_symlink", join(project, "outside"), null, null, null, start);
  insertSession.run("ses_relative", "project", null, null, null, start);
  insertSession.run("ses_child", project, "ses_allowed", null, null, start);
  insertSession.run("ses_fork", project, null, "ses_outside", null, start);
  insertSession.run("ses_remote", project, null, null, "workspace_other", start);
  insertSession.run("ses_moved", project, null, null, null, start);
  insertSession.run("ses_old", project, null, null, null, start - 1);
  for (const id of ["outside", "symlink", "relative", "child", "fork", "remote", "moved", "old"]) {
    message(`ses_${id}`, 1, "user", { text: `excluded ${id}` });
  }
  message("ses_moved", 2, "location-switched", { location: { directory: project }, previous: { location: { directory: other } } });
  message("ses_moved", 3, "user", { text: "exclude after moving as well" });
  message("ses_allowed", 1, "user", { text: "OpenCode prompt", files: [{ uri: "hidden attachment" }] });
  message("ses_allowed", 2, "synthetic", { text: "hidden generated prompt" });
  const model = { id: "gpt-5.4", providerID: "openai" };
  message("ses_allowed", 3, "assistant", { time: {}, model, content: [{ type: "text", text: "streaming draft" }] });
  message("ses_allowed", 4, "user", { text: "Follow-up TOKEN=fixture_secret" });

  const before = await readFile(database);
  const pending = await projected(storage, project);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].session.events.map(({ text }) => text), ["OpenCode prompt"]);
  assert.deepEqual(await readFile(database), before);

  const insertPart = db.prepare("INSERT INTO session_part VALUES (?, ?, ?, ?, ?)");
  insertPart.run("ses_allowed-3", "ses_allowed", "reasoning", 0, JSON.stringify({ text: "hidden reasoning" }));
  insertPart.run("ses_allowed-3", "ses_allowed", "text", 1, JSON.stringify({ type: "text", text: "OpenCode response" }));
  insertPart.run("ses_allowed-3", "ses_allowed", "tool", 2, JSON.stringify({ text: "hidden tool output" }));
  const tokens = { input: 12, output: 8, reasoning: 3, cache: { read: 7, write: 2 } };
  db.prepare("UPDATE session_message SET data = ? WHERE id = ?").run(JSON.stringify({
    time: { completed: start + 3 }, model, tokens, content: [{ type: "text", text: "Inline continuation" }],
  }), "ses_allowed-3");
  const complete = await projected(database, project);
  assert.equal(complete.length, 1);
  assert.equal(complete[0].session.source, "opencode");
  assert.equal(complete[0].session.sourceSessionId, pending[0].session.sourceSessionId);
  assert.equal(complete[0].projectDirectory, project);
  assert.deepEqual(complete[0].session.events.map(({ text }) => text), [
    "OpenCode prompt", "OpenCode response\nInline continuation", "Follow-up TOKEN=fixture_secret",
  ]);
  assert.deepEqual(complete[0].session.events[0], pending[0].session.events[0]);
  assert.deepEqual(complete[0].session.analytics?.models, [{
    model: "gpt-5.4", tokens: { input: 12, cachedInput: 7, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 2, output: 11 },
  }]);
  assert.equal(complete[0].session.analytics?.tokenCoverage, "partial");
  assert.deepEqual(complete[0].evidence?.findings, [{ rule: "possible-credential", line: 3 }]);
  assert.equal(sessionImportRequest.safeParse({
    version: 1, workspaceId: "dd5b7b78-a64b-411c-b802-d2ed515b0cd7", session: complete[0].session,
  }).success, true);

  message("ses_allowed", 5, "assistant", { time: {}, model, content: [{ type: "text", text: "stale draft" }] });
  message("ses_allowed", 6, "assistant", {
    time: { completed: start + 6 }, model, tokens, content: [{ type: "text", text: "Response after retry" }],
  });
  const [afterRetry] = await projected(storage, project);
  assert.deepEqual(afterRetry.session.events.slice(0, -1), complete[0].session.events);
  assert.deepEqual(afterRetry.session.events.at(-1), {
    role: "assistant", text: "Response after retry", line: 5, timestamp: new Date(start + 6).toISOString(),
  });
  assert.equal(afterRetry.session.analytics?.tokenCoverage, "partial");
});

test("OpenCode legacy SQLite waits for a settled turn and ignores synthetic parts", async (context) => {
  const { db, project, storage } = await fixture(context, "opencode.db");
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, time_created INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `);
  db.prepare("INSERT INTO session VALUES ('ses_legacy', ?, NULL, ?)").run(project, start);
  const message = (id: string, at: number, data: object) => {
    db.prepare("INSERT INTO message VALUES (?, 'ses_legacy', ?, ?)").run(id, at, JSON.stringify(data));
  };
  const part = (id: string, messageId: string, data: object) => {
    db.prepare("INSERT INTO part VALUES (?, ?, 'ses_legacy', ?)").run(id, messageId, JSON.stringify(data));
  };
  message("msg_prompt", start, { role: "user", summary: { title: "Legacy generated title" } });
  part("prt_1", "msg_prompt", { type: "text", text: "Legacy prompt" });
  assert.deepEqual(await projected(storage, project), []);

  message("msg_reply", start + 1, { role: "assistant", time: { completed: start + 2 }, modelID: "legacy-model" });
  part("prt_2", "msg_reply", { type: "text", text: "Legacy response" });
  part("prt_3", "msg_reply", { type: "text", text: "hidden injection", synthetic: true });
  part("prt_4", "msg_reply", { type: "text", text: "hidden ignored", ignored: true });
  message("msg_pending", start + 3, { role: "user" });
  part("prt_5", "msg_pending", { type: "text", text: "Incomplete turn" });
  const [result] = await projected(storage, project);
  assert.deepEqual(result.session.events.map(({ text }) => text), ["Legacy prompt", "Legacy response"]);
  assert.deepEqual(result.session.analytics?.models, [{ model: "legacy-model", tokens: null }]);
  assert.equal(result.session.analytics?.tokenCoverage, "unavailable");
});
