import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Script } from "node:vm";
import {
  cliSessionExport, cliSessionFilters, cliSessionPageResponse, githubActivityResponse, githubActivityRows, MAX_CODEX_IMPORT_BYTES, MAX_SESSION_CAPTURE_BYTES, MAX_SESSION_SUBAGENT_BYTES,
  sessionDetailResponse, workspaceResponse, workspaceSessionDetailResponse,
} from "@tideline/contracts";
import type { CliSessionExport } from "@tideline/contracts";
import { transcriptPage, transcriptStreams } from "@tideline/contracts/transcripts";
import { z } from "zod";
import { openCliAccount } from "./cli-account";
import { queryLocalSessions, writeQueryResults } from "./session-query";
import { sessionAgentMessages, sessionAgentRuns, sessionCommits, sessionFileChanges, sessionPrompts, sessionSetupFields, toolCalls } from "./session-tables";

export { runSqlWorker } from "./session-query";

type Filters = z.infer<typeof cliSessionFilters>;
export type SessionCommandOptions = {
  workspace?: string;
  repo?: string;
  source?: string;
  from?: string;
  to?: string;
  json?: boolean;
  details?: boolean;
  github?: boolean;
  transcripts?: boolean;
};

const manifestSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: workspaceResponse.shape.id,
  createdAt: z.iso.datetime(),
  sessionCount: z.int().nonnegative(),
  github: z.literal(true).optional(),
  filters: cliSessionFilters,
});
const sessionHeader = cliSessionExport.omit({ messages: true });
const unitSchema = z.enum(["message", "session", "call", "prompt"]);
const fieldSchema = z.enum(["all", "user", "assistant", "tool", "tool-input", "tool-output"]);
const maximumSessionBytes = MAX_CODEX_IMPORT_BYTES * 2 + MAX_SESSION_CAPTURE_BYTES + MAX_SESSION_SUBAGENT_BYTES;
const preciseTables = [
  ["calls", toolCalls], ["prompts", sessionPrompts], ["agent_runs", sessionAgentRuns], ["agent_messages", sessionAgentMessages], ["commits", sessionCommits],
  ["file_changes", sessionFileChanges], ["session_setup", sessionSetupFields],
] as const;

function filtersFrom({ repo, source, from, to }: SessionCommandOptions) {
  const parsed = cliSessionFilters.safeParse({ repo, source, from, to });
  if (!parsed.success) {
    throw new Error("Use a repository name, a supported agent for --source, and an ordered UTC date range in YYYY-MM-DD format.");
  }
  return parsed.data;
}

type Account = Awaited<ReturnType<typeof openCliAccount>>;

async function remoteGitHubRows(account: Account, { repo, from, to }: Filters) {
  const query = new URLSearchParams();
  if (repo) query.set("repoName", repo);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const path = `/v1/cli/workspaces/${account.workspaceId}/github-activity`;
  const { events, hasMore } = await account.get(query.size ? `${path}?${query}` : path, githubActivityResponse);
  if (hasMore) throw new Error("Narrow the repository or date range to include up to 1,000 GitHub events per export.");
  return events;
}

async function pullTranscript(account: Account, sessionId: string, directory: string) {
  const path = `/v1/cli/workspaces/${account.workspaceId}/sessions/${sessionId}/transcript`;
  const { streams } = await account.get(`${path}/streams`, transcriptStreams);
  if (!streams.length) return;
  const root = join(directory, sessionId);
  await mkdir(root, { mode: 0o700 });
  const saved = new Set<string>();
  for (const stream of streams) {
    const read = (after: number) => account.get(`${path}?${new URLSearchParams({ stream, after: String(after) })}`, transcriptPage);
    let page = await read(0);
    const end = page.total;
    const log = join(root, stream === "main" ? "transcript.jsonl" : `agent-${stream}.jsonl`);
    await writeFile(log, "", { mode: 0o600, flag: "wx" });
    for (;;) {
      const rows = page.records.filter(({ line }) => line <= end);
      await appendFile(log, rows.map(({ text }) => text + "\n").join(""));
      for (const attachment of rows.flatMap(({ attachments }) => attachments)) {
        if (saved.has(attachment.digest)) continue;
        const bytes = await account.download(`${path}/attachments/${attachment.digest}`, attachment.bytes);
        if (bytes.length !== attachment.bytes || createHash("sha256").update(bytes).digest("hex") !== attachment.digest) {
          throw new Error("A transcript attachment differed from its recorded digest.");
        }
        await writeFile(join(root, `${attachment.digest}.${attachment.mime.split("/")[1]}`), bytes, { mode: 0o600, flag: "wx" });
        saved.add(attachment.digest);
      }
      if (page.after === null || page.after >= end) break;
      page = await read(page.after);
    }
  }
}

