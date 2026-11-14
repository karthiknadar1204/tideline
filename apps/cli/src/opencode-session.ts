import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { MAX_CODEX_IMPORT_BYTES, MAX_CODEX_IMPORT_EVENTS, modelTokens } from "@tideline/contracts";
import { z } from "zod";
import { createProjectScope, sourceSessionUuid } from "./session-jsonl";
import type { LiveReadOptions, LiveSession, SessionCandidate, SessionProjection } from "./session-jsonl";
import { createSessionSafety } from "./session-safety";
import { createModelUsage, readModelId } from "./session-usage";

const rawRecordLimit = MAX_CODEX_IMPORT_BYTES;
const eventByteLimit = 768 * 1024;
const messageLimit = 2_000;
const partLimit = 500;
const sessionPageSize = 100;
const nativeSessionId = z.string().regex(/^ses_[A-Za-z0-9_-]{1,196}$/);
const timestamp = z.int().min(0).max(253_402_300_799_999);
const messageData = z.object({
  role: z.unknown().optional(),
  time: z.object({ completed: timestamp.optional() }).optional(),
  summary: z.unknown().optional(),
  text: z.string().optional(),
  content: z.array(z.unknown()).optional(),
  modelID: z.unknown().optional(),
  model: z.object({ id: z.unknown() }).optional().catch(undefined),
  tokens: z.unknown().optional(),
});
const textPart = z.object({
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
});
const count = z.int().nonnegative();
const tokenUsage = z.object({
  input: count,
  output: count,
  reasoning: count,
  cache: z.object({ read: count, write: count }),
});

function readUsage(value: unknown) {
  const tokens = tokenUsage.safeParse(value).data;
  if (!tokens) return null;
  return modelTokens.safeParse({
    input: tokens.input,
    cachedInput: tokens.cache.read,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteUnknown: tokens.cache.write,
    output: tokens.output + tokens.reasoning,
  }).data ?? null;
}

function decode(value: unknown): unknown {
  if (typeof value !== "string") return;
  try {
    return JSON.parse(value);
  } catch {
    return;
  }
}

function sessionIndex(db: DatabaseSync) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(({ name }) => name));
  const v2 = tables.has("session_v2") && tables.has("session_message");
  if (!v2 && !(tables.has("session") && tables.has("message") && tables.has("part"))) return;
  const sessionTable = v2 ? "session_v2" : "session";
  const fields = new Set(db.prepare(`PRAGMA table_info(${sessionTable})`).all().map(({ name }) => name));
  const selection = `SELECT id, directory, time_created FROM ${sessionTable} WHERE parent_id IS NULL
    AND typeof(id) = 'text' AND typeof(directory) = 'text' AND typeof(time_created) = 'integer'
    ${fields.has("fork_session_id") ? "AND fork_session_id IS NULL" : ""}
    ${fields.has("workspace_id") ? "AND workspace_id IS NULL" : ""}`;

  return {
    v2,
    tables,
    sessions: db.prepare(`${selection} AND time_created >= ? AND id > ? ORDER BY id LIMIT ${sessionPageSize}`),
    session: db.prepare(`${selection} AND id = ? AND directory = ? AND time_created = ?`),
    moved: v2 ? db.prepare("SELECT 1 FROM session_message WHERE session_id = ? AND type = 'location-switched' LIMIT 1") : undefined,
  };
}

function conversationStatements(db: DatabaseSync, index: NonNullable<ReturnType<typeof sessionIndex>>) {
  const { v2, tables } = index;
  return {
    ...index,
    latestAssistant: v2 ? db.prepare("SELECT seq FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1") : undefined,
    messages: v2 ? db.prepare(`SELECT id, type, seq, time_created,
        CASE WHEN length(CAST(data AS BLOB)) <= ${rawRecordLimit} THEN data END AS data
      FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant')
      ORDER BY seq, id LIMIT ${messageLimit}`) : db.prepare(`SELECT id, time_created,
        CASE WHEN length(CAST(data AS BLOB)) <= ${rawRecordLimit} THEN data END AS data
      FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT ${messageLimit}`),
    parts: v2 ? tables.has("session_part") ? db.prepare(`SELECT type,
        CASE WHEN length(CAST(data AS BLOB)) <= ${rawRecordLimit} THEN data END AS data
      FROM session_part WHERE session_id = ? AND message_id = ? AND type = 'text'
      ORDER BY ordinal LIMIT ${partLimit}`) : undefined : db.prepare(`SELECT
        CASE WHEN length(CAST(data AS BLOB)) <= ${rawRecordLimit} THEN data END AS data
      FROM part WHERE session_id = ? AND message_id = ? ORDER BY id LIMIT ${partLimit}`),
  };
}

