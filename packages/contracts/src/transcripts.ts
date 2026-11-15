import { z } from "zod";
import { privateRecordKey, redactCaptureText } from "./redaction";

export const MAX_TRANSCRIPT_RECORD_BYTES = 4 * 1024 * 1024;
export const MAX_TRANSCRIPT_ATTACHMENT_BYTES = 6 * 1024 * 1024;
export const MAX_TRANSCRIPT_PACKET_BYTES = 16 * 1024 * 1024;
export const transcriptHash = z.string().regex(/^[a-f0-9]{64}$/u);
export const transcriptMedia = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const transcriptSource = z.enum(["codex", "claude-code"]);
export const transcriptStream = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
export const transcriptStreams = z.strictObject({ streams: z.array(transcriptStream).max(20) });
export const transcriptLocator = z.object({ workspaceId: z.uuid(), source: transcriptSource, sourceId: z.uuid() });
export const transcriptCursor = z.strictObject({
  line: z.int().nonnegative(),
  offset: z.int().nonnegative(),
  previousOffset: z.int().nonnegative(),
  digest: transcriptHash.nullable(),
});
const attachmentReference = z.strictObject({ digest: transcriptHash, mime: transcriptMedia, bytes: z.int().positive().max(MAX_TRANSCRIPT_ATTACHMENT_BYTES) });
const attachment = attachmentReference.extend({ base64: z.string().min(4).max(Math.ceil(MAX_TRANSCRIPT_ATTACHMENT_BYTES / 3) * 4) });
export const transcriptRecord = z.strictObject({
  line: z.int().positive(),
  text: z.string().max(MAX_TRANSCRIPT_RECORD_BYTES),
  omitted: z.boolean().default(false),
  attachments: z.array(attachmentReference).max(32),
});
export const transcriptAppend = z.strictObject({
  start: z.int().nonnegative(), offset: z.int().positive(), text: transcriptRecord.shape.text,
  omitted: z.boolean().default(false), attachments: z.array(attachment).max(32),
}).refine(({ start, offset, attachments }) => start < offset && new Set(attachments.map(({ digest }) => digest)).size === attachments.length);
export const transcriptBatch = z.strictObject({ records: z.array(transcriptAppend).min(1).max(100) })
  .refine(({ records }) => records.every(({ start }, index) => index === 0 || start === records[index - 1].offset));
export const transcriptPage = z.strictObject({
  total: z.int().nonnegative(), records: z.array(transcriptRecord), after: z.int().positive().nullable(),
});
export type TranscriptAppend = z.infer<typeof transcriptAppend>;
export type TranscriptRecord = z.infer<typeof transcriptRecord>;

export function isRedactedTranscriptText(value: unknown, depth = 0): boolean {
  if (depth > 81) return false;
  if (typeof value === "string") return !/^data:[^,]{1,128};base64,/iu.test(value) && redactCaptureText(value) === value;
  if (Array.isArray(value)) return value.every((child) => isRedactedTranscriptText(child, depth + 1));
  if (!value || typeof value !== "object") return true;
  if ("type" in value && value.type === "base64" && "data" in value && typeof value.data === "string") return false;
  return Object.entries(value).every(([key, child]) => redactCaptureText(key) === key && (
    privateRecordKey(key) ? child === "[REDACTED]" : isRedactedTranscriptText(child, depth + 1)
  ));
}

export function matchesTranscriptMedia(bytes: Uint8Array, mime: z.infer<typeof transcriptMedia>) {
  const has = (header: number[], offset = 0) => bytes.length >= offset + header.length && header.every((byte, index) => bytes[offset + index] === byte);
  switch (mime) {
    case "image/png": return has([137, 80, 78, 71, 13, 10, 26, 10]);
    case "image/jpeg": return has([255, 216, 255]);
    case "image/gif": return has([71, 73, 70, 56, 55, 97]) || has([71, 73, 70, 56, 57, 97]);
    case "image/webp": return has([82, 73, 70, 70]) && has([87, 69, 66, 80], 8);
  }
}
