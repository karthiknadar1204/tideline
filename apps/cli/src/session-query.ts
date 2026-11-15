import { spawn } from "node:child_process";
import { link, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import { cliSessionExport, githubActivityRows } from "@tideline/contracts";
import type { CliSessionExport, GitHubActivityRows } from "@tideline/contracts";
import { z } from "zod";
import { sessionAgentMessages, sessionAgentRuns, sessionCommits, sessionFileChanges, sessionPrompts, sessionSetupFields, toolCalls } from "./session-tables";

const requestLimit = 16 * 1024 * 1024;
const resultLimit = 8 * 1024 * 1024;
const maximumRows = 10_000;
const queryTimeoutMs = 5_000;

const workerRequest = z.strictObject({
  query: z.string().min(1).max(16_384),
  sessions: z.array(cliSessionExport),
  github: githubActivityRows,
});
const valueSchema = z.union([z.string(), z.number(), z.null()]);
const workerResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("result"), columns: z.array(z.string()), rows: z.array(z.record(z.string(), valueSchema)).max(maximumRows) }),
  z.strictObject({ kind: z.literal("error"), message: z.string().max(400) }),
]);
type QueryResult = Extract<z.infer<typeof workerResult>, { kind: "result" }>;

const sqlTrivia = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)*/u;
const sqlToken = /(?:--[^\n]*(?:\n|$)|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[\p{L}\p{N}_$]+|[^\s]/gu;
const blockedFunctions = new Set(["load_extension", "readfile", "writefile", "zipfile", "randomblob", "zeroblob", "printf", "format"]);

function sqlQuery(input: string) {
  if (input.length > 16_384 || input.includes("\0")) throw new Error("SQL must be a single query of at most 16,384 characters.");
  const query = input.replace(sqlTrivia, "");
  if (!/^(?:SELECT|WITH)\b/i.test(query)) throw new Error("Supply one read-only SELECT or WITH query.");
  const tokens = (query.match(sqlToken) ?? []).filter((token) => !token.startsWith("--") && !token.startsWith("/*"));
  for (const [index, token] of tokens.entries()) {
    const name = token.replace(/^["'`\[]|["'`\]]$/g, "").toLowerCase();
    const call = tokens[index + 1] === "(";
    if (call && (blockedFunctions.has(name) || name.startsWith("pragma_"))) {
      throw new Error("SQL can query session data using read-only SQLite functions.");
    }
  }
  return query;
}

function conventionalJson(value: SQLOutputValue) {
  if (typeof value === "bigint") {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function sqlError(error: unknown) {
  if (error instanceof Error && /no such (?:table|column)|ambiguous column|syntax error|incomplete input/i.test(error.message)) {
    return new Error("SQLite could not parse the query or resolve a table or column. See tideline sql --help for the table names.");
  }
  return new Error("SQLite could not execute this read-only query. Try a smaller result or a narrower session filter.");
}

async function executeSql({ query, sessions, github }: z.infer<typeof workerRequest>): Promise<QueryResult> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:", { allowExtension: false, enableDoubleQuotedStringLiterals: false });
  try {
    db.exec(`
      PRAGMA hard_heap_limit = 100663296;
      PRAGMA temp_store = MEMORY;
      PRAGMA trusted_schema = OFF;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT, source_session_id TEXT, started_at TEXT, title TEXT,
        repository TEXT, repository_key TEXT, message_count INTEGER, token_coverage TEXT,
        tools INTEGER, skills INTEGER, children INTEGER
      );
      CREATE TABLE messages (
        session_id TEXT, line INTEGER, timestamp TEXT, role TEXT, text TEXT,
        PRIMARY KEY (session_id, line)
      );
      CREATE TABLE models (
        session_id TEXT, model TEXT, input_tokens INTEGER, cached_input_tokens INTEGER,
        cache_write_5m_tokens INTEGER, cache_write_1h_tokens INTEGER, cache_write_unknown_tokens INTEGER,
        output_tokens INTEGER, estimated_cost_usd REAL
      );
      CREATE TABLE activity (session_id TEXT, kind TEXT, name TEXT, status TEXT, line INTEGER, item_index INTEGER);
      CREATE TABLE commits (session_id TEXT, sha TEXT, line INTEGER, url TEXT);
      CREATE TABLE safety_findings (session_id TEXT, rule TEXT, line INTEGER);
      CREATE TABLE calls (session_id TEXT, line INTEGER, item_index INTEGER, name TEXT, status TEXT, mcp_server TEXT, input TEXT, output TEXT, truncated INTEGER);
      CREATE TABLE prompts (session_id TEXT, line INTEGER, timestamp TEXT, text TEXT);
      CREATE TABLE agent_runs (session_id TEXT, line INTEGER, item_index INTEGER, name TEXT, status TEXT);
      CREATE TABLE agent_messages (session_id TEXT, line INTEGER, item_index INTEGER, agent_id TEXT, child_line INTEGER, timestamp TEXT, role TEXT, text TEXT);
      CREATE TABLE file_changes (session_id TEXT, line INTEGER, item_index INTEGER, path TEXT, previous_path TEXT, change TEXT, diff TEXT, truncated INTEGER);
      CREATE TABLE session_setup (session_id TEXT, key TEXT, value TEXT);
      CREATE TABLE github_activity (repository TEXT, kind TEXT, id TEXT, title TEXT, timestamp TEXT, status TEXT);
      BEGIN;
    `);
    const insertSession = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertMessage = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?)");
    const insertModel = db.prepare("INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertActivity = db.prepare("INSERT INTO activity VALUES (?, ?, ?, ?, ?, ?)");
    const insertCommit = db.prepare("INSERT INTO commits VALUES (?, ?, ?, ?)");
    const insertFinding = db.prepare("INSERT INTO safety_findings VALUES (?, ?, ?)");
    const insertCall = db.prepare("INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertPrompt = db.prepare("INSERT INTO prompts VALUES (?, ?, ?, ?)");
    const insertRun = db.prepare("INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?)");
    const insertChildMessage = db.prepare("INSERT INTO agent_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertFileChange = db.prepare("INSERT INTO file_changes VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertSetup = db.prepare("INSERT INTO session_setup VALUES (?, ?, ?)");
    const insertGitHub = db.prepare("INSERT INTO github_activity VALUES (?, ?, ?, ?, ?, ?)");
    for (const session of sessions) {
      const { id, source, sourceSessionId, startedAt, title, analytics, activityCounts, activity, messageCount, messages, review } = session;
      insertSession.run(
        id, source, sourceSessionId, startedAt, title, analytics?.repository?.name ?? null, analytics?.repository?.key ?? null,
        messageCount, analytics?.tokenCoverage ?? null, activityCounts?.tools ?? null, activityCounts?.skills ?? null, activityCounts?.children ?? null,
      );
      for (const { line, timestamp, role, text } of messages) insertMessage.run(id, line, timestamp, role, text);
      for (const { model, tokens, estimatedCostUsd } of analytics?.models ?? []) {
        insertModel.run(id, model, tokens?.input ?? null, tokens?.cachedInput ?? null, tokens?.cacheWrite5m ?? null,
          tokens?.cacheWrite1h ?? null, tokens?.cacheWriteUnknown ?? null, tokens?.output ?? null, estimatedCostUsd);
      }
      for (const [kind, items] of Object.entries(activity ?? {})) {
        if (typeof items === "boolean") continue;
        for (const { name, status, line, index } of items) insertActivity.run(id, kind, name, status, line, index);
      }
      for (const { sha, line, url } of sessionCommits(session)) insertCommit.run(id, sha, line, url);
      for (const { rule, line } of review?.findings ?? []) insertFinding.run(id, rule, line);
      for (const row of toolCalls(session)) {
        insertCall.run(id, row.line, row.item_index, row.name, row.status, row.mcp_server, row.input, row.output, row.truncated);
      }
      for (const row of sessionPrompts(session)) insertPrompt.run(id, row.line, row.timestamp, row.text);
      for (const row of sessionAgentRuns(session)) insertRun.run(id, row.line, row.item_index, row.name, row.status);
      for (const row of sessionAgentMessages(session)) {
        insertChildMessage.run(id, row.line, row.item_index, row.agent_id, row.child_line, row.timestamp, row.role, row.text);
      }
      for (const row of sessionFileChanges(session)) {
        insertFileChange.run(id, row.line, row.item_index, row.path, row.previous_path, row.change, row.diff, row.truncated);
      }
      for (const row of sessionSetupFields(session)) insertSetup.run(id, row.key, row.value);
    }
    for (const { repository, event } of github) insertGitHub.run(repository, event.kind, event.id, event.title, event.at, event.status);
    db.exec("COMMIT; PRAGMA query_only = ON;");

    let statement: ReturnType<typeof db.prepare>;
    try {
      const source = db.prepare(query).sourceSQL;
      if (query.slice(source.length).replace(sqlTrivia, "") !== "") {
        throw new Error("Multiple statements");
      }
      const select = source.replace(/;\s*$/, "");
      statement = db.prepare(`SELECT * FROM (\n${select}\n) LIMIT ${maximumRows + 1}`);
      const plan = db.prepare(`EXPLAIN ${statement.sourceSQL}`);
      if (plan.all().some(({ opcode }) => opcode === "VOpen")) {
        throw new Error("SQLite virtual tables");
      }
      statement.setReadBigInts(true);
    } catch (error) {
      if (error instanceof Error && error.message === "Multiple statements") {
        throw new Error("Supply one SQL statement at a time.");
      }
      if (error instanceof Error && error.message === "SQLite virtual tables") {
        throw new Error("SQLite virtual tables are unavailable. Query the Tideline session tables.");
      }
      throw sqlError(error);
    }

    const columns = statement.columns().map(({ name }) => name);
    const rows: QueryResult["rows"] = [];
    let bytes = Buffer.byteLength(JSON.stringify(columns));
    try {
      for (const entry of statement.iterate()) {
        const row = Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, conventionalJson(value)]));
        bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        rows.push(row);
        if (rows.length > maximumRows || bytes > resultLimit) break;
      }
    } catch (error) {
      throw sqlError(error);
    }
    if (rows.length > maximumRows || bytes > resultLimit) {
      throw new Error("SQL result reached the export limit. Add a narrower WHERE clause or a smaller LIMIT.");
    }
    return { kind: "result", columns, rows };
  } finally {
    db.close();
  }
}

async function readWorkerInput() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > requestLimit) throw new Error("SQL input exceeds the local snapshot limit.");
    chunks.push(buffer);
  }
  return workerRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export async function runSqlWorker() {
  try {
    const input = await readWorkerInput();
    const result = await executeSql({ ...input, query: sqlQuery(input.query) });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error && !(error instanceof SyntaxError || error instanceof z.ZodError) &&
      !("code" in error && error.code === "ERR_SQLITE_ERROR")
      ? error.message.slice(0, 400) : "Could not read the local SQL snapshot.";
    process.stdout.write(JSON.stringify({ kind: "error", message }));
  }
}

async function runWorker(input: string) {
  const entry = process.argv[1];
  if (!entry) throw new Error("Run SQL through the Tideline CLI.");
  return new Promise<QueryResult>((resolveQuery, reject) => {
    const child = spawn(process.execPath, [resolve(entry), "__query"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("SQL ran out of time. Add a narrower WHERE clause or a smaller LIMIT."));
    }, queryTimeoutMs);
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("Could not start the local SQL worker."));
    });
    child.stdin.on("error", () => child.kill());
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (resultLimit + 65_536)) {
        child.kill("SIGKILL");
        reject(new Error("SQL result exceeds the export size limit."));
      } else {
        chunks.push(chunk);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error("The local SQL worker exited before finishing."));
        return;
      }
      try {
        const result = workerResult.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (result.kind === "error") reject(new Error(result.message));
        else resolveQuery(result);
      } catch {
        reject(new Error("The local SQL worker returned an invalid result."));
      }
    });
    child.stdin.end(input);
  });
}

