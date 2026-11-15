import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  matchesTranscriptMedia, MAX_TRANSCRIPT_ATTACHMENT_BYTES, MAX_TRANSCRIPT_PACKET_BYTES, MAX_TRANSCRIPT_RECORD_BYTES,
  transcriptCursor, transcriptMedia,
} from "@tideline/contracts/transcripts";
import type { TranscriptAppend } from "@tideline/contracts/transcripts";
import { postToTideline, requestTideline } from "./login";
import type { RawSubagentStream } from "./session-jsonl";
import { privateRecordKey, redactCaptureText } from "@tideline/contracts/redaction";
import { createApprovedScope } from "./sync-projects";
import { fileSources, isWithin, sessionFiles } from "./sync-sources";
import type { SyncConfig } from "./sync-storage";

const readSize = 64 * 1024;
const largestSourceLine = 32 * 1024 * 1024;
const jsonRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
const marker = (reason: string) => JSON.stringify({ tideline_omitted: reason });
const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");
const fileRevision = (stat: Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

export function prepareTranscriptRecord(bytes: Buffer | null) {
  const attachments = new Map<string, TranscriptAppend["attachments"][number]>();
  const base64Limit = Math.ceil(MAX_TRANSCRIPT_ATTACHMENT_BYTES / 3) * 4;
  const maxAttachmentTotal = 8 * 1024 * 1024;
  let attachmentBytes = 0;
  let omitted = false;
  let parsed: unknown;
  function missing(reason: string) {
    omitted = true;
    return { tideline_omitted: reason };
  }
  if (!bytes) return { text: marker("Record exceeded the raw line limit"), attachments: [], omitted: true };
  const raw = bytes.toString("utf8").trim();
  if (!raw) return { text: "", attachments: [], omitted: false };
  try { parsed = JSON.parse(raw); } catch { return { text: marker("Invalid source JSON"), attachments: [], omitted: true }; }

  function extract(media: string, base64: string) {
    const mime = transcriptMedia.safeParse(media);
    if (!mime.success || base64.length > base64Limit) return missing("Unsupported attachment type or size");
    const data = Buffer.from(base64, "base64");
    if (!matchesTranscriptMedia(data, mime.data) || data.length > MAX_TRANSCRIPT_ATTACHMENT_BYTES || data.toString("base64") !== base64) {
      return missing("Invalid attachment bytes");
    }
    const digest = createHash("sha256").update(data).digest("hex");
    if (!attachments.has(digest)) {
      if (attachments.size === 32 || attachmentBytes + data.length > maxAttachmentTotal) return missing("Record attachment limit reached");
      attachments.set(digest, { digest, mime: mime.data, bytes: data.length, base64 });
      attachmentBytes += data.length;
    }
    return { tideline_attachment: digest, mime: mime.data };
  }

  function sanitize(value: unknown, depth = 0): unknown {
    if (depth > 80) return missing("Record nesting limit reached");
    if (typeof value === "string") {
      if (/^data:/iu.test(value)) {
        const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/iu.exec(value);
        return data ? extract(data[1].toLowerCase(), data[2]) : missing("Unsupported inline data");
      }
      return redactCaptureText(value);
    }
    if (Array.isArray(value)) return value.map((child) => sanitize(child, depth + 1));
    const object = jsonRecord(value);
    if (!object) return value;
    if (object.type === "base64" && typeof object.media_type === "string" && typeof object.data === "string") {
      return extract(object.media_type, object.data);
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [
      redactCaptureText(key), privateRecordKey(key) ? "[REDACTED]" : sanitize(child, depth + 1),
    ]));
  }
  const text = JSON.stringify(sanitize(parsed));
  if (Buffer.byteLength(text) > MAX_TRANSCRIPT_RECORD_BYTES) {
    return { text: marker("Sanitized record exceeded the upload limit"), attachments: [], omitted: true };
  }
  return { text, attachments: [...attachments.values()], omitted };
}

async function* completeLines(file: FileHandle, start: number, end: number) {
  const buffer = Buffer.allocUnsafe(readSize);
  let position = start;
  let boundary = start;
  let chunks: Buffer[] = [];
  let large = false;
  while (position < end) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position);
    if (!bytesRead) break;
    const data = buffer.subarray(0, bytesRead);
    let from = 0;
    while (from < data.length) {
      const newline = data.indexOf(10, from);
      const next = newline < 0 ? data.length : newline;
      if (!large && position + next - boundary > largestSourceLine) {
        chunks = [];
        large = true;
      }
      if (!large && next > from) chunks.push(Buffer.from(data.subarray(from, next)));
      if (newline < 0) break;
      const offset = position + newline + 1;
      yield { start: boundary, offset, bytes: large ? null : Buffer.concat(chunks) };
      boundary = offset;
      chunks = [];
      large = false;
      from = newline + 1;
    }
    position += bytesRead;
  }
}

