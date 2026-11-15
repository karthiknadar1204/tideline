import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sessionImportRequest } from "@tideline/contracts";
import { transcriptBatch } from "@tideline/contracts/transcripts";
import type { TranscriptAppend } from "@tideline/contracts/transcripts";
import { readClaudeSession } from "../src/claude-session";
import { readCodexSession } from "../src/codex-session";
import { createTranscriptSync } from "../src/full-transcript";
import { createCodexSubagentIndex } from "../src/sync-sources";
import { openSyncStorage, storeSyncCredential } from "../src/sync-storage";
import type { SyncConfig } from "../src/sync-storage";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const jsonl = (...rows: object[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3XcAAAAASUVORK5CYII=";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

test("full opted-in child archives retry after projection and retain images, source scope, and the main cursor", {
  skip: process.platform === "win32" || !process.versions.bun,
  timeout: 22_000,
}, async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-raw-children-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "approved");
  const unapproved = join(root, "unapproved");
  const codexRoot = join(root, "codex");
  const claudeRoot = join(root, "claude");
  const syncHome = join(root, "sync");
  const codexId = randomUUID(), childId = randomUUID(), claudeId = randomUUID();
  const codexMain = join(codexRoot, `rollout-local-${codexId}.jsonl`), codexChild = join(codexRoot, `rollout-local-${childId}.jsonl`);
  const claudeMain = join(claudeRoot, "projects", `${claudeId}.jsonl`);
  const sidecars = join(claudeRoot, "projects", claudeId, "subagents");
  const claudeChild = join(sidecars, "agent-worker.jsonl");
  await Promise.all([project, unapproved, codexRoot, sidecars].map((path) => mkdir(path, { recursive: true })));
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 300_000).toISOString();
  const event = (type: string, payload: object, timestamp = now) => ({ type, payload, timestamp });
  const codexMessage = (role: "user" | "assistant", text: string, extras: object[] = [], time = now) => event("response_item", {
    type:"message", role, content: [{type: role === "user" ? "input_text" : "output_text", text}, ...extras],
  }, time);
  const claudeRecord = (role: "user" | "assistant", content: string | object[], fields: object = {}) => ({
    type: role, message: { role, content }, timestamp: now, sessionId: claudeId, cwd: project, ...fields,
  });
  await Promise.all([
    writeFile(codexMain, jsonl(event("session_meta", { id: codexId, cwd: project }), codexMessage("user", "Codex root prompt"),
      event("event_msg", { type: "sub_agent_activity", kind: "started", thread_id: codexId, agent_thread_id: childId }))),
    writeFile(codexChild, jsonl(event("session_meta", { id: childId, cwd: project, parent_thread_id: codexId }),
      codexMessage("user", "INHERITED-ANCESTOR", [], earlier), codexMessage("assistant", "Codex child report", [
        {type:"input_image", image_url:`data:image/png;base64,${image}`},
      ]))),
    writeFile(claudeMain, jsonl(claudeRecord("user", "Claude root prompt"),
      claudeRecord("assistant", [{type:"tool_use", id:"tool-agent", name:"Agent", input:{subagent_type:"Explore"}}]),
      claudeRecord("user", [{type:"tool_result", tool_use_id:"tool-agent", content:"done"}], {toolUseResult:{agentId:"worker",status:"completed"}}))),
    writeFile(claudeChild, jsonl(claudeRecord("assistant", [{type:"image", source:{type:"base64",media_type:"image/png",data:image}}],
      {agentId:"worker", isSidechain:true}))),
  ]);
  const roots = { codexRoot, claudeRoot };
  const workspaceId = randomUUID(), account = randomUUID(), token = "tdsync_" + "3".repeat(64);
  const verified = new Map<string, Set<string>>();
  const uploaded = new Map<string, TranscriptAppend[]>();
  const delayed = new Set<string>();
  const server = Bun.serve({ hostname:"127.0.0.1", port:0, async fetch(request) {
    const url = new URL(request.url);
    const stream = url.searchParams.get("stream");
    const sourceId = url.pathname.split("/").at(-1) ?? "";
    if (url.pathname === "/v1/cli/sync/sessions") {
      const data = sessionImportRequest.parse(await request.json());
      verified.set(data.session.sourceSessionId, new Set(data.session.capture?.subagents?.transcripts.map(({agentId}) => agentId)));
      return Response.json({id:randomUUID(),alreadyReceived:false});
    }
    if (url.pathname === "/v1/cli/sync/inventory") return new Response(null, { status:204 });
    if (!url.pathname.startsWith(`/v1/cli/sync/transcripts/${workspaceId}/`) || !verified.has(sourceId) ||
        (stream && !verified.get(sourceId)?.has(stream))) return new Response(null,{status:404});
    if (stream && !delayed.has(stream)) {
      delayed.add(stream);
      return new Response(null,{status:404});
    }
    const key = `${sourceId}:${stream ?? "main"}`;
    const current = uploaded.get(key) ?? [];
    if (request.method === "POST") {
      const data = transcriptBatch.parse(await request.json());
      assert.equal(data.records[0].start, current.at(-1)?.offset ?? 0);
      current.push(...data.records);
      uploaded.set(key,current);
    }
    const last = current.at(-1);
    return Response.json({line:current.length,offset:last?.offset ?? 0,previousOffset:last?.start ?? 0,digest:last ? digest(last.text):null});
  }});
  context.after(() => server.stop(true));
  const config: SyncConfig = { ...roots, workspaceId, account, apiOrigin: server.url.origin, startedAt: now,
    expiresAt:new Date(Date.now()+120_000).toISOString(), credentialStore:"file", sessionDetails:true, subagentTranscripts:true, fullTranscripts:true,
    projects:[{directory:project,since:earlier}],
  };
  const originalStorage = process.env.TIDELINE_SYNC_HOME;
  process.env.TIDELINE_SYNC_HOME = syncHome;
  try {
    const setup = await openSyncStorage({ create: true, lock: true });
    try {
      setup.saveConfig(config);
      await storeSyncCredential(setup.directory, config, token);
    } finally { setup.close(); }
  } finally {
    if (originalStorage === undefined) delete process.env.TIDELINE_SYNC_HOME;
    else process.env.TIDELINE_SYNC_HOME = originalStorage;
  }
  const runOnce = () => execute(process.execPath,[entry,"sync","once"],{env:{...process.env,HOME:root,TIDELINE_SYNC_HOME:syncHome,
    TIDELINE_API_URL:server.url.origin,TIDELINE_SESSION_INVENTORY:"0"},timeout:14_000});
  await runOnce();
  assert.deepEqual(delayed,new Set([childId,"worker"]));
  const codexStream = uploaded.get(`${codexId}:${childId}`), claudeStream = uploaded.get(`${claudeId}:worker`);
  assert.ok(codexStream?.some(({attachments}) => attachments[0]?.base64 === image));
  assert.ok(claudeStream?.some(({attachments}) => attachments[0]?.base64 === image));
  assert.ok(uploaded.get(`${codexId}:main`)?.length && uploaded.get(`${claudeId}:main`)?.length);
  assert.doesNotMatch(JSON.stringify(codexStream), /INHERITED-ANCESTOR/u);
  const codexFiles = createCodexSubagentIndex(roots);
  const signal = new AbortController().signal;
  await codexFiles.refresh(signal);
  const options = { live:true, captureDetails:true, transcriptPreview:true, captureSubagents:true, projectDirectory:project } as const;
  const codex = await readCodexSession(codexMain,{...options,findCodexSubagent:codexFiles.find});
  const claude = await readClaudeSession(claudeMain,options);
  assert.equal(codex?.rawSubagents?.length,1);
  assert.equal(claude?.rawSubagents?.length,1);
  const syncRaw = createTranscriptSync(config);
  const raw = [ {sourceSessionId:codexId,projectDirectory:project,streams:codex?.rawSubagents ?? []},
    {sourceSessionId:claudeId,projectDirectory:project,streams:claude?.rawSubagents ?? []} ];
  await appendFile(claudeChild,jsonl(claudeRecord("assistant","Appended valid line",{agentId:"worker",isSidechain:true})));
  const priorClaudeLength = claudeStream.length;
  await createTranscriptSync({ ...config, subagentTranscripts: false })(token,signal,raw);
  assert.equal(claudeStream.length, priorClaudeLength);
  await syncRaw(token,signal,raw);
  assert.match(claudeStream.at(-1)?.text ?? "",/Appended valid line/u);
  const lengths = [codexStream.length,claudeStream.length];
  await appendFile(codexChild,jsonl(event("turn_context", {cwd:unapproved}),codexMessage("assistant","PAYLOAD-AFTER-REJECTED-CWD")));
  await appendFile(claudeChild,"x".repeat(33*1024*1024) + "\n" + jsonl(claudeRecord("assistant","PAYLOAD-AFTER-OVERSIZED-RECORD",{agentId:"worker",isSidechain:true})));
  await syncRaw(token,signal,raw);
  assert.deepEqual([codexStream.length,claudeStream.length],lengths);
});