function* readParts(statement: StatementSync | undefined, sessionId: string, messageId: string): Generator<unknown> {
  if (!statement) return;
  for (const row of statement.iterate(sessionId, messageId)) {
    const data = decode(row.data);
    yield row.type === "text" && typeof data === "object" && data !== null ? { ...data, type: "text" } : data;
  }
}

function displayText(value: string) {
  return value.replace(/\0|[\uD800-\uDFFF]/gu, "").trim().slice(0, 32_000).replace(/[\uD800-\uDFFF]$/u, "");
}

function collectText(stored: Iterable<unknown>, inline: unknown[] | undefined) {
  let text = "";
  let hasParts = false;
  function append(item: unknown) {
    hasParts = true;
    const part = textPart.safeParse(item).data;
    if (!part || part.synthetic || part.ignored) return;
    text += `${text ? "\n" : ""}${part.text.slice(0, 32_001)}`;
  }
  for (const item of stored) {
    append(item);
    if (text.length > 32_000) break;
  }
  for (const item of inline ?? []) {
    if (text.length > 32_000) break;
    append(item);
  }
  return { text: displayText(text), hasParts };
}

function projectSession(
  db: DatabaseSync,
  statements: ReturnType<typeof conversationStatements>,
  id: string,
  directory: string,
  projectDirectory: string,
  created: number,
): LiveSession | undefined {
  db.exec("BEGIN");
  try {
    if (!statements.session.get(id, directory, created) || statements.moved?.get(id)) return;
    const latestAssistant = statements.latestAssistant?.get(id)?.seq;
    const events: SessionProjection["events"] = [];
    const usage = createModelUsage();
    let bytes = 0;
    let line = 0;
    let throughLine = 0;
    let legacyStableEventCount = 0;
    let legacyStableLine = 0;
    let waitingForAssistant = false;

    for (const row of statements.messages.iterate(id)) {
      line++;
      const at = timestamp.safeParse(row.time_created).data;
      const data = messageData.safeParse(decode(row.data)).data;
      if (at === undefined || !data || typeof row.id !== "string") break;
      const role = statements.v2 ? row.type : data.role;
      if (role !== "user" && role !== "assistant") continue;
      if (role === "assistant" && data.summary === true) continue;
      if (role === "assistant" && data.time?.completed === undefined) {
        // A newer OpenCode V2 step supersedes an unfinished assistant message.
        if (typeof row.seq === "number" && typeof latestAssistant === "number" && row.seq < latestAssistant) {
          usage.markIncomplete();
          continue;
        }
        break;
      }

      const { text, hasParts } = statements.v2 && role === "user"
        ? { text: displayText(data.text ?? ""), hasParts: true }
        : collectText(readParts(statements.parts, id, row.id), statements.v2 ? data.content : undefined);
      if (!statements.v2 && role === "user" && !hasParts) break;

      if (text) {
        const event: SessionProjection["events"][number] = { role, text, line, timestamp: new Date(at).toISOString() };
        bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
        if (bytes > eventByteLimit || events.length === MAX_CODEX_IMPORT_EVENTS) break;
        events.push(event);
        throughLine = line;
        if (role === "user") waitingForAssistant = true;
      }
      if (role === "assistant") {
        const model = readModelId(statements.v2 ? data.model?.id : data.modelID);
        const tokens = readUsage(data.tokens);
        usage.add(model, tokens);
        if (!tokens) usage.markIncomplete();
        waitingForAssistant = false;
        throughLine = line;
        legacyStableEventCount = events.length;
        legacyStableLine = line;
      }
    }

    // Legacy prompts can gain text parts until the first assistant response has completed.
    if (!statements.v2) {
      events.length = legacyStableEventCount;
      throughLine = legacyStableLine;
    }
    if (!events.length) return;
    if (statements.v2 && waitingForAssistant) usage.markIncomplete();
    const safety = createSessionSafety();
    for (const event of events) safety.scanCredential(event.text, event.line);
    return {
      projectDirectory,
      session: {
        source: "opencode",
        sourceSessionId: sourceSessionUuid("opencode", id),
        startedAt: new Date(created).toISOString(),
        events,
        analytics: usage.snapshot(throughLine),
      },
      evidence: safety.snapshot(throughLine),
    };
  } finally {
    db.exec("ROLLBACK");
  }
}

