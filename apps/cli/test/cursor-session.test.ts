import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { readCursorSessions } from "../src/cursor-session";
import type { LiveSession } from "../src/session-jsonl";

const startedAt = Date.parse("2026-11-14T09:00:00Z");

async function fixture(context: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tideline-cursor-")));
  const root = join(directory, "User");
  const approved = join(directory, "approved directory");
  const excluded = join(directory, "approved directory-other");
  await Promise.all([root, approved, excluded].map((path) => mkdir(path)));
  await mkdir(join(root, "globalStorage"));
  const database = new DatabaseSync(join(root, "globalStorage", "state.vscdb"));
  context.after(async () => {
    database.close();
    await rm(directory, { force: true, recursive: true });
  });
  database.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
    CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);`);

  function store(key: string, value: unknown) {
    database.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)").run(key, JSON.stringify(value));
  }

  async function read() {
    const sessions: LiveSession[] = [];
    for await (const session of readCursorSessions(root, { live: true, projectDirectory: approved, since: startedAt })) {
      sessions.push(session);
    }
    return sessions;
  }

  return { approved, excluded, root, database, store, read };
}

function membership(directory: string, id = "workspace") {
  return { id, uri: { scheme: "file", external: pathToFileURL(directory).href, fsPath: directory } };
}

test("Cursor sync reads only recent chats with verified project membership from a live database", async (context) => {
  const cursor = await fixture(context);
  cursor.database.exec(`CREATE TABLE composerHeaders (
    composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, isSubagent INTEGER, value BLOB);`);
  const index = cursor.database.prepare("INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?)");
  for (const [id, directory, at, isSubagent] of [
    ["approved", cursor.approved, startedAt, false],
    ["outside", cursor.excluded, startedAt, false],
    ["stale", cursor.approved, startedAt - 1_000, false],
    ["child", cursor.approved, startedAt, true],
    ["conflict", cursor.approved, startedAt, false],
    ["moved", cursor.approved, startedAt, false],
    ["orphan", undefined, startedAt, false],
  ] satisfies [string, string | undefined, number, boolean][]) {
    const workspaceIdentifier = directory ? membership(directory) : { id: "detached" };
    index.run(id, workspaceIdentifier.id, at, Number(isSubagent), JSON.stringify({ workspaceIdentifier }));
    cursor.store(`composerData:${id}`, {
      composerId: id, status: "completed", workspaceIdentifier: id === "conflict" ? membership(cursor.excluded) : workspaceIdentifier,
      agentLocationHistory: id === "moved" ? [{ reason: "moved" }] : undefined,
      fullConversationHeadersOnly: [{ bubbleId: "question", type: 1 }, { bubbleId: "answer", type: 2 }],
    });
    cursor.store(`bubbleId:${id}:question`, { type: 1, text: `Prompt in ${id}`, createdAt: startedAt });
    cursor.store(`bubbleId:${id}:answer`, {
      type: 2, text: `Reply in ${id}`, createdAt: new Date(startedAt + 1_000).toISOString(),
      modelInfo: { modelName: "cursor-model" }, tokenCount: { inputTokens: 100, outputTokens: 20 },
      capabilities: { reasoning: "Hidden reasoning", tools: [{ result: "Private tool result" }] },
    });
  }
  cursor.store("composerData:unlisted", { createdAt: startedAt, status: "completed", fullConversationHeadersOnly: [] });

  const [result, ...others] = await cursor.read();
  assert.deepEqual(others, []);
  assert.ok(result);
  assert.equal(result.projectDirectory, cursor.approved);
  assert.equal(result.session.source, "cursor");
  assert.match(result.session.sourceSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(result.session.startedAt, new Date(startedAt).toISOString());
  assert.deepEqual(result.session.events.map(({ role, text, line }) => ({ role, text, line })), [
    { role: "user", text: "Prompt in approved", line: 1 },
    { role: "assistant", text: "Reply in approved", line: 2 },
  ]);
  assert.deepEqual(result.session.analytics?.models, [{ model: "cursor-model", tokens: null }]);
  assert.equal(result.session.analytics?.tokenCoverage, "unavailable");
  assert.equal(result.session.activity, undefined);
});

test("Cursor sync keeps an appendable prefix while the final reply is streaming", async (context) => {
  const cursor = await fixture(context);
  const id = "conversation";
  const workspaceIdentifier = membership(cursor.approved);
  const header = { allComposers: [{ composerId: id, createdAt: startedAt, workspaceIdentifier }] };
  cursor.database.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("composer.composerHeaders", JSON.stringify(header));

  const details = {
    composerId: id, workspaceIdentifier: { id: workspaceIdentifier.id }, fullConversationHeadersOnly: [
      { bubbleId: "q", type: 1 }, { bubbleId: "a", type: 2 }, { bubbleId: "tool", type: 2 },
    ],
  };
  cursor.store(`composerData:${id}`, { ...details, status: "generating", fullConversationHeadersOnly: [
    { bubbleId: "optimistic", type: 1, isDisplayOnly: true }, ...details.fullConversationHeadersOnly,
    { bubbleId: "simulated", type: 1 },
  ] });
  cursor.store(`bubbleId:${id}:optimistic`, { type: 1, text: "Pending user input" });
  cursor.store(`bubbleId:${id}:simulated`, { type: 1, text: "Private system prompt", isSimulatedMsg: true });
  cursor.store(`bubbleId:${id}:q`, { type: 1, text: "What is the answer?" });
  cursor.store(`bubbleId:${id}:a`, { type: 2, text: "Draft" });
  cursor.store(`bubbleId:${id}:tool`, { type: 2, toolFormerData: { stdout: "Private output" }, text: "Tool output" });

  const [pending] = await cursor.read();
  assert.ok(pending);
  assert.deepEqual(pending.session.events.map(({ text }) => text), ["What is the answer?"]);
  cursor.store(`composerData:${id}`, { ...details, status: "completed" });
  cursor.store(`bubbleId:${id}:a`, { type: 2, text: "The final answer" });
  const [ready] = await cursor.read();
  assert.ok(ready);
  assert.equal(ready.session.sourceSessionId, pending.session.sourceSessionId);
  assert.deepEqual(ready.session.events.slice(0, 1), pending.session.events);
  assert.deepEqual(ready.session.events.map(({ text }) => text), ["What is the answer?", "The final answer"]);
});

test("Cursor sync resolves legacy workspace lists and reads embedded message bubbles", async (context) => {
  const cursor = await fixture(context);
  const id = "local-list";
  const workspace = join(cursor.root, "workspaceStorage", "by-hash");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "workspace.json"), JSON.stringify({ folder: pathToFileURL(cursor.approved).href }));
  const workspaceDatabase = new DatabaseSync(join(workspace, "state.vscdb"));
  try {
    workspaceDatabase.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    workspaceDatabase.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
      "composer.composerData", JSON.stringify({ allComposers: [{ composerId: id, createdAt: startedAt }] }),
    );
  } finally {
    workspaceDatabase.close();
  }
  cursor.store(`composerData:${id}`, {
    composerId: id, status: "completed",
    fullConversationHeadersOnly: [{ bubbleId: "user", type: 1 }, { bubbleId: "assistant", type: 2 }],
    conversationMap: { user: { text: "A legacy prompt" }, assistant: { text: "A legacy reply" } },
  });

  const [session, ...others] = await cursor.read();
  assert.deepEqual(others, []);
  assert.ok(session);
  assert.deepEqual(session.session.events.map(({ text }) => text), ["A legacy prompt", "A legacy reply"]);
});

test("Cursor sync skips a database with a symlinked sidecar and recovers on the next read", async (context) => {
  const cursor = await fixture(context);
  const id = "eventual";
  cursor.database.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("composer.composerHeaders", JSON.stringify({
    allComposers: [{ composerId: id, createdAt: startedAt, workspaceIdentifier: membership(cursor.approved) }],
  }));
  cursor.store(`composerData:${id}`, {
    composerId: id, status: "completed", fullConversationHeadersOnly: [{ bubbleId: "q", type: 1 }],
  });
  cursor.store(`bubbleId:${id}:q`, { text: "Read me after removing the symlink" });

  const journal = join(cursor.root, "globalStorage", "state.vscdb-journal");
  await symlink(join(cursor.root, "outside"), journal);
  assert.deepEqual(await cursor.read(), []);
  await rm(journal);
  assert.equal((await cursor.read())[0]?.session.events[0]?.text, "Read me after removing the symlink");
});