function parsedRecord(bytes: Buffer | null) {
  if (!bytes) return undefined;
  try { return jsonRecord(JSON.parse(bytes.toString("utf8"))); } catch { return undefined; }
}

async function withinCheckout(value: Record<string, unknown> | undefined, check: (path: string) => Promise<boolean>) {
  if (!value) return false;
  const payload = jsonRecord(value.payload);
  const { runtime_workspace_roots: roots } = payload ?? {};
  const topRoots = value.runtime_workspace_roots;
  if ([roots, topRoots].some((entry) => entry != null && !Array.isArray(entry))) return false;
  const directories = [value.cwd, payload?.cwd, ...(Array.isArray(roots) ? roots : []),
    ...(Array.isArray(topRoots) ? topRoots : [])];
  for (const directory of directories) {
    if (typeof directory === "string" && !await check(directory)) return false;
    if (directory != null && typeof directory !== "string") return false;
  }
  return true;
}

export type LocatedSubagents = { sourceSessionId: string; projectDirectory: string; streams: RawSubagentStream[] };

type SourceLine = { start: number; offset: number; bytes: Buffer | null };
const omittedLine = (reason: string) => ({ text: marker(reason), attachments: [], omitted: true });

async function prepareSourceLine(line: SourceLine, check: (path: string) => Promise<boolean>,
  sessionId: string, stream?: RawSubagentStream) {
  if (!line.bytes) return;
  if (stream && line.offset <= stream.anchor.start) return omittedLine("Record preceded verified subagent identity");
  const value = parsedRecord(line.bytes);
  if (!value) return line.bytes.toString("utf8").trim() ? undefined : prepareTranscriptRecord(line.bytes);
  if (!stream) return await withinCheckout(value, check) ? prepareTranscriptRecord(line.bytes) : undefined;
  const payload = jsonRecord(value.payload);
  if (stream.source === "codex") {
    if (value.type === "session_meta" && line.start !== stream.anchor.start) return;
    const at = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
    if (!Number.isFinite(at)) return;
    if (at < stream.startedAt) {
      return omittedLine("Inherited parent context");
    }
    if ([value.thread_id, value.session_id, payload?.thread_id].some((id) => id != null && id !== stream.agentId)) return;
  } else if ((value.agentId != null && value.agentId !== stream.agentId) ||
      (value.sessionId != null && value.sessionId !== sessionId) || (value.isSidechain != null && value.isSidechain !== true)) return;
  if (!await withinCheckout(value, check)) return;
  return prepareTranscriptRecord(line.bytes);
}

