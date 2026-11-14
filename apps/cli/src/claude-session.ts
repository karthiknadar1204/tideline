import { MAX_CODEX_IMPORT_EVENTS, modelTokens } from "@tideline/contracts";
import type { ModelTokens } from "@tideline/contracts";
import { z } from "zod";
import { createClaudeActivity } from "./claude-activity";
import { createProjectScope, readJsonl } from "./session-jsonl";
import type { LiveReadOptions, LiveSession, SessionCandidate, SessionProjection } from "./session-jsonl";
import { createSessionSafety } from "./session-safety";
import { createModelUsage, readModelId } from "./session-usage";

const claudeMetadata = z.object({
  type: z.string(),
  sessionId: z.unknown().optional(),
  timestamp: z.unknown().optional(),
  cwd: z.string().optional(),
  isSidechain: z.boolean().optional(),
  agentId: z.unknown().optional(),
});
const claudeRecord = claudeMetadata.extend({
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  isSynthetic: z.boolean().optional(),
  userType: z.string().optional(),
  toolUseResult: z.unknown().optional(),
  sourceToolAssistantUUID: z.unknown().optional(),
  origin: z.object({ kind: z.string().optional() }).nullish().catch(undefined),
  attributionSkill: z.unknown().optional(),
  uuid: z.unknown().optional(),
  parentUuid: z.unknown().optional(),
  turnCompanion: z.boolean().optional().catch(undefined),
  message: z.unknown().optional(),
});
const claudeMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(z.unknown())]),
  model: z.string().optional(),
  id: z.unknown().optional(),
  usage: z.unknown().optional(),
});
const tokenCount = z.int().nonnegative();
const claudeTokens = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_read_input_tokens: tokenCount.nullish(),
  cache_creation_input_tokens: tokenCount.nullish(),
  cache_creation: z.object({
    ephemeral_5m_input_tokens: tokenCount,
    ephemeral_1h_input_tokens: tokenCount,
  }).nullish(),
});
const apiMessageId = z.string().min(1).max(200);
const blockType = z.object({ type: z.string() });
const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const sessionId = z.uuid();
const timestamp = z.iso.datetime();
const injectedText = /<(system-reminder|local-command-[a-z-]+|command-[a-z-]+|task-notification|teammate-message|user-prompt-submit-hook|system_warning|available-deferred-tools)(?:\s[^>]*)?>(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)/giu;
const interruption = /^\[Request (?:interrupted|aborted|cancell?ed) by user(?: for tool use)?\]$/iu;

function isRootMessage(record: z.infer<typeof claudeMetadata>) {
  return (record.type === "user" || record.type === "assistant") && !record.isSidechain && !record.agentId;
}

export async function discoverClaudeSession(path: string): Promise<SessionCandidate | undefined> {
  for await (const { value } of readJsonl(path, true)) {
    const record = claudeMetadata.safeParse(value).data;
    if (!record) return;
    if (!isRootMessage(record)) continue;
    const sourceSessionId = sessionId.safeParse(record.sessionId).data;
    const startedAt = timestamp.safeParse(record.timestamp).data;
    if (!sourceSessionId || !startedAt) return;
    const projectDirectory = await createProjectScope()(record.cwd);
    if (projectDirectory) return { source: "claude-code", sourceSessionId, startedAt, projectDirectory };
    return;
  }
}

function readUsage(value: unknown) {
  const parsed = claudeTokens.safeParse(value);
  if (!parsed.success) return null;
  const usage = parsed.data;
  const cacheWrite5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return modelTokens.safeParse({
    input: usage.input_tokens,
    cachedInput: usage.cache_read_input_tokens ?? 0,
    cacheWrite5m,
    cacheWrite1h,
    cacheWriteUnknown: (usage.cache_creation_input_tokens ?? cacheWrite5m + cacheWrite1h) - cacheWrite5m - cacheWrite1h,
    output: usage.output_tokens,
  }).data ?? null;
}

function cacheWrites(tokens: ModelTokens) {
  return tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheWriteUnknown;
}

function coversUsage(next: ModelTokens, previous: ModelTokens) {
  return next.input >= previous.input && next.cachedInput >= previous.cachedInput &&
    next.output >= previous.output && cacheWrites(next) >= cacheWrites(previous);
}

function retainCacheBreakdown(selected: ModelTokens, other: ModelTokens) {
  const cacheWrite5m = Math.max(selected.cacheWrite5m, other.cacheWrite5m);
  const cacheWrite1h = Math.max(selected.cacheWrite1h, other.cacheWrite1h);
  const cacheWriteUnknown = cacheWrites(selected) - cacheWrite5m - cacheWrite1h;
  if (cacheWriteUnknown < 0) return;
  return { ...selected, cacheWrite5m, cacheWrite1h, cacheWriteUnknown };
}

