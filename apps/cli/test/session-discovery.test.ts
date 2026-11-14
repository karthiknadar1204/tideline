import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverClaudeSession, readClaudeSession } from "../src/claude-session";
import { discoverCodexSession, readCodexSession } from "../src/codex-session";
import type { LiveReadOptions } from "../src/session-jsonl";

test("File discovery returns session identity and does not parse later conversation records", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-discover-jsonl-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const codex = join(root, "codex.jsonl");
  const claude = join(root, "claude.jsonl");
  const id = "25dbe006-33be-4af4-9294-69f9cb358c49";
  const timestamp = "2026-09-25T12:00:00.000Z";
  await writeFile(codex, `${JSON.stringify({ type: "session_meta", timestamp, payload: { id, cwd: root } })}\ninvalid later JSON\n`);
  await writeFile(claude, `${JSON.stringify({ type: "file-history-snapshot" })}\n${JSON.stringify({
    type: "user", timestamp, sessionId: id, cwd: root, message: { role: "user", content: "private prompt" },
  })}\ninvalid later JSON\n`);

  const candidate = { sourceSessionId: id, startedAt: timestamp, projectDirectory: root };
  assert.deepEqual(await discoverCodexSession(codex), { source: "codex", ...candidate });
  assert.deepEqual(await discoverClaudeSession(claude), { source: "claude-code", ...candidate });

  const excludeOlder = { live: true, projectDirectory: root, sessionAllowed: () => false } satisfies LiveReadOptions;
  assert.equal(await readCodexSession(codex, excludeOlder), undefined);
  assert.equal(await readClaudeSession(claude, excludeOlder), undefined);
});

test("Codex and Claude can move within one checkout but decline sessions that cross selected checkouts", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-checkout-scope-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const nested = join(first, "nested");
  const second = join(root, "second");
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(second)]);
  const codex = join(root, "codex.jsonl");
  const claude = join(root, "claude.jsonl");
  const id = "25dbe006-33be-4af4-9294-69f9cb358c49";
  const timestamp = "2026-09-25T12:00:00.000Z";
  const checkouts = new Map([[first, first], [nested, first], [second, second]]);
  const options = {
    live: true,
    projectScope: async (path) => path && checkouts.has(path) ? path : undefined,
    projectRoot: (path) => checkouts.get(path),
  } satisfies LiveReadOptions;

  async function writeSessions(cwd: string) {
    const codexRecords = [
      { type: "session_meta", payload: { id, cwd: first, runtime_workspace_roots: [nested] } },
      { type: "turn_context", payload: { cwd } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] } },
    ];
    const claudeRecords = [
      { type: "user", sessionId: id, cwd: first, message: { role: "user", content: "Question" } },
      { type: "assistant", sessionId: id, cwd, message: { role: "assistant", content: "Answer" } },
    ];
    const jsonl = (records: object[]) => records.map((record) => JSON.stringify({ ...record, timestamp })).join("\n") + "\n";
    await Promise.all([writeFile(codex, jsonl(codexRecords)), writeFile(claude, jsonl(claudeRecords))]);
  }

  await writeSessions(nested);
  assert.deepEqual((await readCodexSession(codex, options))?.session.events.map(({ text }) => text), ["Answer"]);
  assert.deepEqual((await readClaudeSession(claude, options))?.session.events.map(({ text }) => text), ["Question", "Answer"]);
  await writeSessions(second);
  assert.equal(await readCodexSession(codex, options), undefined);
  assert.equal(await readClaudeSession(claude, options), undefined);
});
