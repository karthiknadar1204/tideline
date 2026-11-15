import { MAX_CODEX_IMPORT_EVENTS, modelTokens } from "@tideline/contracts";
import { z } from "zod";
import { createCodexActivity } from "./codex-activity";
import { codexContext, readCodexSubagents } from "./codex-subagents";
import { createSessionCapture } from "./session-capture";
import { appendPreviewMessage, createProjectScope, readJsonl } from "./session-jsonl";
import type { LiveReadOptions, LiveSession, SessionCandidate, SessionProjection } from "./session-jsonl";
import { createSessionSafety } from "./session-safety";
import { createSessionTurns, inputTokens } from "./session-turns";
import type { CapturedTurn } from "./session-turns";
import { combineTokens, createModelUsage, readModelId, zeroTokens } from "./session-usage";

const rolloutRecord = z.object({
  type: z.string(),
  timestamp: z.unknown().optional(),
  payload: z.unknown().optional(),
});
const sessionMetadata = z.object({
  id: z.uuid(),
  cwd: z.string().optional(),
  parent_thread_id: z.string().nullish(),
  forked_from_id: z.string().nullish(),
  runtime_workspace_roots: z.array(z.string()).nullish(),
  thread_source: z.unknown().optional().optional(),
  source: z.unknown().optional(),
  cli_version: z.unknown().optional(),
  model_provider: z.unknown().optional(),
  originator: z.unknown().optional(),
});
const turnContext = z.object({
  cwd: z.string().optional(), model: z.unknown().optional(), effort: z.unknown().optional(),
  approval_policy: z.unknown().optional(),
  sandbox_policy: z.object({ type: z.unknown() }).optional().catch(undefined),
});
const tokenEvent = z.object({ type: z.literal("token_count"), info: z.unknown().optional() });
const contextWindow = z.int().positive().max(1_000_000_000_000).nullish().catch(null);
const duration = z.int().nonnegative().nullish().catch(null);
const taskEvent = z.object({
  type: z.enum(["task_started", "task_complete", "turn_aborted"]),
  turn_id: z.string().min(1).max(200),
  root_turn_id: z.string().nullish().catch(null),
  model_context_window: contextWindow,
  duration_ms: duration,
  time_to_first_token_ms: duration,
}).refine(({ root_turn_id, turn_id }) => !root_turn_id || root_turn_id === turn_id);
const codexTokens = z.object({
  input_tokens: z.int().nonnegative(),
  cached_input_tokens: z.int().nonnegative(),
  cache_write_input_tokens: z.int().nonnegative().default(0),
  output_tokens: z.int().nonnegative(),
});
const codexTokenTotals = z.object({
  total_token_usage: codexTokens,
  last_token_usage: codexTokens.nullish().catch(null),
  model_context_window: contextWindow,
});
const nestedSource = z.object({
  subagent: z.unknown().optional(),
  internal: z.unknown().optional(),
});
const rolloutTimestamp = z.iso.datetime();
const messageRecord = z.object({ type: z.literal("message"), role: z.enum(["user", "assistant"]) });
const messageContent = z.object({ content: z.array(z.unknown()) });
const textPart = z.object({ type: z.enum(["input_text", "output_text"]), text: z.string() });

function normalizeTokens({ input_tokens, cached_input_tokens: cached, cache_write_input_tokens: written,
  output_tokens: output }: z.infer<typeof codexTokens>) {
  return { ...zeroTokens(), input: input_tokens - cached - written, cachedInput: cached, cacheWriteUnknown: written, output };
}

function isRootSession(metadata: z.infer<typeof sessionMetadata>) {
  const { parent_thread_id: parentThread, forked_from_id: forkedFrom, source, thread_source: threadSource } = metadata;
  const nested = nestedSource.safeParse(source).data;
  return !parentThread && !forkedFrom && nested?.subagent === undefined && nested?.internal === undefined &&
    (typeof threadSource !== "string" || threadSource === "user");
}

export async function discoverCodexSession(path: string): Promise<SessionCandidate | undefined> {
  for await (const { value } of readJsonl(path, true)) {
    const record = rolloutRecord.safeParse(value).data;
    if (record?.type !== "session_meta") return;
    const metadata = sessionMetadata.safeParse(record.payload).data;
    const startedAt = rolloutTimestamp.safeParse(record.timestamp).data;
    if (!metadata || !startedAt || !isRootSession(metadata)) return;
    const scope = createProjectScope();
    const projectDirectory = await scope(metadata.cwd);
    if (!projectDirectory) return;
    for (const root of metadata.runtime_workspace_roots ?? []) if (!await scope(root)) return;
    return { source: "codex", sourceSessionId: metadata.id, startedAt, projectDirectory };
  }
}

