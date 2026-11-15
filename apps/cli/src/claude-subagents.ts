import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { claudeSubagentId } from "@tideline/contracts";
import { z } from "zod";
import { createClaudeActivity } from "./claude-activity";
import { readTranscriptSidecar } from "./transcript-sidecar";
import { claudeConversationText } from "./claude-text";
import { appendSubagentMessage, inSubagentCheckout, maxRawSubagentPreview, maxSubagentFileRead, readSubagentTree, sourceAnchor } from "./subagent-transcript";
import type { SubagentBranch, SubagentLink, SubagentScope, SubagentTranscript } from "./subagent-transcript";
import type { RawSubagentStream } from "./session-jsonl";

const childRecord = z.object({
  type: z.enum(["user", "assistant"]),
  isSidechain: z.literal(true),
  sessionId: z.uuid(),
  agentId: claudeSubagentId,
  cwd: z.string(),
  timestamp: z.iso.datetime(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  isSynthetic: z.boolean().optional(),
  userType: z.string().optional(),
  toolUseResult: z.unknown().optional(),
  sourceToolAssistantUUID: z.unknown().optional(),
  origin: z.object({ kind: z.string().optional() }).nullish().catch(undefined),
  message: z.object({
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(z.unknown())]),
    model: z.string().optional(),
  }),
});

export async function readClaudeSubagents({ path, sessionId, links, ...scope }: {
  path: string;
  sessionId: string;
  links: SubagentLink[];
} & SubagentScope) {
  if (!isAbsolute(path) || basename(path) !== `${sessionId}.jsonl`) return;
  const directory = join(dirname(path), sessionId, "subagents");
  async function readTranscript(link: SubagentBranch, filename: string) {
    const file = await readTranscriptSidecar(directory, filename, scope.includeRaw ? maxRawSubagentPreview : maxSubagentFileRead);
    if (!file) return;
    const throughNewline = file.text.lastIndexOf("\n");
    if (throughNewline === -1) return;
    const transcript: SubagentTranscript = { ...link, throughLine: 1, truncated: file.truncated, messages: [] };
    const activity = createClaudeActivity();
    let rawStream: RawSubagentStream | undefined;
    let offset = 0;
    let captureMessages = true;
    for (const [index, raw] of file.text.slice(0, throughNewline).split("\n").entries()) {
      const start = offset;
      if (scope.includeRaw) offset += Buffer.byteLength(raw) + 1;
      if (!raw.trim()) continue;
      let json: unknown;
      try { json = JSON.parse(raw); } catch { return; }
      const record = childRecord.safeParse(json).data;
      if (!record || record.type !== record.message.role) continue;
      if (record.sessionId !== sessionId || record.agentId !== link.agentId) return;
      if (!await inSubagentCheckout(record.cwd, scope)) return;
      if (scope.includeRaw && !rawStream) rawStream = {
        source: "claude-code", agentId: link.agentId, path: filename, identity: file.identity,
        anchor: sourceAnchor(raw, start, offset),
      };
      const line = index + 1;
      transcript.throughLine = line;
      if (record.isMeta || record.isCompactSummary || record.isSynthetic || record.message.model === "<synthetic>" ||
          (record.userType && record.userType !== "external")) continue;
      const isTaskNotification = record.origin?.kind === "task-notification";
      await activity.observe({
        line, timestamp: record.timestamp, role: record.message.role, content: record.message.content, metadata: record.toolUseResult,
        isTaskNotification, attributionSkill: undefined, uuid: undefined,
      });
      if (!captureMessages || record.toolUseResult !== undefined || record.sourceToolAssistantUUID !== undefined || isTaskNotification) continue;
      const content = claudeConversationText(record.message.role, record.message.content);
      if (!content) continue;
      captureMessages = appendSubagentMessage(transcript, { line, text: content, role: record.message.role, timestamp: record.timestamp });
    }
    return { transcript, links: activity.subagentLinks(), raw: rawStream };
  }

  return readSubagentTree({ source: "claude-code-sidecar", rootLinks: links, read: readTranscript,
    async locate({ agentId }) {
      return await realpath(directory).catch(() => undefined) === directory ? [join(directory, `agent-${agentId}.jsonl`)] : [];
    },
  });
}
