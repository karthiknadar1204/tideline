import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { discoverClaudeSession, readClaudeSession } from "./claude-session";
import { discoverCodexSession, readCodexSession } from "./codex-session";
import { discoverCursorSessions, readCursorSessions } from "./cursor-session";
import { discoverOpenCodeSessions, openCodeDatabaseFiles, readOpenCodeSessions } from "./opencode-session";
import type { SyncConfig } from "./sync-storage";

export type AgentRoots = Pick<SyncConfig, "codexRoot" | "codexArchiveRoot" | "claudeRoot" | "cursorRoot" | "openCodeRoot">;

export function isWithin(path: string, directory: string) {
  const offset = relative(directory, path);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

export function isInaccessible(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code));
}

async function bindRoot(path: string) {
  try {
    return await realpath(path);
  } catch (error) {
    if (isInaccessible(error) && error.code === "ENOENT") return path;
    throw error;
  }
}

export async function configuredAgentRoots(): Promise<AgentRoots> {
  const cursorConfig = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  const openCodeData = resolve(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode");
  const openCodeDb = process.env.OPENCODE_DB;
  const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const [codexRoot, codexArchiveRoot, claudeRoot, cursorRoot, openCodeRoot] = await Promise.all([
    bindRoot(join(codexHome, "sessions")),
    bindRoot(join(codexHome, "archived_sessions")),
    bindRoot(resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")),
    bindRoot(resolve(process.env.TIDELINE_CURSOR_USER_DIR ?? join(cursorConfig, "Cursor", "User"))),
    openCodeDb === ":memory:" ? undefined : bindRoot(resolve(openCodeData, openCodeDb || ".")),
  ]);
  return { codexRoot, codexArchiveRoot, claudeRoot, cursorRoot, openCodeRoot };
}

export function fileSources(roots: AgentRoots) {
  return [
    { source: "codex", root: roots.codexRoot, depth: 3, read: readCodexSession, discover: discoverCodexSession },
    { source: "claude-code", root: roots.claudeRoot, depth: 1, read: readClaudeSession, discover: discoverClaudeSession },
    { source: "codex", root: roots.codexArchiveRoot, depth: 0, read: readCodexSession, discover: discoverCodexSession },
  ] as const;
}

const codexRolloutId = /^rollout-[^/]+-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/u;
const codexIndexLimit = 50_000;

export function createCodexSubagentIndex(roots: AgentRoots) {
  let files = new Map<string, string[]>();
  let refreshAt = 0;
  return {
    find: (id: string): readonly string[] => files.get(id) ?? [],
    async refresh(signal: AbortSignal) {
      if (Date.now() < refreshAt) return;
      const next = new Map<string, string[]>();
      for (const { source, root, depth } of fileSources(roots)) {
        if (source !== "codex" || !root) continue;
        for await (const path of sessionFiles(root, depth, () => {})) {
          if (signal.aborted) return;
          const id = codexRolloutId.exec(basename(path))?.[1];
          if (!id) continue;
          const matches = next.get(id);
          if (matches && matches.length < 3) matches.push(path);
          if (!matches && next.size < codexIndexLimit) next.set(id, [path]);
        }
      }
      files = next;
      refreshAt = Date.now() + 15_000;
    },
  };
}

export function databaseSources(roots: AgentRoots) {
  return [
    { source: "cursor", root: roots.cursorRoot, read: readCursorSessions, discover: discoverCursorSessions,
      files: async (root: string) => [join(root, "globalStorage", "state.vscdb"), join(root, "workspaceStorage")] },
    { source: "opencode", root: roots.openCodeRoot, read: readOpenCodeSessions, discover: discoverOpenCodeSessions,
      files: openCodeDatabaseFiles },
  ] as const;
}

export async function databaseVersion(paths: string[]) {
  const versions = await Promise.all(paths.flatMap((path) => [path, `${path}-wal`]).map(async (path) => {
    const entry = await lstat(path).catch(() => undefined);
    return [path, entry?.dev, entry?.ino, entry?.size, entry?.mtimeMs, entry?.ctimeMs];
  }));
  return JSON.stringify(versions);
}

export async function* sessionFiles(root: string, depth: number, onInaccessible: () => void): AsyncGenerator<string> {
  let entries;
  try {
    if (await realpath(root) !== root) return;
    entries = await opendir(root);
  } catch (error) {
    if (!isInaccessible(error)) throw error;
    onInaccessible();
    return;
  }
  for await (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && depth > 0) {
      yield* sessionFiles(path, depth - 1, onInaccessible);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield path;
    }
  }
}

export async function readPhysicalDirectory(path: string) {
  const directory = await realpath(path).catch(() => undefined);
  if (directory && await lstat(directory).then((entry) => entry.isDirectory(), () => false)) return directory;
}
