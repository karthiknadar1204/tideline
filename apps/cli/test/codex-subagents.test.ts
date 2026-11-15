import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionImportRequest } from "@tideline/contracts";
import { discoverCodexSession, readCodexSession } from "../src/codex-session";
import { createCodexSubagentIndex } from "../src/sync-sources";

const parentAt = "2026-10-01T00:00:00.000Z";
const workerAt = "2026-10-04T00:00:00.000Z";
const jsonl = (...rows: object[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const event = (type: string, payload: object, timestamp = workerAt) => ({ type, payload, timestamp });
const message = (role: "user" | "assistant", text: string, timestamp = workerAt) => event("response_item", { type: "message", role,
  content: [{ type: role === "user" ? "input_text" : "output_text", text }],
}, timestamp);

test("Codex child rollouts require a verified recorded parent and checkout across dated and archived roots", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-codex-subagent-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "project");
  const outside = join(root, "unapproved");
  const roots = { codexRoot: join(root, "sessions"), codexArchiveRoot: join(root, "archived_sessions"), claudeRoot: join(root, "claude") };
  const early = join(roots.codexRoot, "2026", "10", "01");
  const later = join(roots.codexRoot, "2026", "10", "04");
  await Promise.all([early, later, roots.codexArchiveRoot, checkout, outside].map((path) => mkdir(path, { recursive: true })));
  const id = randomUUID();
  const direct = randomUUID();
  const grandchild = randomUUID();
  const greatGrandchild = randomUUID();
  const deepest = randomUUID();
  const overLimit = randomUUID();
  const archived = randomUUID();
  const wrongParent = randomUUID();
  const wrongScope = randomUUID();
  const review = randomUUID();
  const unreferenced = randomUUID();
  const linked = randomUUID();
  const rollout = (directory: string, owner: string) => join(directory, `rollout-2026-10-01T00-00-00-${owner}.jsonl`);
  const parent = rollout(early, id);
  const spawnFrom = (parentId: string, child: string) => event("event_msg", { type: "sub_agent_activity", thread_id: parentId, kind: "started", agent_thread_id: child });
  const spawn = (child: string) => spawnFrom(id, child);
  await writeFile(parent, jsonl(event("session_meta", { id, cwd: checkout }, parentAt), message("user", "Review tests", parentAt),
    ...[direct, archived, wrongParent, wrongScope, review, linked].map(spawn), message("assistant", "Root response")));
  const directPath = rollout(later, direct);
  const archivedPath = rollout(roots.codexArchiveRoot, archived);
  await writeFile(directPath, jsonl(event("session_meta", { id: direct, cwd: checkout, parent_thread_id: id }),
    message("user", "Copied ancestor message", parentAt), message("user", "<environment_context>HIDDEN SYSTEM DATA</environment_context>"),
    message("user", "Check tests without changing code"), message("assistant", "Credential shown was ghp_0123456789abcdefghijklmnopqrstuv"),
    spawnFrom(direct, grandchild)));
  await writeFile(archivedPath, jsonl(event("session_meta", { id: archived, cwd: checkout,
    source: { subagent: { thread_spawn: { parent_thread_id: id } } },
  }), message("assistant", "Archived child reply")));
  const depthFixtures = [
    [grandchild, direct, "Grandchild reply", [greatGrandchild, direct]],
    [greatGrandchild, grandchild, "Great-grandchild reply", [deepest]],
    [deepest, greatGrandchild, "Fourth-level reply", [overLimit]],
    [overLimit, deepest, "OVER-DEPTH", []],
  ] as const;
  for (const [child, parent, reply, children] of depthFixtures) {
    await writeFile(rollout(later, child), jsonl(event("session_meta", { id: child, cwd: checkout,
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } },
    }), message("assistant", reply), ...children.map((nested) => spawnFrom(child, nested))));
  }
  for (const [childId, metadata, text] of [
    [wrongParent, { parent_thread_id: randomUUID() }, "Wrong parent content"],
    [wrongScope, { parent_thread_id: id, runtime_workspace_roots: [outside] }, "Wrong checkout content"],
    [review, { parent_thread_id: id, source: { subagent: "review" } }, "Guardian content"],
    [unreferenced, { parent_thread_id: id }, "Unreferenced content"],
  ] as const) {
    await writeFile(rollout(later, childId), jsonl(event("session_meta", { id: childId, cwd: checkout, ...metadata }), message("assistant", text)));
  }
  const outsideFile = join(outside, "not-in-index.jsonl");
  await writeFile(outsideFile, jsonl(event("session_meta", { id: linked, cwd: checkout, parent_thread_id: id }), message("assistant", "Linked content")));
  await symlink(outsideFile, rollout(later, linked));

  const index = createCodexSubagentIndex(roots);
  await index.refresh(new AbortController().signal);
  assert.deepEqual(index.find(direct), [directPath]);
  assert.deepEqual(index.find(linked), []);
  assert.equal(await discoverCodexSession(directPath), undefined);
  assert.equal(await discoverCodexSession(archivedPath), undefined);
  const options = { live: true, projectDirectory: checkout, captureDetails: true, findCodexSubagent: index.find } as const;
  assert.equal((await readCodexSession(parent, options))?.session.capture?.subagents, undefined);
  const first = await readCodexSession(parent, { ...options, captureSubagents: true });
  assert.ok(first?.sidecarRevision);
  const { session } = sessionImportRequest.parse({ version: 1, workspaceId: randomUUID(), session: first.session });
  const evidence = session.capture?.subagents;
  assert.equal(session.events.length, 2);
  assert.equal(evidence?.source, "codex-rollout");
  assert.equal(evidence?.truncated, true, "Cycles and descendants beyond four levels are bounded.");
  assert.deepEqual(evidence?.transcripts.map(({ parentAgentId }) => parentAgentId), [undefined, undefined, direct, grandchild, greatGrandchild]);
  assert.deepEqual(evidence?.transcripts.map(({ messages }) => messages.map(({ text }) => text)), [
    ["Check tests without changing code", "Credential shown was [REDACTED TOKEN]"], ["Archived child reply"],
    ["Grandchild reply"], ["Great-grandchild reply"], ["Fourth-level reply"],
  ]);
  assert.doesNotMatch(JSON.stringify(evidence), /Copied|HIDDEN|Wrong|Guardian|Unreferenced|Linked|OVER-DEPTH|ghp_/u);
  await appendFile(rollout(later, deepest), jsonl(message("assistant", "Another reply without parent changes")));
  assert.notEqual(await first.sidecarRevision.read(), first.sidecarRevision.value);
  const updated = await readCodexSession(parent, { ...options, captureSubagents: true });
  assert.equal(updated?.session.capture?.throughLine, session.capture?.throughLine);
  assert.equal(updated?.session.capture?.subagents?.transcripts.find(({ agentId }) => agentId === deepest)?.messages.at(-1)?.text,
    "Another reply without parent changes");
});
