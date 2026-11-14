import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { MAX_CODEX_IMPORT_BYTES } from "@tideline/contracts";
import type { SessionImportRequest, SessionSource } from "@tideline/contracts";
import type { SessionEvidence } from "./session-safety";

export type SessionProjection = SessionImportRequest["session"];
export type LiveReadOptions = { live: true; projectDirectory?: string; since?: number };
export type LiveSession = { projectDirectory: string; session: SessionProjection; evidence?: SessionEvidence };

export function sourceSessionUuid(source: SessionSource, nativeId: string) {
  const digest = createHash("sha256").update(source).update("\0").update(nativeId).digest("hex");
  const variant = ((Number.parseInt(digest[16], 16) & 3) | 8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

const chunkSize = 32 * 1024;

export async function* readJsonl(path: string, live = false): AsyncGenerator<{ value: unknown; line: number }> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (live ? constants.O_NOFOLLOW : 0);
  const file = await open(path, flags).catch(() => {
    throw new Error("Could not open the selected session JSONL file.");
  });

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let position = 0;
  let line = 0;
  let remainder = Buffer.alloc(0);

  function parse(bytes: Uint8Array) {
    line++;
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw new Error("The selected file must contain valid UTF-8.");
    }
    if (!text.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON at line ${line}.`);
    }
    return { value, line };
  }

  try {
    const initial = await file.stat();
    if (!initial.isFile()) throw new Error("Select a regular session JSONL file.");
    if (!live && initial.size > MAX_CODEX_IMPORT_BYTES) {
      throw new Error("The selected file exceeds the 1 MiB import limit.");
    }

    const buffer = Buffer.alloc(chunkSize);
    const end = Math.min(initial.size, MAX_CODEX_IMPORT_BYTES);

    while (position < end) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position);
      if (bytesRead === 0) throw new Error("The session file changed while Tideline read it.");
      position += bytesRead;

      const data = Buffer.concat([remainder, buffer.subarray(0, bytesRead)]);
      let start = 0;
      let newline = data.indexOf(0x0a);
      while (newline !== -1) {
        const record = parse(data.subarray(start, newline));
        if (record) yield record;
        start = newline + 1;
        newline = data.indexOf(0x0a, start);
      }
      remainder = data.subarray(start);
    }

    if (initial.size > MAX_CODEX_IMPORT_BYTES) {
      throw new Error("The selected file exceeds the 1 MiB import limit.");
    }
    if (!live && remainder.length) {
      const record = parse(remainder);
      if (record) yield record;
    }

    const current = await file.stat();
    if (current.size !== initial.size || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs) {
      throw new Error("The session file changed while Tideline read it.");
    }
  } finally {
    await file.close();
  }
}

export function createProjectScope(approvedDirectory?: string) {
  const resolved = new Map<string, string | undefined>();

  return async (directory: string | undefined) => {
    if (!directory || !isAbsolute(directory)) return;
    if (resolved.has(directory)) return resolved.get(directory);
    const physical = await realpath(directory).catch(() => undefined);
    if (physical && !await stat(physical).then((entry) => entry.isDirectory(), () => false)) {
      resolved.set(directory, undefined);
      return;
    }
    let allowed = physical;
    if (physical && approvedDirectory) {
      const path = relative(approvedDirectory, physical);
      if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) allowed = undefined;
    }
    resolved.set(directory, allowed);
    return allowed;
  };
}
