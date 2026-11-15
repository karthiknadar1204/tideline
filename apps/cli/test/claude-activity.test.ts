import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_SESSION_ACTIVITY_ITEMS, sessionImportRequest } from "@tideline/contracts";
import { readClaudeSession } from "../src/claude-session";

function records(cwd: string) {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const sessionId = randomUUID();
  function entry(type: "assistant" | "user", content: unknown, extra = {}) {
    return { type, cwd, timestamp, sessionId, message: { role: type, content }, ...extra };
  }
  function result(id: string, metadata: object, isError?: boolean) {
    return entry("user", [{ type: "tool_result", tool_use_id: id, content: "PRIVATE_PAYLOAD", is_error: isError }], {
      sourceToolAssistantUUID: "private-source-uuid", toolUseResult: metadata,
    });
  }
  return { entry, result };
}

function jsonl(records: object[]) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("Claude sync links tool and child results without including their payloads", async (context) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tideline-claude-activity-")));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  const path = join(cwd, "session.jsonl");
  const { entry, result } = records(cwd);
  const mainToolUse = entry("assistant", [
    { type: "text", text: "I will check that." },
    { type: "tool_use", id: "toolu_private_shell", name: "Bash", input: { command: "PRIVATE_COMMAND" } },
    { type: "tool_use", id: "toolu_private_skill", name: "Skill", input: { skill: "plugin:sample", args: "PRIVATE_ARGS" } },
    { type: "tool_use", id: "toolu_private_agent", name: "Agent", input: { subagent_type: "Explore", prompt: "PRIVATE_PROMPT" } },
  ]);
  await writeFile(path, jsonl([
    entry("user", "Run an activity check."),
    mainToolUse,
    entry("assistant", mainToolUse.message.content.slice(1)),
    { ...result("toolu_private_shell", {}, true), timestamp: "2026-01-01T00:00:01.100Z" },
    result("toolu_private_skill", { success: true, commandName: "plugin:sample" }),
    result("toolu_private_agent", { status: "async_launched", agentId: "private-agent-id" }),
    entry("user", "PRIVATE_INSTRUCTIONS", { isMeta: true }),
    entry("assistant", [{ type: "tool_use", id: "toolu_sidechain", name: "ExcludedTool" }], { isSidechain: true }),
    entry("assistant", "I started the check."),
  ]));
  const options = { live: true, projectDirectory: cwd } as const;
  const initial = await readClaudeSession(path, options);
  assert.deepEqual(initial?.session.activity?.tools.map(({ name, status }) => [name, status]), [
    ["Bash", "failed"], ["Skill", "returned"], ["Agent", "returned"],
  ]);
  assert.deepEqual(initial?.session.activity?.tools[0]?.timing, { startedAt: "2026-01-01T00:00:00.000Z", elapsedMs: 1_100 });
  assert.deepEqual(initial?.session.activity?.skills, [{ line: 2, index: 2, name: "plugin:sample", status: "invoked" }]);
  assert.deepEqual(initial?.session.activity?.children, [{ line: 2, index: 3, name: "Explore", status: "running" }]);

  function notification(taskId: string) {
    return [
      "<task-notification>", `<task-id>${taskId}</task-id>`, "<tool-use-id>toolu_private_agent</tool-use-id>",
      "<output-file>/PRIVATE_PATH</output-file>", "<status>completed</status>",
      "<result>PRIVATE_PAYLOAD</result>", "</task-notification>",
    ].join("\n");
  }
  const origin = { kind: "task-notification" };
  await appendFile(path, jsonl([entry("user", notification("another-agent"), { origin })]));
  const wrongAgent = await readClaudeSession(path, options);
  assert.equal(wrongAgent?.session.activity?.children[0]?.status, "running");

  await appendFile(path, jsonl([entry("user", notification("private-agent-id"), { origin })]));
  const complete = await readClaudeSession(path, options);
  assert.ok(initial?.session.activity && complete?.session.activity);
  assert.equal(complete.session.activity.children[0]?.status, "completed");
  assert.ok(complete.session.activity.throughLine > initial.session.activity.throughLine);
  assert.deepEqual(complete.session.events, initial.session.events);
  const upload = sessionImportRequest.parse({ version: 1, workspaceId: randomUUID(), session: complete.session });
  assert.doesNotMatch(JSON.stringify(upload), /PRIVATE_|toolu_private|private-agent-id|private-source-uuid|ExcludedTool/);
});

test("Claude only counts a slash skill once and caps long activity lists", async (context) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tideline-claude-slash-")));
  context.after(() => rm(cwd, { force: true, recursive: true }));
  const path = join(cwd, "session.jsonl");
  const { entry } = records(cwd);
  const slashId = randomUUID();
  const command = "<command-message>sample</command-message>\n<command-name>/sample</command-name>\n<command-args>PRIVATE_ARGS</command-args>";
  const manyTools = Array.from({ length: MAX_SESSION_ACTIVITY_ITEMS + 1 }, (_, index) => ({
    type: "tool_use", id: `toolu_many_${index}`, name: "Read", input: { file_path: "/PRIVATE_PATH" },
  }));
  await writeFile(path, jsonl([
    entry("user", command, { uuid: randomUUID() }),
    entry("assistant", "An unrelated reply.", { attributionSkill: "sample" }),
    entry("user", command, { uuid: slashId }),
    entry("user", "PRIVATE_INSTRUCTIONS", { isMeta: true, turnCompanion: true, parentUuid: slashId }),
    entry("assistant", "The skill was loaded.", { attributionSkill: "sample" }),
    entry("assistant", manyTools, { attributionSkill: "sample" }),
  ]));

  const result = await readClaudeSession(path);
  assert.deepEqual(result.activity?.skills, [{ line: 3, index: 0, name: "sample", status: "invoked" }]);
  assert.equal(result.activity?.tools.length, MAX_SESSION_ACTIVITY_ITEMS);
  assert.equal(result.activity?.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|toolu_many/);
});