export function readClaudeSession(path: string): Promise<SessionProjection>;
export function readClaudeSession(path: string, options: LiveReadOptions): Promise<LiveSession | undefined>;
export async function readClaudeSession(path: string, options?: LiveReadOptions): Promise<SessionProjection | LiveSession | undefined> {
  let session: Pick<SessionProjection, "source" | "sourceSessionId" | "startedAt"> | undefined;
  const events: SessionProjection["events"] = [];
  const projectScope = options?.projectScope ?? createProjectScope(options?.projectDirectory);
  const checkoutOf = options?.projectRoot;
  let projectDirectory: string | undefined;
  let checkout: string | undefined;
  const usage = createModelUsage();
  const safety = options ? createSessionSafety() : undefined;
  const activity = createClaudeActivity(safety);
  const apiMessages = new Map<string, { model: string | null; tokens: ModelTokens | null }>();
  let throughLine = 0;

  for await (const { value, line } of readJsonl(path, options?.live)) {
    const parsed = claudeRecord.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid Claude Code record at line ${line}.`);
    const record = parsed.data;
    if (!isRootMessage(record)) continue;

    const id = sessionId.safeParse(record.sessionId);
    const at = timestamp.safeParse(record.timestamp);
    if (!id.success || !at.success) throw new Error(`Invalid Claude Code session metadata at line ${line}.`);
    if (session && id.data !== session.sourceSessionId) {
      throw new Error("Select a JSONL file containing exactly one Claude Code session.");
    }

    let inProject = false;
    if (options) {
      if (!session && options.since !== undefined && Date.parse(at.data) < options.since) return;
      const directory = await projectScope(record.cwd);
      if (!directory) return;
      if (!session) {
        checkout = checkoutOf?.(directory);
        if (checkoutOf && !checkout) return;
        if (options.sessionAllowed?.({ source: "claude-code", sourceSessionId: id.data, startedAt: at.data, projectDirectory: directory }) === false) return;
        projectDirectory = directory;
      } else if (checkoutOf && checkoutOf(directory) !== checkout) {
        return;
      }
      inProject = directory === projectDirectory;
    }
    session ??= { source: "claude-code", sourceSessionId: id.data, startedAt: at.data };

    if (record.isCompactSummary || record.isSynthetic || (record.userType && record.userType !== "external")) continue;
    if (record.isMeta) {
      if (record.type === "user" && record.turnCompanion) activity.observeSlashCompanion(record.parentUuid);
      continue;
    }
    const message = claudeMessage.safeParse(record.message);
    if (!message.success || message.data.role !== record.type || message.data.model === "<synthetic>") continue;

    const isTaskNotification = record.origin?.kind === "task-notification";
    activity.observe({
      line, role: message.data.role, content: message.data.content, metadata: record.toolUseResult,
      isTaskNotification, attributionSkill: record.attributionSkill, uuid: record.uuid, inProject,
    });
    if (record.toolUseResult !== undefined || record.sourceToolAssistantUUID !== undefined || isTaskNotification) continue;

    if (message.data.role === "assistant") {
      throughLine = line;
      const model = readModelId(message.data.model);
      const id = apiMessageId.safeParse(message.data.id).data;
      if (!id) {
        usage.add(model, null);
        usage.markIncomplete();
      } else {
        const tokens = readUsage(message.data.usage);
        const previous = apiMessages.get(id);
        if (!previous) {
          apiMessages.set(id, { model, tokens });
        } else if (previous.model !== null && model !== null && previous.model !== model) {
          usage.markIncomplete();
        } else {
          const oldTokens = previous.tokens;
          let combined = tokens ?? oldTokens;
          if (tokens && oldTokens) {
            const laterCoversEarlier = coversUsage(tokens, oldTokens);
            if (!laterCoversEarlier && !coversUsage(oldTokens, tokens)) usage.markIncomplete();
            const selected = laterCoversEarlier ? tokens : oldTokens;
            const other = laterCoversEarlier ? oldTokens : tokens;
            const refined = retainCacheBreakdown(selected, other);
            if (!refined) usage.markIncomplete();
            combined = refined ?? selected;
          }
          apiMessages.set(id, { model: model ?? previous.model, tokens: combined });
        }
      }
    }

    const { content } = message.data;
    if (record.type === "user" && Array.isArray(content) &&
      content.some((block) => blockType.safeParse(block).data?.type === "tool_result")) continue;
    const parts = typeof content === "string" ? [content] : content.flatMap((block) => {
      const parsedBlock = textBlock.safeParse(block);
      return parsedBlock.success ? [parsedBlock.data.text] : [];
    });
    const text = parts.map((part) => part.replace(injectedText, "").trim())
      .filter((part) => part.length > 0 && !interruption.test(part))
      .join("\n");
    if (!text) continue;
    safety?.scanCredential(text, line);
    if (events.length === MAX_CODEX_IMPORT_EVENTS) {
      throw new Error(`The session exceeds the ${MAX_CODEX_IMPORT_EVENTS}-message import limit.`);
    }
    events.push({ role: message.data.role, text, line, timestamp: at.data });
    throughLine = line;
  }

  for (const { model, tokens } of apiMessages.values()) {
    usage.add(model, tokens);
    if (!tokens) usage.markIncomplete();
  }
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
    throw new Error("The file must contain one Claude Code session with readable conversation text.");
  }
  return { ...session, events, analytics, activity: sessionActivity };
}
