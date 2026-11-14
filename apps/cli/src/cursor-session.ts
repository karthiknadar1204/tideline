import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { MAX_CODEX_IMPORT_BYTES, MAX_CODEX_IMPORT_EVENTS } from "@tideline/contracts";
import { z } from "zod";
import { createProjectScope, sourceSessionUuid } from "./session-jsonl";
import type { LiveReadOptions, LiveSession, SessionProjection } from "./session-jsonl";
import { createSessionSafety } from "./session-safety";
import { createModelUsage, readModelId } from "./session-usage";

const cursorId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const time = z.union([z.number().positive(), z.iso.datetime({ offset: true })]);
const workspaceUri = z.union([z.string(), z.object({
  scheme: z.string().optional(), authority: z.string().optional(), fsPath: z.string().optional(),
  path: z.string().optional(), external: z.string().optional(),
})]);
const workspaceIdentifier = z.object({ id: z.string().optional(), uri: workspaceUri.optional() });
const composerDetails = z.object({
  composerId: cursorId.optional(), createdAt: time.optional(), workspaceIdentifier: workspaceIdentifier.optional(),
  isSubagent: z.boolean().optional(), isBestOfNSubcomposer: z.boolean().optional(),
  subagentInfo: z.object({
    parentComposerId: z.string().optional(), forkedFromComposerId: z.string().optional(), parentRequestId: z.string().optional(),
  }).nullish(),
  agentLocationHistory: z.array(z.object({ reason: z.string().optional() })).optional(),
});
const composer = composerDetails.extend({
  status: z.string().optional(),
  generatingBubbleIds: z.array(z.string()).optional(),
  fullConversationHeadersOnly: z.array(z.unknown()),
  conversationMap: z.record(z.string(), z.unknown()).optional(),
});
const composerList = z.object({ allComposers: z.array(z.unknown()).max(25_000) });
const composerHeader = composerDetails.extend({ composerId: cursorId });
const headerRow = z.object({
  composerId: cursorId, workspaceId: z.string().nullish(), createdAt: time.nullish(),
  isSubagent: z.union([z.boolean(), z.number()]).nullish(), value: z.unknown(),
});
const bubbleFlags = z.object({ isDisplayOnly: z.boolean().optional(), isSimulatedMsg: z.boolean().optional() });
const bubbleReference = bubbleFlags.extend({ bubbleId: cursorId, type: z.union([z.number(), z.string()]).optional() });
const bubble = bubbleFlags.extend({
  bubbleId: cursorId.optional(), type: z.union([z.number(), z.string()]).optional(), text: z.string().optional(),
  createdAt: time.optional(), modelInfo: z.object({ modelName: z.unknown().optional() }).optional(),
  isStreaming: z.boolean().optional(), toolFormerData: z.unknown().optional(),
});
const workspaceFile = z.object({ folder: z.string() });
const MAX_CURSOR_INDEX_BYTES = 16 * MAX_CODEX_IMPORT_BYTES;

type Metadata = z.infer<typeof composerDetails>;
type Membership = { details?: Metadata; workspaceId?: string | null; folder?: string; createdAt?: z.infer<typeof time> | null; subagent?: boolean };

function json(value: unknown): unknown {
  try {
    if (value instanceof Uint8Array) return JSON.parse(Buffer.from(value).toString("utf8"));
    return typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

function localPath(uri: z.infer<typeof workspaceUri>): string | undefined {
  if (typeof uri !== "string") {
    if (uri.scheme !== "file" || uri.authority) return;
    const path = uri.fsPath ?? uri.path;
    if (uri.external) {
      const external = localPath(uri.external);
      if (path && (!external || normalize(path) !== normalize(external))) return;
      return external;
    }
    return path && isAbsolute(path) ? path : undefined;
  }
  const url = URL.parse(uri);
  if (!url || url.protocol !== "file:" || url.hostname || url.search || url.hash) return;
  try { return fileURLToPath(url); } catch { return undefined; }
}

function timestamp(value: z.infer<typeof time> | null | undefined) {
  if (value == null) return;
  const milliseconds = typeof value === "string" ? Date.parse(value) : value < 10_000_000_000 ? value * 1_000 : value;
  return milliseconds >= 0 && milliseconds < 253_402_300_800_000 ? milliseconds : undefined;
}

function unsupportedOrigin(metadata: Metadata | undefined) {
  const info = metadata?.subagentInfo;
  return metadata?.isSubagent || metadata?.isBestOfNSubcomposer || info?.parentComposerId || info?.forkedFromComposerId ||
    info?.parentRequestId || metadata?.agentLocationHistory?.some(({ reason }) => reason === "moved");
}

async function regularFile(path: string) {
  return await realpath(path).catch(() => undefined) === path && await lstat(path).then((entry) => entry.isFile(), () => false);
}

async function inputDatabase(path: string) {
  if (!await regularFile(path)) return;
  const sidecars = await Promise.all(["-wal", "-shm", "-journal"].map((suffix) => lstat(path + suffix).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  })));
  if (sidecars.some((sidecar) => sidecar && !sidecar.isFile())) return;
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path, { readOnly: true, enableDoubleQuotedStringLiterals: false });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 250;");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function valueReader(database: DatabaseSync, table: "ItemTable" | "cursorDiskKV") {
  const statement = database.prepare(`SELECT value FROM ${table} WHERE key = ? AND length(CAST(value AS BLOB)) <= ?`);
  return (key: string, bytes: number) => json(statement.get(key, bytes)?.value);
}

