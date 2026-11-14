import { MAX_CODEX_IMPORT_EVENTS, modelTokens } from "@tideline/contracts";
import { z } from "zod";
import { createCodexActivity } from "./codex-activity";
import { createProjectScope, readJsonl } from "./session-jsonl";
import type { LiveReadOptions, LiveSession, SessionCandidate, SessionProjection } from "./session-jsonl";
import { createSessionSafety } from "./session-safety";
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
});
const turnContext = z.object({ cwd: z.string().optional(), model: z.unknown().optional() });
const tokenEvent = z.object({ type: z.literal("token_count"), info: z.unknown().optional() });
const codexTokenTotals = z.object({
  total_token_usage: z.object({
    input_tokens: z.int().nonnegative(),
    cached_input_tokens: z.int().nonnegative(),
    cache_write_input_tokens: z.int().nonnegative().default(0),
    output_tokens: z.int().nonnegative(),
  }),
});
const nestedSource = z.object({
  subagent: z.unknown().optional(),
  internal: z.unknown().optional(),
});
const rolloutTimestamp = z.iso.datetime();
const messageRecord = z.object({ type: z.literal("message"), role: z.enum(["user", "assistant"]) });
const messageContent = z.object({ content: z.array(z.unknown()) });
const textPart = z.object({ type: z.enum(["input_text", "output_text"]), text: z.string() });
const codexContext = /^(?:#\s*agents\.md instructions for\b|<(?:environment_context|user_instructions|permissions instructions|skill|skills_instructions)(?:\s|>))/iu;

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
  const projectScope = options?.projectScope ?? createProjectScope(options?.projectDirectory);
  const checkoutOf = options?.projectRoot;
  let projectDirectory: string | undefined;
  let checkout: string | undefined;
  const usage = createModelUsage();
  const safety = options ? createSessionSafety() : undefined;
  const activity = createCodexActivity(safety);
  let currentProject: string | undefined;
  let throughLine = 0;
  let lastPromptLine = 0;
  let lastUsageLine = 0;
  let activeModel: string | null = null;
  const modelsSinceLastUsage = new Set<string | null>();
  let previousTokens = zeroTokens();

  for await (const { value, line } of readJsonl(path, options?.live)) {
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
      modelsSinceLastUsage.add(activeModel);
      usage.add(activeModel, null);
      throughLine = line;
      continue;
    }
    if (record.data.type === "event_msg") {
      activity.event(record.data.payload, line, session.sourceSessionId, projectDirectory);
      const count = tokenEvent.safeParse(record.data.payload);
      if (!count.success || count.data.info == null) continue;
      throughLine = line;
      const current = codexTokenTotals.safeParse(count.data.info);
      if (!current.success) {
        usage.markIncomplete();
        continue;
      }
      const {
        input_tokens: input, cached_input_tokens: cached,
        cache_write_input_tokens: written, output_tokens: output,
      } = current.data.total_token_usage;
      const totals = { ...zeroTokens(), input: input - cached - written, cachedInput: cached, cacheWriteUnknown: written, output };
      const difference = modelTokens.safeParse(combineTokens(totals, previousTokens, (a, b) => a - b));
      if (!difference.success) {
        usage.markIncomplete();
        continue;
      }
      previousTokens = totals;
      const hasNewUsage = Object.values(difference.data).some((value) => value > 0);
      if (hasNewUsage) {
        usage.add(modelsSinceLastUsage.size > 1 ? null : activeModel, difference.data);
        modelsSinceLastUsage.clear();
        lastUsageLine = line;
      }
      continue;
    }
    if (record.data.type !== "response_item") continue;
    activity.response(record.data.payload, line, currentProject === projectDirectory ? projectDirectory : undefined);

    const message = messageRecord.safeParse(record.data.payload);
    if (!message.success) continue;
    const content = messageContent.safeParse(record.data.payload);
    const timestamp = rolloutTimestamp.safeParse(record.data.timestamp);
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
      throw new Error(`The session exceeds the ${MAX_CODEX_IMPORT_EVENTS}-message import limit.`);
    }
    events.push({ role: message.data.role, text, line, timestamp: timestamp.data });
    if (message.data.role === "user") lastPromptLine = line;
    throughLine = line;
  }

  if (lastPromptLine > lastUsageLine) usage.markIncomplete();
  const analytics = usage.snapshot(throughLine);
  const sessionActivity = activity.snapshot(events.at(-1)?.line ?? 0);
  if (options) {
    if (session && projectDirectory && safety && events.length) {
      return { projectDirectory, session: { ...session, events, analytics, activity: sessionActivity },
        evidence: safety.snapshot(events.at(-1)?.line ?? 0) };
    }
    return;
  }

  if (!session || events.length === 0) {
    throw new Error("The file must contain one Codex session with readable conversation text.");
  }
  return { ...session, events, analytics, activity: sessionActivity };
}
