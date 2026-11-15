import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { MAX_SESSION_CAPTURE_TEXT, sessionImportRequest } from "@tideline/contracts";
import { readClaudeSession } from "../src/claude-session";
import { readCodexSession } from "../src/codex-session";
import type { LiveSession } from "../src/session-jsonl";

const timestamp = "2026-10-01T00:00:00.000Z";
const credential = "ghp_0123456789abcdefghijklmnopqrstuv";
const response = (payload: object) => ({ timestamp, type: "response_item", payload });
const event = (payload: object) => ({ timestamp, type: "event_msg", payload });
const jsonl = (...records: object[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

async function fixture(context: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tideline-capture-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const id = randomUUID();
  return { directory, id, transcript: join(directory, `${id}.jsonl`) };
}

function validateCapture(result: LiveSession | undefined) {
  assert.ok(result);
  const { capture } = sessionImportRequest.parse({ version: 1, workspaceId: randomUUID(), session: result.session }).session;
  assert.ok(capture);
  return capture;
}

test("Codex capture correlates full textual tool results and records only completed repository file changes", async (context) => {
  const { directory, id, transcript } = await fixture(context);
  const fileChange = (status: string, changes: object) => event({
    type: "item_completed", thread_id: id,
    item: { type: "FileChange", id: randomUUID(), status, changes },
  });
  await writeFile(transcript, jsonl(
    { timestamp, type: "session_meta", payload: { id, cwd: directory, cli_version: "0.42.1",
      model_provider: "openai", originator: "codex_cli_rs", base_instructions: "PRIVATE-INSTRUCTIONS" } },
    { timestamp, type: "turn_context", payload: { model: "gpt-5.2", effort: "high", approval_policy: "on-request",
      sandbox_policy: { type: "workspace-write", writable_roots: ["/private/irrelevant"] } } },
    response({ type: "message", role: "user", content: [{ type: "input_text", text: "Update the tests." }] }),
    response({ type: "custom_tool_call", name: "exec_command", call_id: "cmd",
      input: JSON.stringify({ command: "test", apiKey: "PRIVATE-JSON-KEY" }) }),
    response({ type: "custom_tool_call_output", call_id: "cmd", output: [
      { type: "input_text", text: `first line\nsecond line ${credential}\nlast line` },
      { type: "input_image", image_url: "data:image/png;base64,PRIVATEIMAGE" },
    ] }),
    fileChange("completed", {
      [join(directory, "src", "test.ts")]: { type: "update", unified_diff:
        `--- ${directory}/src/test.ts\n+++ ${directory}/src/test.ts\n@@ -1 +1 @@\n-old value\n+const token = "${credential}";` },
      [join(directory, "src", "new.ts")]: { type: "add", content: "new value\n" },
      [join(directory, "src", "removed.ts")]: { type: "delete", content: "removed value\n" },
      [join(directory, ".env")]: { type: "add", content: "UNSTRUCTURED-SENSITIVE-CONTENT" },
      [join(directory, "..", "private.txt")]: { type: "add", content: "CROSSED-SCOPE" },
    }),
    fileChange("failed", { [join(directory, "failed.ts")]: { type: "add", content: "FAILED-FILE" } }),
    response({ type: "custom_tool_call", name: "apply_patch", call_id: "sensitive-patch",
      input: "*** Begin Patch\n*** Update File: .env\n@@\n+PRIVATE-PATCH\n*** End Patch" }),
    response({ type: "custom_tool_call_output", call_id: "sensitive-patch", output: "PRIVATE-PATCH-OUTPUT" }),
    response({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }),
  ));

  const options = { live: true, projectDirectory: directory } as const;
  assert.equal((await readCodexSession(transcript, options))?.session.capture, undefined);
  const result = await readCodexSession(transcript, { ...options, captureDetails: true });
  const capture = validateCapture(result);
  assert.equal(capture.tools[0].line, result?.session.activity?.tools[0].line);
  assert.match(capture.tools[0].input ?? "", /"apiKey": "\[REDACTED\]"/u);
  assert.equal(capture.tools[0].output, "first line\nsecond line [REDACTED TOKEN]\nlast line\n[Attachment omitted]");
  assert.equal(capture.tools.at(-1)?.output, null);
  assert.ok(capture.truncated);
  assert.deepEqual(capture.setup, {
    clientVersion: "0.42.1", provider: "openai", entrypoint: "codex_cli_rs", model: "gpt-5.2",
    reasoningEffort: "high", approvalPolicy: "on-request", sandboxMode: "workspace-write",
  });
  assert.deepEqual(capture.files.map(({ path, change }) => [path, change]),
    [["src/test.ts", "modified"], ["src/new.ts", "added"], ["src/removed.ts", "deleted"]]);
  assert.match(capture.files[0].diff ?? "", /^--- a\/src\/test.ts\n\+\+\+ b\/src\/test.ts\n@@ -1 \+1 @@/u);
  assert.match(capture.files[1].diff ?? "", /^--- \/dev\/null\n\+\+\+ b\/src\/new.ts\n@@ -0,0 \+1,1 @@\n\+new value/u);
  assert.match(capture.files[2].diff ?? "", /^--- a\/src\/removed.ts\n\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@\n-removed value/u);
  assert.doesNotMatch(JSON.stringify(capture), /PRIVATE-|CROSSED-SCOPE|UNSTRUCTURED-SENSITIVE|FAILED-FILE|ghp_/u);
  assert.deepEqual(validateCapture(await readCodexSession(transcript, { ...options, captureDetails: true })), capture);
});

test("Claude Code capture uses recorded edit hunks and only opens verified session output sidecars", async (context) => {
  const { directory, id, transcript } = await fixture(context);
  const sidecars = join(directory, id, "tool-results");
  await mkdir(sidecars, { recursive: true });
  const recorded = join(sidecars, "tool_result.txt");
  await writeFile(recorded, `complete first line\nAuthorization: Bearer ${credential}\ncomplete last line`);
  const outside = join(directory, "non-session.txt");
  await writeFile(outside, "SIDE-CAR-NOT-AUTHORIZED");
  const link = join(sidecars, "symlink.txt");
  await symlink(outside, link);

  const record = (type: "assistant" | "user", content: string | object[], toolUseResult?: object) => ({
    timestamp, type, sessionId: id, cwd: directory, gitBranch: "feature/mock", entrypoint: "cli",
    version: "2.1.10", permissionMode: "acceptEdits", toolUseResult, message: { role: type, content,
      ...(type === "assistant" && { model: "claude-sonnet-4-6", id: randomUUID() }),
    },
  });
  const call = (toolId: string, name: string, input: object) =>
    record("assistant", [{ type: "tool_use", id: toolId, name, input }]);
  const result = (toolId: string, content: string, metadata: object, failed = false) =>
    record("user", [{ type: "tool_result", tool_use_id: toolId, content, is_error: failed }], metadata);
  const targetPath = join(directory, "check.ts");
  await writeFile(transcript, jsonl(
    record("user", "Inspect the code."),
    call("edit", "Edit", { file_path: targetPath, old_string: "before", new_string: "after" }),
    result("edit", "Edit complete", { filePath: targetPath, originalFile: "FULL-ORIGINAL-FILE",
      structuredPatch: [{ oldStart: 82, oldLines: 1, newStart: 82, newLines: 1, lines: ["-before", "+after"] }] }),
    call("bash", "Bash", { command: "run tests" }),
    result("bash", "truncated preview", { persistedOutputPath: recorded, stdout: "truncated preview" }),
    call("unsafe", "Bash", { command: "examine linked output" }),
    result("unsafe", "link fallback", { persistedOutputPath: link }),
    call("outside", "Bash", { command: "examine unrelated output" }),
    result("outside", "outside fallback", { persistedOutputPath: outside }),
    call("read", "Read", { file_path: join(directory, ".env") }),
    result("read", "PRIVATE-READ-OUTPUT", {}),
    call("failed", "Write", { file_path: join(directory, "failed.ts"), content: "unapplied change" }),
    result("failed", "permission denied", {}, true),
    record("assistant", "Done."),
  ));
  const capture = validateCapture(await readClaudeSession(transcript,
    { live: true, projectDirectory: directory, captureDetails: true }));
  assert.deepEqual(capture.files.map(({ path, diff }) => [path, diff]), [
    ["check.ts", "--- a/check.ts\n+++ b/check.ts\n@@ -82,1 +82,1 @@\n-before\n+after"],
  ]);
  assert.equal(capture.tools[1].output, "complete first line\nAuthorization: Bearer [REDACTED TOKEN]\ncomplete last line");
  assert.equal(capture.tools[2].output, "link fallback");
  assert.equal(capture.tools[3].output, "outside fallback");
  assert.equal(capture.tools[4].output, null);
  assert.ok(capture.tools[2].truncated && capture.tools[3].truncated && capture.tools[4].truncated);
  assert.deepEqual(capture.setup, {
    clientVersion: "2.1.10", entrypoint: "cli", branch: "feature/mock", permissionMode: "acceptEdits", model: "claude-sonnet-4-6",
  });
  assert.doesNotMatch(JSON.stringify(capture), /FULL-ORIGINAL-FILE|SIDE-CAR-NOT-AUTHORIZED|PRIVATE-READ-OUTPUT|ghp_/u);
});

test("Opted-in capture reads larger logs but keeps individual text under its upload limit", async (context) => {
  const { directory, id, transcript } = await fixture(context);
  await writeFile(transcript, jsonl(
    { timestamp, type: "session_meta", payload: { id, cwd: directory } },
    response({ type: "message", role: "user", content: [{ type: "input_text", text: "Run the full check." }] }),
    response({ type: "function_call", name: "run", call_id: "long" }),
    response({ type: "function_call_output", call_id: "long", output: "a".repeat(1024 * 1024) }),
    response({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }),
  ));
  await assert.rejects(readCodexSession(transcript, { live: true, projectDirectory: directory }), /1 MiB/u);
  const capture = validateCapture(await readCodexSession(transcript,
    { live: true, projectDirectory: directory, captureDetails: true }));
  assert.equal(capture.tools[0].output?.length, MAX_SESSION_CAPTURE_TEXT);
  assert.equal(capture.tools[0].truncated, true);
});