export function createTranscriptSync(config: SyncConfig) {
  const seen = new Map<string, string>();

  return async (token: string, signal: AbortSignal, subagents: Iterable<LocatedSubagents> = [], waitForChildren = false) => {
    if (!config.fullTranscripts || signal.aborted) return;
    const scope = createApprovedScope(config.projects);
    let deferredChildren = 0;

    async function syncFile({ path, source, sessionId, check, stream }: {
      path: string; source: "codex" | "claude-code"; sessionId: string;
      check: (cwd: string) => Promise<boolean>; stream?: RawSubagentStream;
    }) {
      if (await realpath(path).catch(() => null) !== path) return;
      const stat = await lstat(path).catch(() => null);
      if (!stat?.isFile() || stat.nlink !== 1 || stat.mtimeMs < scope.since ||
          (stream && (stat.dev !== stream.identity.dev || stat.ino !== stream.identity.ino))) return;
      const endpoint = `/v1/cli/sync/transcripts/${config.workspaceId}/${source}/${sessionId}` +
        (stream ? `?stream=${encodeURIComponent(stream.agentId)}` : "");
      const key = stream ? `${endpoint}\0${path}` : path;
      const revision = fileRevision(stat);
      if (seen.get(key) === revision) return;
      const request = { apiOrigin: config.apiOrigin, path: endpoint, accessToken: token, signal };
      const response = await requestTideline({ ...request, method: "GET" });
      if (!response?.ok) return stream && response?.status === 404 ? "deferred" as const : undefined;
      const parsed = transcriptCursor.safeParse(await response.json().catch(() => null));
      if (!parsed.success) return;
      let cursor = parsed.data;
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
      if (!file) return;
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino ||
            opened.size < cursor.offset || await realpath(path).catch(() => null) !== path) return;
        if (stream) {
          const anchor = await completeLines(file, stream.anchor.start, stream.anchor.offset).next();
          if (anchor.done || !anchor.value.bytes || anchor.value.offset !== stream.anchor.offset ||
              createHash("sha256").update(anchor.value.bytes).digest("hex") !== stream.anchor.digest ||
              !await withinCheckout(parsedRecord(anchor.value.bytes), check)) return;
        }
        if (cursor.digest) {
          const last = await completeLines(file, cursor.previousOffset, cursor.offset).next();
          const prepared = last.done ? undefined : await prepareSourceLine(last.value, check, sessionId, stream);
          if (!prepared || digestOf(prepared.text) !== cursor.digest) {
            seen.set(key, revision);
            console.warn("A local transcript changed before its synced cursor. Tideline kept the saved records.");
            return;
          }
        }
        let batch: TranscriptAppend[] = [];
        let totalBytes = 0;
        async function flush() {
          if (!batch.length) return true;
          const result = await postToTideline({ ...request, body: JSON.stringify({ records: batch }) });
          const updated = transcriptCursor.safeParse(result?.ok ? await result.json().catch(() => null) : null);
          if (!updated.success || updated.data.offset !== batch.at(-1)?.offset) return false;
          cursor = updated.data;
          batch = [];
          totalBytes = 0;
          return true;
        }
        let finished = true;
        let scopeBoundary = false;
        for await (const line of completeLines(file, cursor.offset, opened.size)) {
          const content = signal.aborted ? undefined : await prepareSourceLine(line, check, sessionId, stream);
          if (!content) {
            finished = false;
            scopeBoundary = !signal.aborted;
            break;
          }
          const record: TranscriptAppend = { start: line.start, offset: line.offset, ...content };
          const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
          if ((batch.length === 64 || totalBytes + bytes > MAX_TRANSCRIPT_PACKET_BYTES - 100) && !await flush()) {
            finished = false;
            break;
          }
          batch.push(record);
          totalBytes += bytes;
        }
        if (!signal.aborted && await flush() && (finished || (stream && scopeBoundary))) seen.set(key, revision);
      } finally {
        await file.close();
      }
    }

    async function checkoutGuard(projectDirectory: string) {
      const root = await scope.projectScope(projectDirectory);
      const checkout = root && scope.projectRoot(root);
      if (!checkout) return;
      return async (cwd: string) => {
        const resolved = await scope.projectScope(cwd);
        return !!resolved && scope.projectRoot(resolved) === checkout;
      };
    }

    if (config.subagentTranscripts && config.sessionDetails) {
      const waiting: Parameters<typeof syncFile>[0][] = [];
      for (const { sourceSessionId, projectDirectory, streams } of subagents) {
        if (signal.aborted) return;
        const check = await checkoutGuard(projectDirectory);
        if (!check) continue;
        for (const stream of streams) {
          const target = { path: stream.path, source: stream.source, sessionId: sourceSessionId, check, stream };
          if (await syncFile(target) === "deferred" && waitForChildren) waiting.push(target);
        }
      }
      for (let attempt = 0; waiting.length > 0 && attempt < 3 && !signal.aborted; attempt++) {
        await delay(1_000, undefined, { signal }).catch(() => {});
        const deferred = waiting.splice(0);
        for (const target of deferred) {
          if (!signal.aborted && await syncFile(target) === "deferred") waiting.push(target);
        }
      }
      deferredChildren = waiting.length;
    }

    for (const { root, depth, discover } of fileSources(config)) {
      if (!root) continue;
      for await (const path of sessionFiles(root, depth, () => {})) {
        if (signal.aborted) return;
        const real = await realpath(path).catch(() => null);
        if (real !== path || !isWithin(path, root)) continue;
        const stat = await lstat(path).catch(() => null);
        if (!stat?.isFile() || stat.nlink !== 1 || stat.mtimeMs < scope.since) continue;
        if (seen.get(path) === fileRevision(stat)) continue;
        const candidate = await discover(path).catch(() => null);
        if (!candidate || (candidate.source !== "codex" && candidate.source !== "claude-code")) continue;
        const project = await scope.projectScope(candidate.projectDirectory);
        if (!project || !scope.sessionAllowed({ ...candidate, projectDirectory: project })) continue;
        const check = await checkoutGuard(project);
        if (check) await syncFile({ path, source: candidate.source, sessionId: candidate.sourceSessionId, check });
      }
    }
    return { deferredChildren };
  };
}