async function* remoteSummaries(account: Account, filters: Filters) {
  const route = `/v1/cli/workspaces/${account.workspaceId}/sessions`;
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined) parameters.set(key, value);
  const cursors = new Set<string>();
  for (;;) {
    const search = parameters.toString();
    const page = await account.get(search ? `${route}?${search}` : route, cliSessionPageResponse);
    yield* page.sessions;
    if (!page.nextCursor) return;
    if (cursors.has(page.nextCursor)) throw new Error("Tideline returned a repeated session cursor.");
    cursors.add(page.nextCursor);
    parameters.set("after", page.nextCursor);
  }
}

async function* remoteDetails(account: Account, filters: Filters, includeDetails = false): AsyncGenerator<CliSessionExport> {
  for await (const summary of remoteSummaries(account, filters)) {
    const session = await account.get(
      `/v1/cli/workspaces/${account.workspaceId}/sessions/${summary.id}${includeDetails ? "?details=1" : ""}`,
      includeDetails ? workspaceSessionDetailResponse : sessionDetailResponse,
    );
    if (session.id !== summary.id || session.messageCount !== session.messages.length) {
      throw new Error("Tideline returned an inconsistent session.");
    }
    yield session;
  }
}

async function privatePullRoot(create = true) {
  const syncHome = resolve(process.env.TIDELINE_SYNC_HOME ?? join(homedir(), ".tideline"));
  if (create) await mkdir(syncHome, { recursive: true, mode: 0o700 });
  const root = join(syncHome, "pulls");
  await checkPrivateDirectory(syncHome);
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  await checkPrivateDirectory(root);
  return root;
}

async function checkPrivateDirectory(path: string) {
  const details = await lstat(path);
  if (!details.isDirectory() || (process.getuid && details.uid !== process.getuid()) ||
      (process.platform !== "win32" && (details.mode & 0o077) !== 0)) {
    throw new Error("The default pull location must be a directory you own with private permissions.");
  }
}

async function createOutputDirectory(path: string | undefined) {
  if (path === undefined) return mkdtemp(join(await privatePullRoot(), "pull-"));
  const target = resolve(path);
  const directory = join(await realpath(dirname(target)), basename(target));
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error?.code === "EEXIST") throw new Error("The pull destination already exists. Choose a new directory.");
    throw error;
  });
  return directory;
}

async function rememberPull(directory: string) {
  const partial = join(directory, ".last");
  await writeFile(partial, basename(directory) + "\n", { mode: 0o600, flag: "wx" });
  await rename(partial, join(dirname(directory), "LAST"));
}

