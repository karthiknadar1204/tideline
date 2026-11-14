import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  cliSessionFilters, cliSessionPageResponse, MAX_CODEX_IMPORT_BYTES, sessionDetailResponse, workspaceResponse,
} from "@tideline/contracts";
import type { SessionDetail } from "@tideline/contracts";
import { z } from "zod";
import { openCliAccount } from "./cli-account";
import { queryLocalSessions, writeQueryResults } from "./session-query";

export { runSqlWorker } from "./session-query";

type Filters = z.infer<typeof cliSessionFilters>;
export type SessionCommandOptions = {
  workspace?: string;
  repo?: string;
  source?: string;
  from?: string;
  to?: string;
  json?: boolean;
};

const manifestSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: workspaceResponse.shape.id,
  createdAt: z.iso.datetime(),
  sessionCount: z.int().nonnegative(),
  filters: cliSessionFilters,
});
const sessionHeader = sessionDetailResponse.omit({ messages: true });
const unitSchema = z.enum(["message", "session"]);
const roleSchema = z.enum(["all", "user", "assistant"]);
const maximumSessionBytes = MAX_CODEX_IMPORT_BYTES * 2;

function filtersFrom({ repo, source, from, to }: SessionCommandOptions) {
  const parsed = cliSessionFilters.safeParse({ repo, source, from, to });
  if (!parsed.success) {
    throw new Error("Use a repository name, a supported agent for --source, and an ordered UTC date range in YYYY-MM-DD format.");
  }
  return parsed.data;
}

type Account = Awaited<ReturnType<typeof openCliAccount>>;

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

async function* remoteDetails(account: Account, filters: Filters) {
  for await (const summary of remoteSummaries(account, filters)) {
    const session = await account.get(
      `/v1/cli/workspaces/${account.workspaceId}/sessions/${summary.id}`,
      sessionDetailResponse,
    );
    if (session.id !== summary.id || session.messageCount !== session.messages.length) {
      throw new Error("Tideline returned an inconsistent session.");
    }
    yield session;
  }
}

