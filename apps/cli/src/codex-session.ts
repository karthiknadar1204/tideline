import { MAX_CODEX_IMPORT_EVENTS, modelTokens } from "@tideline/contracts";
import { z } from "zod";
import { createCodexActivity } from "./codex-activity";
import { createProjectScope, readJsonl } from "./session-jsonl";
import type { LiveReadOptions, LiveSession, SessionProjection } from "./session-jsonl";
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

export function readCodexSession(path: string): Promise<SessionProjection>;
export function readCodexSession(path: string, options: LiveReadOptions): Promise<LiveSession | undefined>;
export async function readCodexSession(path: string, options?: LiveReadOptions): Promise<SessionProjection | LiveSession | undefined> {
  let session: Pick<SessionProjection, "source" | "sourceSessionId" | "startedAt"> | undefined;
  const events: SessionProjection["events"] = [];
  const projectScope = createProjectScope(options?.projectDirectory);
  let projectDirectory: string | undefined;
  const usage = createModelUsage();
  const activity = createCodexActivity();
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
      if (options) {
        const {
          cwd, parent_thread_id: parentThread, forked_from_id: forkedFrom,
          runtime_workspace_roots: workspaceRoots, source, thread_source: threadSource,
        } = metadata.data;
        const nested = nestedSource.safeParse(source).data;
        if (parentThread || forkedFrom || nested?.subagent !== undefined || nested?.internal !== undefined ||
          (typeof threadSource === "string" && threadSource !== "user")) return;
        if (options.since !== undefined && Date.parse(startedAt.data) < options.since) return;
        projectDirectory = await projectScope(cwd);
        if (!projectDirectory) return;
        for (const root of workspaceRoots ?? []) {
          if (!await projectScope(root)) return;
        }
      }
      session = { source: "codex", sourceSessionId: metadata.data.id, startedAt: startedAt.data };
      continue;
    }

    if (!session) throw new Error("The selected file must begin with Codex session metadata.");
    if (record.data.type === "turn_context") {
      const context = turnContext.safeParse(record.data.payload);
      if (options && (!context.success || (context.data.cwd !== undefined && !await projectScope(context.data.cwd)))) return;
      activeModel = readModelId(context.data?.model);
      modelsSinceLastUsage.add(activeModel);
      usage.add(activeModel, null);
      throughLine = line;
      continue;
    }
    if (record.data.type === "event_msg") {
      activity.event(record.data.payload, line, session.sourceSessionId);
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
    activity.response(record.data.payload, line);

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
    if (session && projectDirectory && events.length) {
      return { projectDirectory, session: { ...session, events, analytics, activity: sessionActivity } };
    }
    return;
  }

  if (!session || events.length === 0) {
    throw new Error("The file must contain one Codex session with readable conversation text.");
  }
  return { ...session, events, analytics, activity: sessionActivity };
}
