import { isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_SESSION_ACTIVITY_ITEMS, MAX_SESSION_CAPTURE_BYTES, MAX_SESSION_CAPTURE_FILES, MAX_SESSION_CAPTURE_TEXT } from "@tideline/contracts";
import type { SessionCapture } from "@tideline/contracts";
import { privateRecordKey, redactCaptureText } from "@tideline/contracts/redaction";

export { redactCaptureText };

type ToolDetail = SessionCapture["tools"][number];
type FileDetail = SessionCapture["files"][number];
type SetupDetail = SessionCapture["setup"];
type Location = Pick<ToolDetail, "line" | "index">;

const omittedAttachment = "[Attachment omitted]";
const binaryTypes = new Set(["audio", "document", "file", "image", "input_audio", "input_file", "input_image", "output_image"]);
const textTypes = new Set(["input_text", "output_text", "text"]);
const privatePath = /(?:^|\/)(?:\.git|\.ssh|\.aws|\.gnupg|\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:\.[^/]*)?|auth\.json|id_(?:rsa|ed25519|ecdsa|dsa)|[^/]+\.(?:pem|key|p12|pfx))(?=\/|$)/iu;
const validSetupValue = /^[A-Za-z0-9][A-Za-z0-9_.:/ -]{0,119}$/u;

const redact = redactCaptureText;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  return Object.fromEntries(Object.entries(value));
}

export function isSensitiveFile(path: string) {
  return privatePath.test(path.replaceAll("\\", "/"));
}