async function privatePullRoot() {
  const syncHome = resolve(process.env.TIDELINE_SYNC_HOME ?? join(homedir(), ".tideline"));
  await mkdir(syncHome, { recursive: true, mode: 0o700 });
  const root = join(syncHome, "pulls");
  await checkPrivateDirectory(syncHome);
  await mkdir(root, { recursive: true, mode: 0o700 });
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

export async function pullSessions(options: SessionCommandOptions & { out?: string }) {
  const filters = filtersFrom(options);
  const account = await openCliAccount(options);
  const directory = await createOutputDirectory(options.out);
  let completed = false;
  let count = 0;
  try {
    const sessions = join(directory, "sessions");
    await mkdir(sessions, { mode: 0o700 });
    for await (const { messages, ...header } of remoteDetails(account, filters)) {
      const lines = [JSON.stringify(header), ...messages.map((message) => JSON.stringify(message))].join("\n") + "\n";
      await writeFile(join(sessions, `${header.id}.jsonl`), lines, { mode: 0o600, flag: "wx" });
      count++;
    }
    const manifest = { version: 1, workspaceId: account.workspaceId, createdAt: new Date().toISOString(), sessionCount: count, filters };
    const partial = join(directory, "manifest.partial");
    await writeFile(partial, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(partial, join(directory, "manifest.json"));
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

function matches(session: SessionDetail, { repo, source, from, to }: Filters) {
  const date = session.startedAt.slice(0, 10);
  return (!repo || session.analytics?.repository?.name.toLowerCase() === repo.toLowerCase()) &&
    (!source || session.source === source) && (!from || date >= from) && (!to || date <= to);
}

async function* localDetails(directory: string, filters: Filters) {
  const path = await realpath(resolve(directory));
  const manifest = manifestSchema.safeParse(decodeJson(await readLocalFile(join(path, "manifest.json"), 16_384)));
  if (!manifest.success) throw new Error("The directory does not contain a complete Tideline pull.");
  const sessions = join(path, "sessions");
  if (!(await lstat(sessions)).isDirectory()) throw new Error("The pull sessions path must be a directory.");
  const files = (await readdir(sessions, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  if (files.length !== manifest.data.sessionCount) throw new Error("The pull session count does not match its manifest.");
  for (const entry of files) {
    const id = entry.name.endsWith(".jsonl") ? workspaceResponse.shape.id.safeParse(entry.name.slice(0, -6)) : undefined;
    if (!entry.isFile() || !id?.success) throw new Error("The pull contains an invalid session file.");
    const [header, ...messages] = (await readLocalFile(join(sessions, entry.name), maximumSessionBytes)).trimEnd().split("\n");
    const metadata = sessionHeader.safeParse(decodeJson(header));
    if (!metadata.success || metadata.data.id !== id.data || metadata.data.messageCount !== messages.length) {
      throw new Error("The pull contains invalid session metadata.");
    }
    const detail = sessionDetailResponse.safeParse({ ...metadata.data, messages: messages.map(decodeJson) });
    if (!detail.success) throw new Error("The pull contains invalid session messages.");
    if (matches(detail.data, filters)) yield detail.data;
  }
}

function commandDetails(options: SessionCommandOptions & { in?: string }, filters: Filters) {
  if (options.in !== undefined) {
    if (!options.in) throw new Error("Pass a pull directory to --in.");
    if (options.workspace) throw new Error("Use either --workspace for a live query or --in for a local pull.");
    return localDetails(options.in, filters);
  }
  return (async function* () {
    yield* remoteDetails(await openCliAccount(options), filters);
  })();
}

export async function countSessions(pattern: string | undefined, options: SessionCommandOptions & {
  in?: string; ignoreCase?: boolean; field?: string; unit?: string;
}) {
  const filters = filtersFrom(options);
  if (pattern !== undefined && !pattern.length) throw new Error("Enter non-empty text to match.");
  if (pattern === undefined && (options.field || options.unit || options.ignoreCase)) {
    throw new Error("Pass text to match before using --field, --unit, or --ignore-case.");
  }
  const selection = roleSchema.safeParse(options.field ?? "all");
  if (!selection.success) throw new Error("Use --field user, assistant, or all.");
  const countUnit = unitSchema.safeParse(options.unit ?? (pattern === undefined ? "session" : "message"));
  if (!countUnit.success) throw new Error("Use --unit message or session.");

  const term = options.ignoreCase ? pattern?.toLowerCase() : pattern;
  const normalize = (text: string) => options.ignoreCase ? text.toLowerCase() : text;
  let count = 0;
  let matchedSessions = 0;
  let scannedSessions = 0;
  if (options.in === undefined && term === undefined) {
    for await (const _ of remoteSummaries(await openCliAccount(options), filters)) scannedSessions++;
    count = matchedSessions = scannedSessions;
  } else {
    for await (const session of commandDetails(options, filters)) {
      scannedSessions++;
      if (term === undefined) {
        count++;
        matchedSessions++;
        continue;
      }
      const matchingMessages = session.messages.filter(({ role, text }) =>
        (selection.data === "all" || selection.data === role) && normalize(text).includes(term)
      ).length;
      if (matchingMessages) matchedSessions++;
      count += countUnit.data === "message" ? matchingMessages : Number(matchingMessages > 0);
    }
  }
  console.log(options.json ? JSON.stringify({
    count, unit: countUnit.data, matchedSessions, scannedSessions,
    ...(pattern === undefined ? {} : { pattern, field: selection.data, ignoreCase: !!options.ignoreCase }),
  }) : String(count));
}

export async function querySessions(query: string, options: SessionCommandOptions & { in?: string; out?: string }) {
  const filters = filtersFrom(options);
  const result = await queryLocalSessions(query, commandDetails(options, filters), options.out);
  await writeQueryResults(result, options.out);
}
