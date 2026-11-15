import assert from "node:assert/strict";
import { estimateSessionModelCost, sessionImportRequest } from "@tideline/contracts";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readClaudeSession } from "../src/claude-session";
import { readCodexSession } from "../src/codex-session";
import { readRepository } from "../src/repository";

const timestamp = "2026-01-01T00:00:00.000Z";

function jsonl(...records: object[]) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("Codex usage advances after the last reply without counting repeated totals", async (context) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tideline-codex-")));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  const file = join(cwd, "codex.jsonl");
  const record = (type: string, payload: object) => ({ timestamp, type, payload });
  const count = (input: number, output: number) => record("event_msg", {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input, cached_input_tokens: 40, cache_write_input_tokens: 20,
        output_tokens: output, reasoning_output_tokens: 5,
      },
    },
  });
  await writeFile(file, jsonl(
    record("session_meta", { id: randomUUID(), cwd }),
    record("turn_context", { cwd, model: "gpt-5.4" }),
    record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Sample reply" }] }),
    count(100, 10),
    count(100, 10),
  ));
  const first = await readCodexSession(file, { live: true, projectDirectory: cwd });
  assert.deepEqual(first?.session.analytics?.models, [{
    model: "gpt-5.4",
    tokens: { input: 40, cachedInput: 40, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 20, output: 10 },
  }]);
  await appendFile(file, jsonl(
    record("turn_context", { cwd, model: "gpt-5.3-codex" }),
    count(120, 15),
  ));
  const updated = await readCodexSession(file, { live: true, projectDirectory: cwd });
  assert.deepEqual(updated?.session.events, first?.session.events);
  assert.equal(updated?.session.analytics?.throughLine, 7);
  assert.equal(updated?.session.analytics?.models[1]?.tokens?.input, 20);
  assert.equal(updated?.session.analytics?.models[1]?.tokens?.output, 5);
  await appendFile(file, jsonl(record("response_item", {
    type: "message", role: "user", content: [{ type: "input_text", text: "A new prompt" }],
  })));
  const pending = await readCodexSession(file, { live: true, projectDirectory: cwd });
  assert.equal(pending?.session.analytics?.tokenCoverage, "partial");
});

test("Codex traces root turns and reads completion timing after the last reply", async (context) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tideline-codex-turns-")));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  const file = join(cwd, "codex.jsonl");
  const record = (type: string, payload: object) => ({ timestamp, type, payload });
  const user = (text: string) => record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
  const tokens = (input: number, cached: number, output: number) => ({
    input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 6,
  });
  const first = tokens(100, 40, 10);
  const second = tokens(150, 70, 20);
  const count = (total: object, last: object) => record("event_msg", {
    type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 },
  });
  await writeFile(file, jsonl(
    record("session_meta", { id: randomUUID(), cwd }),
    record("event_msg", { type: "task_started", turn_id: "first", model_context_window: 258400 }),
    record("turn_context", { cwd, model: "gpt-5.4" }),
    user("Sample prompt"),
    record("event_msg", { type: "task_started", turn_id: "child", root_turn_id: "first" }),
    count(first, first),
    count(first, first),
    user("A steering prompt during the same turn"),
    count(second, tokens(50, 30, 10)),
    record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Sample reply" }] }),
  ));
  const live = await readCodexSession(file, { live: true, projectDirectory: cwd });
  assert.equal(live?.session.analytics?.turnTrace?.turns[0]?.durationMs, null);
  await appendFile(file, jsonl(
    record("event_msg", { type: "task_complete", turn_id: "first", duration_ms: 2300, time_to_first_token_ms: 230 }),
    record("event_msg", { type: "task_started", turn_id: "second" }),
    user("Pending prompt"),
  ));
  const parsed = await readCodexSession(file);
  const trace = parsed.analytics?.turnTrace;
  assert.ok(trace);
  assert.equal(trace.throughLine, 13);
  assert.equal(trace.omittedTurns, 0);
  assert.deepEqual(trace.turns.map(({ promptLine, tokenCoverage }) => [promptLine, tokenCoverage]), [[4, "reported"], [13, "unavailable"]]);
  assert.deepEqual(trace.turns[0], {
    promptLine: 4, tokenCoverage: "reported", contextWindow: 258400, peakRequestInput: 100,
    durationMs: 2300, timeToFirstTokenMs: 230,
    models: [{ model: "gpt-5.4", tokens: { input: 80, cachedInput: 70, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, output: 20 } }],
  });
  assert.equal(typeof estimateSessionModelCost("codex", trace.turns[0].models[0]), "number");
  assert.equal(sessionImportRequest.safeParse({ version: 1, workspaceId: randomUUID(), session: parsed }).success, true);
});