export function hasSensitiveToolPath(value: unknown) {
  let source = value;
  if (typeof source === "string") {
    for (const [, path] of source.matchAll(/^\*{3} (?:Add File|Update File|Delete File|Move to): ([^\r\n]+)$/gmu)) {
      if (isSensitiveFile(path)) return true;
    }
    if (!/^\s*\{/u.test(source)) return false;
    try { source = JSON.parse(source); } catch { return false; }
  }
  const record = asRecord(source);
  if (!record) return false;
  return [record.path, record.file_path, record.filePath, record.filename].some((path) =>
    typeof path === "string" && isSensitiveFile(path));
}

function projectTool(value: unknown) {
  let omitted = false;
  function scrub(node: unknown, depth: number): unknown {
    if (typeof node === "string") {
      const embedded = node.replace(/data:[^,\r\n]{1,100};base64,[A-Za-z0-9+/=_-]*/giu, omittedAttachment);
      if (embedded !== node) {
        omitted = true;
      }
      return redact(embedded);
    }
    if (node === null || typeof node !== "object") return node;
    if (depth >= 32) {
      omitted = true;
      return "[Nested content omitted]";
    }
    if (Array.isArray(node)) return node.map((item) => scrub(item, depth + 1));

    const record = asRecord(node);
    if (!record) return null;
    if ((typeof record.type === "string" && binaryTypes.has(record.type)) ||
        (record.type === "base64" && typeof record.data === "string")) {
      omitted = true;
      return omittedAttachment;
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
      if (normalized === "base64" || normalized === "blob") {
        omitted = true;
        return [redact(key), omittedAttachment];
      }
      return [redact(key), privateRecordKey(key) ? "[REDACTED]" : scrub(child, depth + 1)];
    }));
  }

  let source = value;
  if (typeof source === "string" && /^\s*[[{]/u.test(source)) {
    try { source = JSON.parse(source); } catch { /* The runner returned plain text. */ }
  }
  const body = scrub(source, 0);
  const parts = Array.isArray(body) ? body.map((part) => {
    if (part === omittedAttachment) return part;
    const record = asRecord(part);
    if (typeof record?.type === "string" && textTypes.has(record.type) && typeof record.text === "string") {
      return record.text;
    }
  }) : undefined;
  const text = typeof body === "string" ? body :
    parts?.length && parts.every((part) => part !== undefined) ? parts.join("\n") : JSON.stringify(body, null, 2);
  return { text, omitted };
}

function repositoryPath(value: string, root: string, workingDirectory: string) {
  const display = relative(root, resolve(workingDirectory, value)).split(sep).join("/");
  if (!display || display === ".." || display.startsWith("../") || isAbsolute(display) ||
      display.length > 512 || isSensitiveFile(display) || /[\\\u0000-\u001F\u007F\uD800-\uDFFF]/u.test(display) ||
      redact(display) !== display) return;
  return display;
}

function prefixLines(text: string, prefix: "+" | "-") {
  if (!text) return "";
  const normalized = text.replace(/\r\n/gu, "\n");
  const content = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = content.split("\n").map((line) => prefix + line).join("\n");
  return normalized.endsWith("\n") ? lines : `${lines}\n\\ No newline at end of file`;
}

export function fileReplacement(before: string | undefined, after: string | undefined, fullFile = false) {
  if (before === undefined && after === undefined) return null;
  const body = [before === undefined ? "" : prefixLines(before, "-"),
    after === undefined ? "" : prefixLines(after, "+")].filter(Boolean).join("\n");
  if (!fullFile || !body) return body;
  const lineRange = (text: string | undefined) => {
    if (!text) return "0,0";
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return `1,${lines}`;
  };
  return `@@ -${lineRange(before)} +${lineRange(after)} @@\n${body}`;
}

export function unifiedHunks(diff: string | undefined) {
  if (!diff) return null;
  const hunkStart = /^@@ -[0-9]/mu.exec(diff);
  return hunkStart ? diff.slice(hunkStart.index) : null;
}

export function createSessionCapture() {
  const tools = new Map<string, ToolDetail>();
  const files: FileDetail[] = [];
  const settings: SetupDetail = {};
  let throughLine = 0;
  let truncated = false;
  let usedBytes = 0;
  // Each item includes its JSON punctuation. Leave room for the setup object and cursor.
  const payloadLimit = MAX_SESSION_CAPTURE_BYTES - 8_192;

  function bytes(value: ToolDetail | FileDetail) {
    return Buffer.byteLength(JSON.stringify(value)) + 1;
  }

  function bound(text: string) {
    return text.slice(0, MAX_SESSION_CAPTURE_TEXT).replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
  }

  function tool(location: Location, line: number, update: { input?: unknown; output?: unknown; truncated?: boolean }) {
    if (update.input == null && update.output == null && !update.truncated) return;
    throughLine = line;
    const key = `${location.line}:${location.index}`;
    const existing = tools.get(key);
    if (!existing && tools.size >= MAX_SESSION_ACTIVITY_ITEMS) {
      truncated = true;
      return;
    }
    const detail: ToolDetail = existing ? { ...existing } : {
      line: location.line, index: location.index, input: null, output: null, truncated: false,
    };
    if (existing) usedBytes -= bytes(existing);
    for (const field of ["input", "output"] as const) {
      if (update[field] == null) continue;
      const content = projectTool(update[field]);
      if (content.text === undefined) continue;
      const previous = detail[field];
      const text = bound(content.text);
      if (previous !== null && previous.length > text.length) continue;
      detail[field] = text;
      const cap = content.omitted || text.length < content.text.length;
      if (bytes(detail) + usedBytes > payloadLimit) {
        detail[field] = previous;
        detail.truncated = true;
      } else {
        detail.truncated ||= cap;
      }
    }
    detail.truncated ||= update.truncated === true;
    if (bytes(detail) + usedBytes > payloadLimit) {
      truncated = true;
      return;
    }
    usedBytes += bytes(detail);
    tools.set(key, detail);
    truncated ||= detail.truncated;
  }

  function file({ line, index, root, workingDirectory, path: sourcePath, previousPath: sourcePrevious, change, diff }: Location & {
    root: string; workingDirectory: string; path: string; previousPath?: string;
    change: FileDetail["change"]; diff: () => string | null;
  }) {
    throughLine = line;
    const path = repositoryPath(sourcePath, root, workingDirectory);
    const previousPath = sourcePrevious && repositoryPath(sourcePrevious, root, workingDirectory) || null;
    if (!path || (sourcePrevious && !previousPath) || files.length >= MAX_SESSION_CAPTURE_FILES) {
      truncated = true;
      return;
    }
    const oldHeader = change === "added" ? "/dev/null" : "a/" + (previousPath ?? path);
    const newHeader = change === "deleted" ? "/dev/null" : "b/" + path;
    const patch = diff();
    const formatted = patch === null ? null : redact(`--- ${oldHeader}\n+++ ${newHeader}\n${patch}`);
    const text = formatted === null ? null : bound(formatted);
    const detail: FileDetail = { line, index, path, previousPath, change, diff: text,
      truncated: formatted !== null && text !== null && text.length < formatted.length };
    if (bytes(detail) + usedBytes > payloadLimit) {
      detail.diff = null;
      detail.truncated = true;
    }
    if (bytes(detail) + usedBytes > payloadLimit) {
      truncated = true;
      return;
    }
    usedBytes += bytes(detail);
    files.push(detail);
    truncated ||= detail.truncated;
  }

  function setup(line: number, fields: Partial<Record<keyof SetupDetail, unknown>>) {
    for (const key of Object.keys(fields) as (keyof SetupDetail)[]) {
      const field = fields[key];
      if (typeof field !== "string" || !validSetupValue.test(field) || redact(field) !== field) continue;
      settings[key] = field;
      throughLine = line;
    }
  }

  function snapshot(messageLine: number): SessionCapture {
    return { throughLine: Math.max(throughLine, messageLine), truncated, tools: [...tools.values()], files, setup: settings };
  }

  return { tool, file, setup, snapshot };
}

export type SessionCaptureBuilder = ReturnType<typeof createSessionCapture>;