export async function openCodeDatabaseFiles(root: string) {
  const entry = await lstat(root);
  if (await realpath(root) !== root) return [];
  if (entry.isFile()) return [root];
  if (!entry.isDirectory()) return [];
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((candidate) => candidate.isFile() && /^opencode(?:-[A-Za-z0-9._-]+)?\.db$/.test(candidate.name))
    .map(({ name }) => name);
  return names.sort().map((name) => join(root, name));
}

export function discoverOpenCodeSessions(root: string): AsyncGenerator<SessionCandidate> {
  return scanOpenCodeSessions(root);
}

export function readOpenCodeSessions(root: string, options: LiveReadOptions): AsyncGenerator<LiveSession> {
  return scanOpenCodeSessions(root, options);
}

function scanOpenCodeSessions(root: string): AsyncGenerator<SessionCandidate>;
function scanOpenCodeSessions(root: string, options: LiveReadOptions): AsyncGenerator<LiveSession>;
async function* scanOpenCodeSessions(root: string, options?: LiveReadOptions): AsyncGenerator<SessionCandidate | LiveSession> {
  if (options && !options.projectScope &&
    (!options.projectDirectory || await realpath(options.projectDirectory).catch(() => undefined) !== options.projectDirectory)) return;
  const { DatabaseSync } = await import("node:sqlite");
  const projectScope = options?.projectScope ?? createProjectScope(options?.projectDirectory);
  const yielded = new Set<string>();
  for (const path of await openCodeDatabaseFiles(root)) {
    if (!(await lstat(path)).isFile() || await realpath(path) !== path) continue;
    const sidecars = await Promise.all(["-wal", "-shm", "-journal"].map((suffix) => lstat(path + suffix).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    })));
    if (sidecars.some((sidecar) => sidecar && !sidecar.isFile())) continue;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 250");
      const index = sessionIndex(db);
      if (!index) continue;
      const statements = options && conversationStatements(db, index);
      let after = "";
      for (;;) {
        const page = index.sessions.all(options?.since ?? 0, after);
        if (!page.length) break;
        for (const row of page) {
          if (typeof row.id !== "string") continue;
          after = row.id;
          const id = nativeSessionId.safeParse(row.id).data;
          const created = timestamp.safeParse(row.time_created).data;
          if (!id || yielded.has(id) || typeof row.directory !== "string" || created === undefined) continue;
          const projectDirectory = await projectScope(row.directory);
          if (!projectDirectory) continue;
          const candidate: SessionCandidate = {
            source: "opencode", sourceSessionId: sourceSessionUuid("opencode", id), startedAt: new Date(created).toISOString(), projectDirectory,
          };
          if (!statements) {
            if (index.moved?.get(id)) continue;
            yielded.add(id);
            yield candidate;
            continue;
          }
          if (options?.sessionAllowed?.(candidate) === false) continue;
          const session = projectSession(db, statements, id, row.directory, projectDirectory, created);
          if (!session) continue;
          yielded.add(id);
          yield session;
        }
        if (page.length < sessionPageSize || after === "") break;
      }
    } finally {
      db.close();
    }
  }
}