export function readCodexSession(path: string): Promise<SessionProjection>;
export function readCodexSession(path: string, options: LiveReadOptions): Promise<LiveSession | undefined>;
export async function readCodexSession(path: string, options?: LiveReadOptions): Promise<SessionProjection | LiveSession | undefined> {
  let session: Pick<SessionProjection, "source" | "sourceSessionId" | "startedAt"> | undefined;
  const events: SessionProjection["events"] = [];
  let previewBytes = 0;
  const projectScope = options?.projectScope ?? createProjectScope(options?.projectDirectory);
  const checkoutOf = options?.projectRoot;
  let projectDirectory: string | undefined;
  let checkout: string | undefined;
  const usage = createModelUsage();
  const turns = createSessionTurns();
  const safety = options ? createSessionSafety() : undefined;
  const capture = options?.captureDetails ? createSessionCapture() : undefined;
  const activity = createCodexActivity(safety, capture);
  let currentProject: string | undefined;
  let throughLine = 0;
  let lastPromptLine = 0;
  let lastUsageLine = 0;
  let activeModel: string | null = null;
  const modelsSinceLastUsage = new Set<string | null>();
  let previousTokens = zeroTokens();
  let turn: CapturedTurn | undefined;
  let task: { id: string; contextWindow: number | null } | undefined;
  let usageMaySpanTurns = false;

  for await (const { value, line } of readJsonl(path, options?.live, options?.captureDetails, options?.transcriptPreview)) {
    const record = rolloutRecord.safeParse(value);
    if (!record.success) throw new Error(`Invalid Codex record at line ${line}.`);

    if (record.data.type === "session_meta") {
      if (session) throw new Error("Select a JSONL file containing exactly one Codex session.");
      const metadata = sessionMetadata.safeParse(record.data.payload);
      const startedAt = rolloutTimestamp.safeParse(record.data.timestamp);
      if (!metadata.success || !startedAt.success) {
        throw new Error(`Invalid Codex session metadata at line ${line}.`);
      }
      const identity: Omit<SessionCandidate, "projectDirectory"> = {
        source: "codex", sourceSessionId: metadata.data.id, startedAt: startedAt.data,
      };
      if (options) {
        if (!isRootSession(metadata.data)) return;
        if (options.since !== undefined && Date.parse(startedAt.data) < options.since) return;
        projectDirectory = await projectScope(metadata.data.cwd);
        if (!projectDirectory) return;
        checkout = checkoutOf?.(projectDirectory);
        if (checkoutOf && !checkout) return;
        if (options.sessionAllowed?.({ ...identity, projectDirectory }) === false) return;
        currentProject = projectDirectory;
        for (const root of metadata.data.runtime_workspace_roots ?? []) {
          const directory = await projectScope(root);
          if (!directory || (checkoutOf && checkoutOf(directory) !== checkout)) return;
        }
      }
      capture?.setup(line, {
        clientVersion: metadata.data.cli_version, provider: metadata.data.model_provider, entrypoint: metadata.data.originator,
      });
      session = identity;
      continue;
    }

    if (!session) throw new Error("The selected file must begin with Codex session metadata.");
    if (record.data.type === "turn_context") {
      const context = turnContext.safeParse(record.data.payload);
      if (options) {
        if (!context.success) return;
        if (context.data.cwd !== undefined) {
          currentProject = await projectScope(context.data.cwd);
          if (!currentProject || (checkoutOf && checkoutOf(currentProject) !== checkout)) return;
        }
      }
      activeModel = readModelId(context.data?.model);
      capture?.setup(line, {
        model: activeModel,
        reasoningEffort: context.data?.effort,
        approvalPolicy: context.data?.approval_policy,
        sandboxMode: context.data?.sandbox_policy?.type,
      });
      modelsSinceLastUsage.add(activeModel);
      usage.add(activeModel, null);
      throughLine = line;
      continue;
    }
    if (record.data.type === "event_msg") {
      const root = checkout ?? options?.projectDirectory ?? projectDirectory;
      activity.event(record.data.payload, line, session.sourceSessionId, projectDirectory,
        root && currentProject ? { root, workingDirectory: currentProject } : undefined,
        rolloutTimestamp.safeParse(record.data.timestamp).data);
      const taskUpdate = taskEvent.safeParse(record.data.payload).data;
      if (taskUpdate?.type === "task_started") {
        task = { id: taskUpdate.turn_id, contextWindow: taskUpdate.model_context_window ?? null };
        turn = undefined;
      } else if (taskUpdate && task && taskUpdate.turn_id === task.id) {
        if (turn && taskUpdate.type === "task_complete") {
          turn.metrics.durationMs = taskUpdate.duration_ms ?? null;
          const first = taskUpdate.time_to_first_token_ms ?? null;
          if (first !== null && (turn.metrics.durationMs === null || first <= turn.metrics.durationMs)) {
            turn.metrics.timeToFirstTokenMs = first;
          }
          if (turn.metrics.durationMs !== null || turn.metrics.timeToFirstTokenMs !== null) throughLine = line;
        }
        turn = undefined;
        task = undefined;
      }
      const count = tokenEvent.safeParse(record.data.payload);
      if (!count.success || count.data.info == null) continue;
      throughLine = line;
      const current = codexTokenTotals.safeParse(count.data.info);
      if (!current.success) {
        usage.markIncomplete();
        turn?.usage.markIncomplete();
        continue;
      }
      const totals = normalizeTokens(current.data.total_token_usage);
      const difference = modelTokens.safeParse(combineTokens(totals, previousTokens, (a, b) => a - b));
      if (!difference.success) {
        usage.markIncomplete();
        turn?.usage.markIncomplete();
        continue;
      }
      previousTokens = totals;
      if (turn && current.data.model_context_window) turn.metrics.contextWindow = current.data.model_context_window;
      const hasNewUsage = Object.values(difference.data).some((value) => value > 0);
      if (hasNewUsage) {
        const model = modelsSinceLastUsage.size > 1 ? null : activeModel;
        usage.add(model, difference.data);
        if (turn) {
          const request = current.data.last_token_usage && normalizeTokens(current.data.last_token_usage);
          const matchesRequest = request && Object.values(combineTokens(difference.data, request, (a, b) => a - b)).every((value) => value === 0);
          if (!usageMaySpanTurns || matchesRequest) turn.usage.add(model, difference.data);
          else turn.usage.markIncomplete();
          if (request && matchesRequest) {
            turn.metrics.peakRequestInput = Math.max(turn.metrics.peakRequestInput ?? 0, inputTokens(request));
          }
        }
        usageMaySpanTurns = false;
        modelsSinceLastUsage.clear();
        lastUsageLine = line;
      }
      continue;
    }
    if (record.data.type !== "response_item") continue;
    const timestamp = rolloutTimestamp.safeParse(record.data.timestamp);
    activity.response(record.data.payload, line, currentProject === projectDirectory ? projectDirectory : undefined, timestamp.data);

    const message = messageRecord.safeParse(record.data.payload);
    if (!message.success) continue;
    const content = messageContent.safeParse(record.data.payload);
    if (!content.success || !timestamp.success) throw new Error(`Invalid Codex message at line ${line}.`);

    const expectedType = message.data.role === "user" ? "input_text" : "output_text";
    const parts = content.data.content.flatMap((item, index) => {
      const part = textPart.safeParse(item);
      if (!part.success || part.data.type !== expectedType) return [];
      if (message.data.role === "user" && codexContext.test(part.data.text.trimStart())) {
        activity.skill(part.data.text, line, index);
        if (part.data.text.trimStart().startsWith("<skill")) throughLine = line;
        return [];
      }
      return [part.data.text];
    });
    const text = parts.join("\n");
    if (!text.trim()) continue;
    safety?.scanCredential(text, line);

    if (events.length === MAX_CODEX_IMPORT_EVENTS) {
      if (options?.transcriptPreview) break;
      throw new Error(`The session exceeds the ${MAX_CODEX_IMPORT_EVENTS}-message import limit.`);
    }
    const event = { role: message.data.role, text, line, timestamp: timestamp.data };
    if (options?.transcriptPreview) {
      const total = appendPreviewMessage(events, event, previewBytes);
      if (total === null) break;
      previewBytes = total;
    } else events.push(event);
    if (message.data.role === "user") {
      if (!task || !turn) {
        if (lastPromptLine > lastUsageLine) usageMaySpanTurns = true;
        turn = turns.start(line);
        turn.metrics.contextWindow = task?.contextWindow ?? null;
      }
      lastPromptLine = line;
      turn.usage.add(activeModel, null);
    }
    throughLine = line;
  }

  if (lastPromptLine > lastUsageLine) usage.markIncomplete();
  const analytics = { ...usage.snapshot(throughLine), turnTrace: turns.snapshot(throughLine) };
  const sessionActivity = activity.snapshot(events.at(-1)?.line ?? 0);
  if (options) {
    if (session && projectDirectory && safety && events.length) {
      const lastMessageLine = events.at(-1)?.line ?? 0;
      const links = capture && options.captureSubagents ? activity.subagentLinks() : [];
      const subagents = capture && options.captureSubagents && options.findCodexSubagent ? await readCodexSubagents({
        sessionId: session.sourceSessionId, links, find: options.findCodexSubagent,
        checkout: checkout ?? options.projectDirectory ?? projectDirectory, projectScope, projectRoot: options.projectRoot,
        includeRaw: options.transcriptPreview,
      }) : undefined;
      const captureLine = Math.max(lastMessageLine, ...links.map(({ line }) => line));
      const detail = capture?.snapshot(captureLine);
      return {
        projectDirectory,
        session: { ...session, events, analytics, activity: sessionActivity,
          capture: detail && (subagents ? { ...detail, subagents: subagents.section } : detail) },
        evidence: safety.snapshot(lastMessageLine),
        sidecarRevision: subagents?.sidecarRevision,
        rawSubagents: subagents?.raw,
      };
    }
    return;
  }

  if (!session || events.length === 0) {
    throw new Error("The file must contain one Codex session with readable conversation text.");
  }
  return { ...session, events, analytics, activity: sessionActivity };
}