async function latestPull() {
  try {
    const root = await privatePullRoot(false);
    const name = (await readLocalFile(join(root, "LAST"), 128)).trim();
    if (!/^pull-[A-Za-z0-9]{6}$/u.test(name)) throw new Error("The latest pull marker is invalid. Run tideline pull again.");
    const directory = join(root, name);
    await checkPrivateDirectory(directory);
    return directory;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function pullSessions(options: SessionCommandOptions & { out?: string; pattern?: string }) {
  const filters = filtersFrom(options);
  const matchesPattern = options.pattern === undefined ? undefined : regexMatcher(options.pattern);
  const account = await openCliAccount(options);
  const directory = await createOutputDirectory(options.out);
  let completed = false;
  let count = 0;
  try {
    const sessions = join(directory, "sessions");
    await mkdir(sessions, { mode: 0o700 });
    const transcripts = join(directory, "transcripts");
    if (options.transcripts) await mkdir(transcripts, { mode: 0o700 });
    if (options.github) {
      const events = await remoteGitHubRows(account, filters);
      const data = events.map((event) => JSON.stringify(event) + "\n").join("");
      await writeFile(join(directory, "github_activity.jsonl"), data, { mode: 0o600, flag: "wx" });
    }
    if (options.details) {
      for (const [name] of preciseTables) await writeFile(join(directory, name + ".jsonl"), "", { mode: 0o600, flag: "wx" });
    }
    for await (const session of remoteDetails(account, filters, options.details || Boolean(matchesPattern))) {
      if (matchesPattern && !matchesPattern([
        [session.sourceSessionId, session.id, session.title],
        ...session.messages.map(({ text }) => [text]),
        ...[...toolCalls(session)].map(({ name, input, output }) => [name, input, output]),
        ...[...sessionAgentMessages(session)].map(({ text }) => [text]),
      ])) continue;
      const { messages, capture, ...summary } = session;
      const header = options.details ? { ...summary, capture } : summary;
      const lines = [JSON.stringify(header), ...messages.map((message) => JSON.stringify(message))].join("\n") + "\n";
      await writeFile(join(sessions, `${header.id}.jsonl`), lines, { mode: 0o600, flag: "wx" });
      if (options.details) {
        for (const [name, readRows] of preciseTables) {
          const rows = [...readRows(session)].map((row) => JSON.stringify(row) + "\n").join("");
          if (rows) await appendFile(join(directory, name + ".jsonl"), rows);
        }
      }
      if (options.transcripts) await pullTranscript(account, header.id, transcripts);
      count++;
    }
    const manifest = { version: 1, workspaceId: account.workspaceId, createdAt: new Date().toISOString(), sessionCount: count, filters,
      ...(options.github && { github: true }) };
    const partial = join(directory, "manifest.partial");
    await writeFile(partial, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(partial, join(directory, "manifest.json"));
    if (options.out === undefined) await rememberPull(directory);
    completed = true;
  } finally {
    if (!completed) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  if (options.json) {
    console.log(JSON.stringify({ directory, sessions: count }));
  } else {
    console.log(`Pulled ${count} ${count === 1 ? "session" : "sessions"} to ${safeTerminal(directory)}`);
  }
}

function safeTerminal(value: string) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, "?");
}

async function readLocalFile(path: string, maximumBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error("A pull file exceeds the supported size or format.");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error("A pull file changed while it was being read.");
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

function decodeJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new Error("The pull contains invalid JSON.");
  }
}

function matches(session: CliSessionExport, { repo, source, from, to }: Filters) {
  const date = session.startedAt.slice(0, 10);
  return (!repo || session.analytics?.repository?.name.toLowerCase() === repo.toLowerCase()) &&
    (!source || session.source === source) && (!from || date >= from) && (!to || date <= to);
}

async function* localDetails(directory: string, filters: Filters) {
  const path = await realpath(resolve(directory));
  const manifest = await readManifest(path);
  const sessions = join(path, "sessions");
  if (!(await lstat(sessions)).isDirectory()) throw new Error("The pull sessions path must be a directory.");
  const files = (await readdir(sessions, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  if (files.length !== manifest.sessionCount) throw new Error("The pull session count does not match its manifest.");
  for (const entry of files) {
    const id = entry.name.endsWith(".jsonl") ? workspaceResponse.shape.id.safeParse(entry.name.slice(0, -6)) : undefined;
    if (!entry.isFile() || !id?.success) throw new Error("The pull contains an invalid session file.");
    const [header, ...messages] = (await readLocalFile(join(sessions, entry.name), maximumSessionBytes)).trimEnd().split("\n");
    const metadata = sessionHeader.safeParse(decodeJson(header));
    if (!metadata.success || metadata.data.id !== id.data || metadata.data.messageCount !== messages.length) {
      throw new Error("The pull contains invalid session metadata.");
    }
    const detail = cliSessionExport.safeParse({ ...metadata.data, messages: messages.map(decodeJson) });
    if (!detail.success) throw new Error("The pull contains invalid session messages.");
    if (matches(detail.data, filters)) yield detail.data;
  }
}

async function readManifest(path: string) {
  const manifest = manifestSchema.safeParse(decodeJson(await readLocalFile(join(path, "manifest.json"), 16_384)));
  if (!manifest.success) throw new Error("The directory does not contain a complete Tideline pull.");
  return manifest.data;
}

async function localGitHubRows(directory: string, { repo, from, to }: Filters) {
  const path = await realpath(resolve(directory));
  if (!(await readManifest(path)).github) return [];
  const data = await readLocalFile(join(path, "github_activity.jsonl"), 2 * 1024 * 1024);
  const rows = githubActivityRows.safeParse(data.trim() ? data.trimEnd().split("\n").map(decodeJson) : []);
  if (!rows.success) throw new Error("The pull contains invalid GitHub events.");
  return rows.data.filter(({ repository, event }) => {
    const day = event.at.slice(0, 10);
    return (!repo || repository.split("/")[1].toLowerCase() === repo.toLowerCase()) &&
      (!from || day >= from) && (!to || day <= to);
  });
}

function commandDetails(options: SessionCommandOptions & { in?: string }, filters: Filters) {
  if (options.in !== undefined) {
    if (!options.in) throw new Error("Pass a pull directory to --in.");
    if (options.workspace) throw new Error("Use either --workspace for a live query or --in for a local pull.");
    return localDetails(options.in, filters);
  }
  return (async function* () {
    yield* remoteDetails(await openCliAccount(options), filters, options.details);
  })();
}

type TextRows = (string | null)[][];
const evaluateRegex = new Script(`(() => {
  const expression = new RegExp(pattern, flags);
  return rows.filter(row => row.some(text => text !== null && expression.test(text))).length;
})()`);

function regexMatcher(pattern: string, ignoreCase = false) {
  if (!pattern.length || pattern.length > 1024) throw new Error("Use a regular expression of 1 to 1,024 characters.");
  const flags = ignoreCase ? "iu" : "u";
  try { new RegExp(pattern, flags); } catch { throw new Error("Enter a valid regular expression for --pattern."); }
  return (rows: TextRows) => {
    try {
      const count: unknown = evaluateRegex.runInNewContext({ pattern, flags, rows }, { timeout: 250 });
      return z.int().nonnegative().parse(count);
    } catch {
      throw new Error("The regular expression took too long. Use a simpler pattern.");
    }
  };
}

function countRows(session: CliSessionExport, unit: z.infer<typeof unitSchema>, field: z.infer<typeof fieldSchema>): TextRows {
  const messages = unit === "prompt" ? [...sessionPrompts(session)].map(({ text }) => [text])
    : session.messages.filter(({ role }) => field === "all" || field === role).map(({ text }) => [text]);
  if (unit !== "call" && (field === "all" || field === "user" || field === "assistant")) return messages;
  return [...toolCalls(session)].map(({ name, input, output }) => field === "tool-input" ? [input]
    : field === "tool-output" ? [output] : [name, input, output]);
}

export async function countSessions(pattern: string | undefined, options: SessionCommandOptions & {
  in?: string; pull?: string; live?: boolean; ignoreCase?: boolean; field?: string; unit?: string; pattern?: string;
}) {
  const filters = filtersFrom(options);
  if (pattern !== undefined && options.pattern !== undefined) throw new Error("Use either literal text or --pattern.");
  const search = pattern ?? options.pattern;
  if (search !== undefined && !search.length) throw new Error("Enter non-empty text to match.");
  if (search === undefined && (options.field || options.unit || options.ignoreCase)) {
    throw new Error("Pass text to match before using --field, --unit, or --ignore-case.");
  }
  const field = fieldSchema.parse(options.field ?? "all");
  const toolField = field.startsWith("tool");
  const unit = unitSchema.parse(options.unit ?? (search === undefined ? "session" : toolField ? "call" : "message"));
  if ((unit === "call" && (field === "user" || field === "assistant")) ||
      (unit === "prompt" && (field === "assistant" || toolField)) ||
      (unit === "message" && toolField)) throw new Error("Choose a field supported by the selected count unit.");
  const countRegex = options.pattern === undefined ? undefined : regexMatcher(options.pattern, options.ignoreCase);
  const explicitPull = options.in ?? options.pull;
  if ((options.in !== undefined && options.pull !== undefined) || (options.live && explicitPull !== undefined)) {
    throw new Error("Choose one of --in, --pull, or --live.");
  }
  const input = explicitPull ?? (options.pattern !== undefined && !options.workspace && !options.live ? await latestPull() : undefined);
  const term = options.ignoreCase ? search?.toLowerCase() : search;
  const normalize = (text: string) => options.ignoreCase ? text.toLowerCase() : text;
  let count = 0;
  let matchedSessions = 0;
  let scannedSessions = 0;
  if (input === undefined && term === undefined) {
    for await (const _ of remoteSummaries(await openCliAccount(options), filters)) scannedSessions++;
    count = matchedSessions = scannedSessions;
  } else {
    for await (const session of commandDetails({ ...options, in: input, details: toolField || unit === "call" || options.details }, filters)) {
      scannedSessions++;
      if (term === undefined) {
        count++;
        matchedSessions++;
        continue;
      }
      const rows = countRows(session, unit, field);
      const matching = countRegex ? countRegex(rows) : rows.filter((row) => row.some((text) => text !== null && normalize(text).includes(term))).length;
      if (matching) matchedSessions++;
      count += unit === "session" ? Number(matching > 0) : matching;
    }
  }
  console.log(options.json ? JSON.stringify({
    count, unit, matchedSessions, scannedSessions,
    ...(search === undefined ? {} : { pattern: search, field, ignoreCase: !!options.ignoreCase }),
  }) : String(count));
}

export async function querySessions(query: string, options: SessionCommandOptions & { in?: string; out?: string }) {
  const filters = filtersFrom(options);
  const sessions = commandDetails(options, filters);
  const github = options.in ? await localGitHubRows(options.in, filters)
    : options.github ? await remoteGitHubRows(await openCliAccount(options), filters) : [];
  const result = await queryLocalSessions(query, sessions, options.out, github);
  await writeQueryResults(result, options.out);
}
