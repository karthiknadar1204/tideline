import { lstat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { MAX_SESSION_SUBAGENTS, MAX_SUBAGENT_DEPTH, MAX_SUBAGENT_MESSAGES, MAX_SUBAGENT_TRANSCRIPT_BYTES } from "@tideline/contracts";
import type { SessionCapture } from "@tideline/contracts";
import { redactCaptureText } from "./session-capture";
import type { RawSubagentStream } from "./session-jsonl";

export type SubagentSection = NonNullable<SessionCapture["subagents"]>;
export type SubagentTranscript = SubagentSection["transcripts"][number];
export type SubagentLink = Pick<SubagentTranscript, "agentId" | "line" | "index" | "name" | "status">;
export type SubagentScope = {
  checkout: string;
  projectScope: (directory: string) => Promise<string | undefined>;
  projectRoot?: (directory: string) => string | undefined;
  includeRaw?: boolean;
};
export const maxSubagentFileRead = 256 * 1024;
export const maxRawSubagentPreview = 10 * 1024 * 1024;

export function sourceAnchor(text: string, start: number, offset: number) {
  return { start, offset, digest: createHash("sha256").update(text).digest("hex") };
}

export type SubagentBranch = SubagentLink & { parentAgentId?: string };

export async function readSubagentTree({ source, rootLinks, locate, read }: {
  source: SubagentSection["source"];
  rootLinks: SubagentLink[];
  locate: (link: SubagentLink) => Promise<readonly string[]> | readonly string[];
  read: (link: SubagentBranch, file: string) => Promise<{
    transcript: SubagentTranscript; links: SubagentLink[]; raw?: RawSubagentStream;
  } | undefined>;
}) {
  const section: SubagentSection = { source, truncated: false, transcripts: [] };
  const raw: RawSubagentStream[] = [];
  const pending: { link: SubagentBranch; depth: number }[] = [];
  const tracked: SubagentBranch[] = [];
  const seen = new Set<string>();

  function enqueue(links: SubagentLink[], depth: number, parentAgentId?: string) {
    for (const link of links) {
      if (depth > MAX_SUBAGENT_DEPTH || seen.size >= MAX_SESSION_SUBAGENTS || seen.has(link.agentId)) {
        section.truncated = true;
        continue;
      }
      seen.add(link.agentId);
      pending.push({ depth, link: { ...link, parentAgentId } });
    }
  }

  async function revision(files: readonly string[]) {
    return Promise.all(files.map(async (file) => {
      const stat = await lstat(file).catch(() => undefined);
      return stat?.isFile() && stat.nlink === 1 ? [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs] : [file];
    }));
  }

  enqueue(rootLinks, 1);
  if (!pending.length) return { section, raw };
  const revisions: Awaited<ReturnType<typeof revision>>[] = [];
  for (const { link, depth } of pending) {
    tracked.push(link);
    const files = await locate(link);
    revisions.push(await revision(files));
    for (const file of files) {
      const result = await read(link, file);
      if (!result) continue;
      const { transcript, links } = result;
      if (transcript.truncated) section.truncated = true;
      if (!transcript.messages.length && !links.length && !result.raw) continue;
      section.transcripts.push(transcript);
      if (result.raw) raw.push(result.raw);
      enqueue(links, depth + 1, link.agentId);
      break;
    }
  }
  return { section, raw, sidecarRevision: {
    value: JSON.stringify(revisions),
    async read() {
      return JSON.stringify(await Promise.all(tracked.map(async (link) => revision(await locate(link)))));
    },
  } };
}

export async function inSubagentCheckout(directory: string, { checkout, projectScope, projectRoot }: SubagentScope) {
  const workingDirectory = await projectScope(directory);
  if (!workingDirectory) return false;
  const localPath = relative(checkout, workingDirectory);
  return localPath !== ".." && !localPath.startsWith(`..${sep}`) && !isAbsolute(localPath) &&
    (!projectRoot || projectRoot(workingDirectory) === checkout);
}

export function appendSubagentMessage(transcript: SubagentTranscript, message: SubagentTranscript["messages"][number]) {
  const text = redactCaptureText(message.text.replace(/data:[^,\r\n]{1,100};base64,[A-Za-z0-9+/=_-]*/giu, "[Attachment omitted]"));
  const record = { ...message, text };
  const candidate = { ...transcript, throughLine: message.line, messages: [...transcript.messages, record] };
  if (transcript.messages.length >= MAX_SUBAGENT_MESSAGES || Buffer.byteLength(JSON.stringify(candidate)) > MAX_SUBAGENT_TRANSCRIPT_BYTES - 32) {
    transcript.truncated = true;
    return false;
  }
  transcript.messages.push(record);
  transcript.throughLine = message.line;
  return true;
}
import { createHash } from "node:crypto";