test("Claude counts message IDs once and keeps cache lifetimes from earlier blocks", async (context) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tideline-claude-")));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  const file = join(cwd, "claude.jsonl");
  const sessionId = randomUUID();
  const entry = (type: string, message: object, isSidechain = false) => ({
    timestamp, type, cwd, sessionId, message, isSidechain,
  });
  const reply = (id: string, usage: object, content: object[], isSidechain?: boolean) => entry("assistant", {
    role: "assistant", model: "claude-sonnet-4-6", id, usage, content,
  }, isSidechain);
  const tokens = { input_tokens: 20, output_tokens: 1, cache_creation_input_tokens: 100 };
  const tool = { type: "tool_use", name: "Bash", input: { command: "synthetic command" } };
  await writeFile(file, jsonl(
    entry("user", { role: "user", content: "Sample prompt" }),
    reply("msg_first", {
      ...tokens, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
    }, [tool]),
    reply("msg_first", { ...tokens, output_tokens: 2 }, [{ type: "text", text: "Sample reply" }]),
    reply("msg_second", { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 }, [tool]),
    reply("msg_sidechain", { input_tokens: 1000, output_tokens: 1000 }, [tool], true),
  ));
  const parsed = await readClaudeSession(file, { live: true, projectDirectory: cwd });
  assert.equal(parsed?.session.events.length, 2);
  assert.equal(parsed?.session.analytics?.throughLine, 4);
  assert.deepEqual(parsed?.session.analytics?.models, [{
    model: "claude-sonnet-4-6",
    tokens: { input: 30, cachedInput: 5, cacheWrite5m: 100, cacheWrite1h: 0, cacheWriteUnknown: 0, output: 5 },
  }]);
  const trace = parsed?.session.analytics?.turnTrace;
  assert.deepEqual(trace?.turns, [{
    promptLine: 1, tokenCoverage: "reported", models: parsed?.session.analytics?.models,
    contextWindow: null, peakRequestInput: 120, durationMs: null, timeToFirstTokenMs: null,
  }]);
  await appendFile(file, jsonl(
    entry("user", { role: "user", content: "Another prompt" }),
    reply("msg_third", { input_tokens: 1, output_tokens: 1 }, [{ type: "text", text: "Another reply" }]),
    reply("msg_first", { ...tokens, output_tokens: 2 }, [tool]),
  ));
  const updated = await readClaudeSession(file);
  const turns = updated.analytics?.turnTrace?.turns;
  assert.deepEqual(turns?.map(({ promptLine, tokenCoverage }) => [promptLine, tokenCoverage]), [[1, "partial"], [6, "partial"]]);
  assert.deepEqual(turns?.map(({ models }) => models[0]?.tokens?.output), [5, 1]);
});

test("repository keys group clone transport variants and send only the repository name", async (context) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tideline-git-")));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init");
  git("remote", "add", "origin", "https://user:synthetic@code.example/team/sample.git?token=sample#branch");
  const https = await readRepository(cwd);
  assert.equal(https?.name, "sample");
  assert.match(https?.key ?? "", /^[0-9a-f]{64}$/);
  git("remote", "set-url", "origin", "git@code.example:team/sample.git");
  assert.deepEqual(await readRepository(cwd), https);
});
