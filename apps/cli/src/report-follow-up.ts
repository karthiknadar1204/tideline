import { codexImportResponse, MAX_CODEX_IMPORT_BYTES, reportFollowUpRequest } from "@tideline/contracts";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import { readClaudeSession } from "./claude-session";
import { CliLoginRequired, openCliAccount } from "./cli-account";
import { readCodexSession } from "./codex-session";
import { tidelineApiOrigin } from "./login";
import type { LiveReadOptions, SessionProjection } from "./session-jsonl";
import { redactConversationText } from "./session-safety";
import { configuredAgentRoots, fileSources } from "./sync-sources";
import { ensureSyncDirectory, openPrivateDatabase, SyncSetupMissingError } from "./sync-storage";

const sourceSchema = z.enum(["codex", "claude-code"]);
const nativeSession = z.object({
  source: sourceSchema,
  sourceSessionId: z.uuid().toLowerCase(),
  path: z.string().min(1),
  dev: z.int(),
  ino: z.int(),
  afterLine: z.int().positive(),
  approvedThroughLine: z.int().positive(),
  prefixDigest: z.string().length(64),
});
const followerSchema = nativeSession.extend({
  userId: z.string().min(1),
  apiOrigin: z.url(),
  workspaceId: z.uuid(),
  reportId: z.uuid(),
  sessionId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
type Follower = z.infer<typeof followerSchema>;
type FollowSource = z.infer<typeof sourceSchema>;
const fileName = "report-follow-ups.sqlite";
const live: LiveReadOptions = {
  live: true,
  captureDetails: true,
  projectScope: async (directory) => directory && isAbsolute(directory) ? directory : undefined,
};

function prefixDigest({ events, startedAt }: SessionProjection, throughLine: number) {
  return createHash("sha256").update(JSON.stringify([startedAt, events.filter(({ line }) => line <= throughLine)])).digest("hex");
}

function readLive(path: string, source: FollowSource) {
  return source === "codex" ? readCodexSession(path, live) : readClaudeSession(path, live);
}

async function followDatabase(create = false) {
  try {
    const db = await openPrivateDatabase(await ensureSyncDirectory(create), fileName, create);
    try {
      db.exec(`PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS followers (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    if (!create && (error instanceof SyncSetupMissingError ||
      (error instanceof Error && "code" in error && error.code === "ENOENT"))) return;
    throw error;
  }
}

function key({ apiOrigin, userId, workspaceId, reportId, sessionId }: Follower) {
  return JSON.stringify([apiOrigin, userId, workspaceId, reportId, sessionId]);
}

export async function prepareReportFollower(file: string, source: FollowSource, expectedSessionId?: string) {
  const initial = await lstat(file);
  if (!initial.isFile()) throw new Error("Choose a regular native agent session file for follow-up.");
  const path = await realpath(file);
  const inside = fileSources(await configuredAgentRoots()).some(({ source: kind, root }) => {
    if (kind !== source || !root) return false;
    const local = relative(root, path);
    return local !== "" && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
  });
  if (!inside) throw new Error("Choose a session from your configured Codex or Claude Code logs for follow-up.");

  const projection = await readLive(path, source);
  const latest = await lstat(path);
  if (!projection || latest.dev !== initial.dev || latest.ino !== initial.ino ||
      (expectedSessionId && projection.session.sourceSessionId.toLowerCase() !== expectedSessionId)) {
    throw new Error("The local session changed. Confirm its native ID and retry follow-up.");
  }
  const approvedThroughLine = projection.session.events.at(-1)?.line ?? 0;
  return nativeSession.parse({
    source, sourceSessionId: projection.session.sourceSessionId, path, dev: initial.dev, ino: initial.ino,
    afterLine: approvedThroughLine, approvedThroughLine, prefixDigest: prefixDigest(projection.session, approvedThroughLine),
  });
}

export async function saveReportFollower(local: z.infer<typeof nativeSession>, approval: {
  userId: string;
  workspaceId: string;
  reportId: string;
  sessionId: string;
  followUntil?: string;
}) {
  const follower = followerSchema.parse({ ...local, ...approval, followUntil: undefined, expiresAt: approval.followUntil, apiOrigin: tidelineApiOrigin() });
  const db = await followDatabase(true);
  if (!db) throw new Error("Could not open local report follow-up storage.");
  try {
    db.prepare("INSERT OR REPLACE INTO followers (key, value) VALUES (?, ?)").run(key(follower), JSON.stringify(follower));
  } finally {
    db.close();
  }
  console.info(`New conversation messages from this session can sync until ${follower.expiresAt}.`);
}

export async function forgetReportFollowers(userId: string, apiOrigin: string) {
  const db = await followDatabase();
  if (!db) return;
  try {
    db.exec("PRAGMA secure_delete = ON");
    db.prepare("DELETE FROM followers WHERE json_extract(value, '$.userId') = ? AND json_extract(value, '$.apiOrigin') = ?")
      .run(userId, apiOrigin);
  } finally {
    db.close();
  }
}

async function readFollowers(source?: FollowSource, sourceSessionId?: string) {
  const db = await followDatabase();
  if (!db) return [];
  try {
    const now = new Date().toISOString();
    db.prepare("DELETE FROM followers WHERE json_extract(value, '$.expiresAt') <= ?").run(now);
    return db.prepare(`SELECT value FROM followers WHERE json_extract(value, '$.apiOrigin') = ?
      AND (? IS NULL OR (json_extract(value, '$.source') = ? AND json_extract(value, '$.sourceSessionId') = ?))`)
      .all(tidelineApiOrigin(), source ?? null, source ?? null, sourceSessionId ?? null)
      .flatMap(({ value }) => {
        const parsed = followerSchema.safeParse(JSON.parse(String(value))).data;
        return parsed ? [parsed] : [];
      });
  } finally {
    db.close();
  }
}

function isSameFile(stat: Awaited<ReturnType<typeof lstat>>, follower: Follower) {
  return stat.isFile() && stat.dev === follower.dev && stat.ino === follower.ino;
}

export async function hasReportFollowers(source: FollowSource, sessionId: string) {
  return (await readFollowers(source, sessionId.toLowerCase())).length > 0;
}

async function syncFollower(follower: Follower, signal?: AbortSignal) {
  const client = await openCliAccount({ workspace: follower.workspaceId });
  if (client.userId !== follower.userId) return;
  if (await realpath(follower.path) !== follower.path || !isSameFile(await lstat(follower.path), follower)) return;
  const projection = await readLive(follower.path, follower.source);
  if (!projection || projection.session.sourceSessionId.toLowerCase() !== follower.sourceSessionId ||
      await realpath(follower.path) !== follower.path || !isSameFile(await lstat(follower.path), follower)) return;

  if (prefixDigest(projection.session, follower.approvedThroughLine) !== follower.prefixDigest) return;
  const events = projection.session.events
    .filter(({ line }) => line > follower.afterLine)
    .map((event) => ({ ...event, text: redactConversationText(event.text) }));
  if (!events.length || signal?.aborted) return;
  const payload = reportFollowUpRequest.parse({ events });
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_CODEX_IMPORT_BYTES) return;

  const url = `/v1/cli/workspaces/${follower.workspaceId}/saved-reports/${follower.reportId}/sessions/${follower.sessionId}/follow`;
  const receipt = await client.post(url, payload, codexImportResponse, signal);
  if (receipt.id !== follower.sessionId) throw new Error("Tideline returned a receipt for a different session.");
  const db = await followDatabase();
  if (!db) return;
  try {
    const afterLine = events.at(-1)?.line ?? follower.afterLine;
    db.prepare("UPDATE followers SET value = ? WHERE key = ? AND value = ?")
      .run(JSON.stringify({ ...follower, afterLine }), key(follower), JSON.stringify(follower));
  } finally {
    db.close();
  }
}

export async function syncReportFollowers({ source, sessionId, signal, manual }: { source?: unknown; sessionId?: string; signal?: AbortSignal; manual?: boolean } = {}) {
  const kind = sourceSchema.safeParse(source).data;
  if (source !== undefined && (!kind || !sessionId || !z.uuid().safeParse(sessionId).success)) return;
  const followers = await readFollowers(kind, sessionId?.toLowerCase());
  for (const follower of followers) {
    if (signal?.aborted) return;
    await syncFollower(follower, signal).catch((error: unknown) => {
      if (manual) throw error;
      if (error instanceof CliLoginRequired || signal?.aborted) return;
      // An interrupted or conflicting upload can be retried after the next complete turn.
      if (kind) console.warn("A report follow-up could not sync.");
    });
  }
  if (manual) console.info(followers.length ? "Report follow-up sync complete." : "No sessions are approved for report follow-up.");
}
