import { dirname } from "node:path";
import { z } from "zod";
import { createCodexActivity } from "./codex-activity";
import { appendSubagentMessage, inSubagentCheckout, maxRawSubagentPreview, maxSubagentFileRead, readSubagentTree, sourceAnchor } from "./subagent-transcript";
import type { SubagentBranch, SubagentLink, SubagentScope, SubagentTranscript } from "./subagent-transcript";
import type { RawSubagentStream } from "./session-jsonl";
import { readTranscriptSidecar } from "./transcript-sidecar";

const record = z.object({ type: z.string(), timestamp: z.iso.datetime(), payload: z.unknown() });
const metadata = z.object({
  id: z.uuid(),
  cwd: z.string(),
  parent_thread_id: z.uuid().nullish(),
  forked_from_id: z.uuid().nullish(),
  runtime_workspace_roots: z.array(z.string()).nullish(),
  thread_source: z.string().nullish(),
  source: z.unknown().optional(),
});
const childSource = z.object({ subagent: z.object({ thread_spawn: z.object({ parent_thread_id: z.uuid() }) }) });
const otherSource = z.object({ subagent: z.unknown().optional(), internal: z.unknown().optional() });
const context = z.object({ cwd: z.string().optional() });
const message = z.object({ type: z.literal("message"), role: z.enum(["user", "assistant"]), content: z.array(z.unknown()) });
const textPart = z.object({ type: z.enum(["input_text", "output_text"]), text: z.string() });
export const codexContext = /^(?:#\s*agents\.md instructions for\b|<(?:environment_context|user_instructions|permissions instructions|skill|skills_instructions)(?:\s|>))/iu;

export async function readCodexSubagents({ sessionId, links, find, ...scope }: {
  sessionId: string;
  links: SubagentLink[];
  find: (id: string) => readonly string[];
} & SubagentScope) {
  async function readTranscript(link: SubagentBranch, filename: string) {
    const directory = dirname(filename);
    const file = await readTranscriptSidecar(directory, filename, scope.includeRaw ? maxRawSubagentPreview : maxSubagentFileRead);
    if (!file) return;
    const throughNewline = file.text.lastIndexOf("\n");
    if (throughNewline === -1) return;
    const transcript: SubagentTranscript = { ...link, throughLine: 1, truncated: file.truncated, messages: [] };
    const activity = createCodexActivity();
    let startedAt: number | undefined;
    let rawStream: RawSubagentStream | undefined;
    let offset = 0;
    let captureMessages = true;
    for (const [index, raw] of file.text.slice(0, throughNewline).split("\n").entries()) {
      const start = offset;
      if (scope.includeRaw) offset += Buffer.byteLength(raw) + 1;
      if (!raw.trim()) continue;
      let json: unknown;
      try { json = JSON.parse(raw); } catch { return; }
      const event = record.safeParse(json).data;
      if (!event) continue;
      if (startedAt === undefined) {
        const meta = event.type === "session_meta" ? metadata.safeParse(event.payload).data : undefined;
        if (!meta || meta.id !== link.agentId) return;
        const source = otherSource.safeParse(meta.source).data;
        const nested = childSource.safeParse(meta.source).data?.subagent.thread_spawn.parent_thread_id;
        const parent = link.parentAgentId ?? sessionId;
        if ((meta.parent_thread_id ?? nested) !== parent || (nested && nested !== parent) ||
            source?.internal !== undefined || (source?.subagent !== undefined && nested === undefined) ||
            (meta.thread_source && meta.thread_source !== "subagent") ||
            (meta.forked_from_id && meta.forked_from_id !== parent)) return;
        for (const directory of [meta.cwd, ...(meta.runtime_workspace_roots ?? [])]) {
          if (!await inSubagentCheckout(directory, scope)) return;
        }
        startedAt = Date.parse(event.timestamp);
        if (scope.includeRaw) rawStream = {
          source: "codex", agentId: link.agentId, path: filename, identity: file.identity, startedAt,
          anchor: sourceAnchor(raw, start, offset),
        };
        continue;
      }
      if (event.type === "session_meta") return;
      if (Date.parse(event.timestamp) < startedAt) continue;
      const line = index + 1;
      transcript.throughLine = line;
      if (event.type === "turn_context") {
        const update = context.safeParse(event.payload).data;
        if (!update || (update.cwd && !await inSubagentCheckout(update.cwd, scope))) return;
        continue;
      }
      if (event.type === "event_msg") {
        activity.event(event.payload, line, link.agentId);
        continue;
      }
      if (event.type !== "response_item") continue;
      activity.response(event.payload, line);
      if (!captureMessages) continue;
      const item = message.safeParse(event.payload).data;
      if (!item) continue;
      const type = item.role === "user" ? "input_text" : "output_text";
      const content = item.content.flatMap((block) => {
        const part = textPart.safeParse(block).data;
        return part?.type === type && !(item.role === "user" && codexContext.test(part.text.trimStart())) ? [part.text] : [];
      }).join("\n");
      if (!content.trim()) continue;
      captureMessages = appendSubagentMessage(transcript, { line, text: content, role: item.role, timestamp: event.timestamp });
    }
    if (startedAt === undefined) return;
    return { transcript, links: activity.subagentLinks(), raw: rawStream };
  }

  return readSubagentTree({ source: "codex-rollout", rootLinks: links, locate: ({ agentId }) => find(agentId), read: readTranscript });
}