export async function queryLocalSessions(query: string, sessions: AsyncIterable<CliSessionExport>, output: string | undefined, github: GitHubActivityRows) {
  const parsedQuery = sqlQuery(query);
  if (output !== undefined && ![".jsonl", ".csv"].includes(extname(output))) {
    throw new Error("SQL output must end in .jsonl or .csv.");
  }
  const prefix = `{"query":${JSON.stringify(parsedQuery)},"github":${JSON.stringify(github)},"sessions":[`;
  const documents: string[] = [];
  let bytes = Buffer.byteLength(prefix) + 2;
  for await (const session of sessions) {
    const document = JSON.stringify(session);
    bytes += Buffer.byteLength(document) + 1;
    if (bytes > requestLimit) throw new Error("SQL input exceeds the local snapshot limit. Narrow the repository or date range.");
    documents.push(document);
  }
  return runWorker(prefix + documents.join(",") + "]}");
}

function csvValue(value: string | number | null | undefined) {
  const text = String(value ?? "");
  const safe = typeof value === "string" && /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function writeQueryResults({ columns, rows }: QueryResult, output?: string) {
  const csv = output !== undefined && extname(output) === ".csv";
  const lines = csv ? [
    columns.map(csvValue).join(","),
    ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(",")),
  ] : rows.map((row) => JSON.stringify(row));
  const data = lines.length ? lines.join("\n") + "\n" : "";
  if (!output) {
    process.stdout.write(data);
    return;
  }
  const target = resolve(output);
  const directory = await realpath(dirname(target));
  const staging = await mkdtemp(join(directory, ".tideline-sql-"));
  try {
    const partial = join(staging, "result");
    await writeFile(partial, data, { flag: "wx", mode: 0o600 });
    await link(partial, join(directory, basename(target))).catch((error) => {
      if (error?.code === "EEXIST") throw new Error("The SQL output already exists. Choose a new file.");
      throw error;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