function hasTable(database: DatabaseSync, name: string) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function listedComposers(database: DatabaseSync, key: string) {
  if (!hasTable(database, "ItemTable")) return [];
  const rows = composerList.safeParse(valueReader(database, "ItemTable")(key, MAX_CURSOR_INDEX_BYTES)).data?.allComposers ?? [];
  return rows.flatMap((row) => {
    const parsed = composerHeader.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

async function readWorkspaceFolders(root: string) {
  const workspaceStorage = join(root, "workspaceStorage");
  if (await realpath(workspaceStorage).catch(() => undefined) !== workspaceStorage) return new Map<string, string>();
  const entries = await readdir(workspaceStorage, { withFileTypes: true });
  const folders = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(workspaceStorage, entry.name, "workspace.json");
    if (!await regularFile(file) || !(await lstat(file).then((details) => details.size <= 16_384, () => false))) continue;
    const content = await readFile(file, "utf8").catch(() => undefined);
    const descriptor = workspaceFile.safeParse(json(content));
    const folder = descriptor.success ? localPath(descriptor.data.folder) : undefined;
    if (folder) folders.set(entry.name, folder);
  }
  return folders;
}

function globalMemberships(database: DatabaseSync, since?: number) {
  const headers = new Map<string, Membership[]>();
  if (hasTable(database, "composerHeaders")) {
    const minimum = since ?? 0;
    const rows = database.prepare(`SELECT composerId, workspaceId, createdAt, isSubagent,
      CASE WHEN length(CAST(value AS BLOB)) <= 65536 THEN value END AS value FROM composerHeaders
      WHERE typeof(createdAt) NOT IN ('integer', 'real') OR createdAt >= ? OR (createdAt < 10000000000 AND createdAt * 1000 >= ?)
      LIMIT 25001`).iterate(minimum, minimum);
    let count = 0;
    for (const row of rows) {
      if (++count > 25_000) throw new Error("The Cursor session index exceeds the supported limit.");
      const parsed = headerRow.safeParse(row);
      if (!parsed.success) continue;
      const { composerId, workspaceId, createdAt, isSubagent, value } = parsed.data;
      headers.set(composerId, [{ workspaceId, createdAt, subagent: Boolean(isSubagent), details: composerDetails.safeParse(json(value)).data }]);
    }
  }
  const legacyGlobal = new Map<string, Membership[]>();
  for (const details of listedComposers(database, "composer.composerHeaders")) {
    if (headers.has(details.composerId)) continue;
    const existing = legacyGlobal.get(details.composerId) ?? [];
    existing.push({ details });
    legacyGlobal.set(details.composerId, existing);
  }
  return new Map([...headers, ...legacyGlobal]);
}

async function workspaceMemberships(root: string, folders: Map<string, string>, memberships: Map<string, Membership[]>) {
  const legacyWorkspace = new Map<string, Membership[]>();
  for (const [key, folder] of folders) {
    const database = await inputDatabase(join(root, "workspaceStorage", key, "state.vscdb"));
    if (!database) continue;
    try {
      for (const index of ["composer.composerData", "composer.composerHeaders"]) {
        for (const details of listedComposers(database, index)) {
          if (memberships.has(details.composerId)) continue;
          const existing = legacyWorkspace.get(details.composerId) ?? [];
          existing.push({ folder, workspaceId: key, details });
          legacyWorkspace.set(details.composerId, existing);
        }
      }
    } finally {
      database.close();
    }
  }
  for (const [key, value] of legacyWorkspace) memberships.set(key, value);
}

async function scopedFolder(membership: Membership, folders: Map<string, string>, scope: ReturnType<typeof createProjectScope>) {
  const workspace = membership.details?.workspaceIdentifier;
  if (membership.workspaceId && workspace?.id && membership.workspaceId !== workspace.id) return;
  const candidates = [membership.folder, folders.get(membership.workspaceId ?? ""), folders.get(workspace?.id ?? "")];
  if (workspace?.uri) {
    const path = localPath(workspace.uri);
    if (!path) return;
    candidates.push(path);
  }
  const resolved = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const directory = await scope(candidate);
    if (!directory) return;
    resolved.add(directory);
  }
  return resolved.size === 1 ? resolved.values().next().value : undefined;
}

function role(type: z.infer<typeof bubble>["type"]): "user" | "assistant" | undefined {
  if (type === 1 || type === "user") return "user";
  if (type === 2 || type === "assistant") return "assistant";
}

function readConversation(readValue: ReturnType<typeof valueReader>, id: string, details: z.infer<typeof composer>, startedAt: number) {
  const projected: { event: SessionProjection["events"][number]; model: string | null }[] = [];
  const observed = new Set<string>();
  let bytes = 0;
  let stableCount = 0;
  const references = details.fullConversationHeadersOnly.slice(0, 2_000);
  const generating = new Set(details.generatingBubbleIds);
  for (const reference of references) {
    const header = bubbleReference.safeParse(reference).data;
    if (!header || observed.has(header.bubbleId)) break;
    observed.add(header.bubbleId);
    if (header.isDisplayOnly || header.isSimulatedMsg) continue;
    if (generating.has(header.bubbleId)) break;
    const embedded = details.conversationMap;
    const raw = readValue(`bubbleId:${id}:${header.bubbleId}`, MAX_CODEX_IMPORT_BYTES) ??
      (embedded && Object.hasOwn(embedded, header.bubbleId) ? embedded[header.bubbleId] : undefined);
    const item = bubble.safeParse(raw).data;
    if (!item || (item.bubbleId && item.bubbleId !== header.bubbleId)) break;
    if (item.isDisplayOnly || item.isSimulatedMsg) continue;
    if (item.isStreaming) break;
    const speaker = role(item.type ?? header.type);
    if (!speaker || item.toolFormerData != null || !item.text?.trim()) continue;
    const text = item.text.trim();
    if (text.length > 32_000 || text.includes("\0") || /[\uD800-\uDFFF]/u.test(text)) break;
    const event = { role: speaker, line: projected.length + 1, text, timestamp: new Date(timestamp(item.createdAt) ?? startedAt).toISOString() };
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
    if (bytes > MAX_CODEX_IMPORT_BYTES * 0.75 || projected.length === MAX_CODEX_IMPORT_EVENTS) break;
    projected.push({ event, model: speaker === "assistant" ? readModelId(item.modelInfo?.modelName) : null });
    if (speaker === "user") stableCount = projected.length;
  }
  // A new real prompt settles the previous reply, even while the current turn is still running.
  if (details.status !== "completed") projected.length = stableCount;
  if (!projected.length) return;
  const usage = createModelUsage();
  const safety = createSessionSafety();
  const events = projected.map(({ event, model }) => {
    usage.add(model, null);
    safety.scanCredential(event.text, event.line);
    return event;
  });
  const throughLine = events.length;
  return { events, analytics: usage.snapshot(throughLine), evidence: safety.snapshot(throughLine) };
}

export async function* readCursorSessions(root: string, options: LiveReadOptions): AsyncGenerator<LiveSession> {
  if (!options.projectDirectory || await realpath(options.projectDirectory).catch(() => undefined) !== options.projectDirectory) return;
  const physical = await realpath(root).catch(() => undefined);
  if (physical !== root) return;
  const database = await inputDatabase(join(root, "globalStorage", "state.vscdb"));
  if (!database) return;
  try {
    const scope = createProjectScope(options.projectDirectory);
    const folders = await readWorkspaceFolders(root);
    if (!hasTable(database, "cursorDiskKV")) return;
    const version = database.prepare("PRAGMA data_version");
    const indexVersion = version.get()?.data_version;
    const memberships = globalMemberships(database, options.since);
    await workspaceMemberships(root, folders, memberships);
    const readValue = valueReader(database, "cursorDiskKV");
    for (const [id, records] of memberships) {
      if (id.startsWith("task-") || records.some((entry) => entry.subagent || unsupportedOrigin(entry.details))) continue;
      const directories = await Promise.all(records.map((entry) => scopedFolder(entry, folders, scope)));
      const projectDirectory = directories[0];
      if (!projectDirectory || directories.some((directory) => directory !== projectDirectory)) continue;
      const indexStart = timestamp(records[0].createdAt ?? records[0].details?.createdAt);
      if (indexStart !== undefined && options.since !== undefined && indexStart < options.since) continue;
      let result: LiveSession | undefined;
      database.exec("BEGIN");
      try {
        // If Cursor rewrote its global index, rediscover membership on the next poll.
        if (version.get()?.data_version !== indexVersion) return;
        const details = composer.safeParse(readValue(`composerData:${id}`, MAX_CODEX_IMPORT_BYTES)).data;
        if (!details || (details.composerId && details.composerId !== id) || unsupportedOrigin(details)) continue;
        const workspace = details.workspaceIdentifier;
        if (workspace?.uri || (workspace?.id && folders.has(workspace.id))) {
          if (await scopedFolder({ details }, folders, scope) !== projectDirectory) continue;
        } else if (workspace?.id && !records.some(({ workspaceId, details: item }) => workspace.id === (workspaceId ?? item?.workspaceIdentifier?.id))) {
          continue;
        }
        const startedAt = indexStart ?? timestamp(details.createdAt);
        if (startedAt === undefined || (options.since !== undefined && startedAt < options.since)) continue;
        const conversation = readConversation(readValue, id, details, startedAt);
        if (conversation) {
          const { evidence, ...snapshot } = conversation;
          result = { projectDirectory, evidence, session: {
            source: "cursor", sourceSessionId: sourceSessionUuid("cursor", id), startedAt: new Date(startedAt).toISOString(), ...snapshot,
          } };
        }
      } finally {
        database.exec("ROLLBACK");
      }
      if (result) yield result;
    }
  } finally {
    database.close();
  }
}
