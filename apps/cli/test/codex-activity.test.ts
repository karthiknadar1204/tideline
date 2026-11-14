import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_SESSION_ACTIVITY_ITEMS, sessionImportRequest } from "@tideline/contracts";
import { readCodexSession } from "../src/codex-session";

const timestamp = "2026-10-01T00:00:00.000Z";
const response = (payload: object) => ({ timestamp, type: "response_item", payload });
const event = (payload: object) => ({ timestamp, type: "event_msg", payload });
const jsonl = (...records: object[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

async function sessionFixture(context: { after: (cleanup: () => Promise<void>) => void }) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "tideline-codex-activity-")));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, "session.jsonl");
  const id = randomUUID();
  await writeFile(file, jsonl(
    { timestamp, type: "session_meta", payload: { id, cwd } },
    response({ type: "message", role: "user", content: [{ type: "input_text", text: "Run the checks." }] }),
  ));
  return {
    append: (...records: object[]) => appendFile(file, jsonl(...records)),
    read: () => readCodexSession(file, { live: true, projectDirectory: cwd }),
    id, file,
  };
}

test("Codex sync records named tool calls, invoked skills and a deduplicated legacy child", async (context) => {
  const fixture = await sessionFixture(context);
  const childId = randomUUID();
  await fixture.append(
    response({
      type: "message", role: "user",
      content: [
        { type: "input_text", text: "<skills_instructions>PRIVATE-CATALOG</skills_instructions>" },
        { type: "input_text", text: "<skill>\n<name>test-workflow</name>\n<path>/private/SKILL.md</path>\nPRIVATE-SKILL-BODY\n</skill>" },
      ],
    }),
    response({ type: "function_call", name: "exec_command", call_id: "call_exec", arguments: "PRIVATE-COMMAND" }),
    response({ type: "function_call_output", call_id: "call_exec", output: "PRIVATE-OUTPUT" }),
    response({ type: "custom_tool_call", name: "apply_patch", call_id: "call_patch", input: "PRIVATE-PATCH" }),
    response({ type: "custom_tool_call_output", call_id: "call_patch", output: "PRIVATE-FAILED-OUTPUT", success: false }),
    response({ type: "function_call", name: "spawn_agent", namespace: "multi_agent_v1", call_id: "call_spawn",
      arguments: JSON.stringify({ agent_type: "explorer", message: "PRIVATE-CHILD-PROMPT" }) }),
    response({ type: "function_call_output", call_id: "call_spawn", output: JSON.stringify({ agent_id: childId }) }),
    event({
      type: "item_completed", thread_id: fixture.id,
      item: { type: "CollabAgentToolCall", id: "call_spawn", tool: "spawn_agent", status: "completed",
        sender_thread_id: fixture.id, receiver_thread_ids: [childId], agents_states: { [childId]: "running" } },
    }),
    response({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Checks dispatched." }] }),
  );
  const initial = await fixture.read();
  assert.ok(initial);
  assert.deepEqual(initial.session.events.map((event) => event.text), ["Run the checks.", "Checks dispatched."]);
  assert.deepEqual(initial.session.activity, {
    throughLine: 11,
    truncated: false,
    tools: [
      { line: 4, index: 0, name: "exec_command", status: "returned" },
      { line: 6, index: 0, name: "apply_patch", status: "failed" },
      { line: 8, index: 0, name: "multi_agent_v1:spawn_agent", status: "returned" },
    ],
    skills: [{ line: 3, index: 1, name: "test-workflow", status: "invoked" }],
    children: [{ line: 9, index: 0, name: "explorer", status: "running" }],
  });

  await fixture.append(
    response({ type: "function_call", name: "wait_agent", namespace: "multi_agent_v1", call_id: "call_wait", arguments: "PRIVATE-WAIT-ARGS" }),
    response({ type: "function_call_output", call_id: "call_wait",
      output: JSON.stringify({ status: { [childId]: { completed: "PRIVATE-CHILD-OUTPUT" } } }) }),
    event({ type: "sub_agent_activity", agent_thread_id: childId, kind: "interacted" }),
  );
  const updated = await fixture.read();
  assert.ok(updated);
  assert.deepEqual(updated.session.events, initial.session.events);
  assert.deepEqual(updated.session.activity?.children, [{ line: 9, index: 0, name: "explorer", status: "completed" }]);
  assert.equal(updated.session.activity?.throughLine, 14);

  const payload = sessionImportRequest.parse({ version: 1, workspaceId: randomUUID(), session: updated.session });
  const wire = JSON.stringify(payload);
  assert.doesNotMatch(wire, /PRIVATE-|\/private\/SKILL\.md|call_exec|call_wait/u);
  assert.ok(!wire.includes(childId));
});

test("Codex sync accepts durable child and tool records and ignores other threads", async (context) => {
  const fixture = await sessionFixture(context);
  const childId = randomUUID();
  const otherChild = randomUUID();
  const anotherSession = randomUUID();
  const spawn = (parent: string, child: string) => event({
    type: "item_completed", thread_id: parent,
    item: { type: "CollabAgentToolCall", id: "spawn_" + parent, tool: "spawn_agent", status: "completed",
      sender_thread_id: parent, receiver_thread_ids: [child], receiver_agents: [{ thread_id: child, agent_role: "reviewer" }],
      agents_states: { [child]: "pending_init" } },
  });
  await fixture.append(
    spawn(fixture.id, childId),
    spawn(anotherSession, otherChild),
    event({ type: "sub_agent_activity", agent_thread_id: childId, kind: "interacted" }),
    event({ type: "item_completed", thread_id: fixture.id,
      item: { type: "CommandExecution", id: "exec-fixture", status: "failed", exit_code: 1,
        command: ["PRIVATE-COMMAND"], aggregated_output: "PRIVATE-RESULT" } }),
    event({ type: "item_completed", thread_id: fixture.id,
      item: { type: "CommandExecution", id: "user-shell-fixture", status: "completed", source: "user_shell" } }),
    event({ type: "item_completed", thread_id: fixture.id,
      item: { type: "SubAgentActivity", id: "child-completed", agent_thread_id: childId, kind: "completed" } }),
  );
  const parsed = await fixture.read();
  assert.ok(parsed);
  assert.deepEqual(parsed.session.activity?.tools.map(({ name, status }) => ({ name, status })), [
    { name: "spawn_agent", status: "returned" },
    { name: "exec_command", status: "failed" },
  ]);
  assert.deepEqual(parsed.session.activity?.children, [{ line: 3, index: 0, name: "reviewer", status: "completed" }]);
  assert.doesNotMatch(JSON.stringify(parsed.session.activity), /PRIVATE-/u);
  assert.equal(parsed.session.activity?.throughLine, 8);
});

test("Codex collaboration lifecycle names a child before the spawn tool returns", async (context) => {
  const fixture = await sessionFixture(context);
  const childId = randomUUID();
  await fixture.append(
    response({ type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: "call_spawn",
      arguments: JSON.stringify({ task_name: "fixture_child", message: "PRIVATE-CHILD-PROMPT" }) }),
    event({ type: "item_completed", thread_id: fixture.id,
      item: { type: "SubAgentActivity", id: "call_spawn", agent_thread_id: childId, kind: "started",
        agent_path: "/root/fixture_child" } }),
    response({ type: "function_call_output", call_id: "call_spawn",
      output: JSON.stringify({ task_name: "/root/fixture_child" }) }),
  );
  const parsed = await fixture.read();
  assert.ok(parsed);
  assert.deepEqual(parsed.session.activity?.tools, [
    { line: 3, index: 0, name: "collaboration:spawn_agent", status: "returned" },
  ]);
  assert.deepEqual(parsed.session.activity?.children, [{ line: 4, index: 0, name: "fixture_child", status: "started" }]);
  assert.doesNotMatch(JSON.stringify(parsed.session.activity), /PRIVATE-|\/root\/|call_spawn/u);
});

test("Codex activity is bounded and flags omitted calls", async (context) => {
  const fixture = await sessionFixture(context);
  await fixture.append(...Array.from({ length: MAX_SESSION_ACTIVITY_ITEMS + 1 }, (_, index) =>
    response({ type: "function_call", name: "exec_command", call_id: "call_" + index })));
  const parsed = await fixture.read();
  assert.ok(parsed);
  assert.equal(parsed.session.activity?.truncated, true);
  assert.equal(parsed.session.activity?.tools.length, MAX_SESSION_ACTIVITY_ITEMS);
  assert.equal(parsed.session.activity?.throughLine, MAX_SESSION_ACTIVITY_ITEMS + 3);
});
