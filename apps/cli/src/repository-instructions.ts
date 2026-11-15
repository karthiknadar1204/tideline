import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MAX_REPOSITORY_INSTRUCTION_FILE_BYTES, MAX_REPOSITORY_INSTRUCTION_FILES,
  MAX_REPOSITORY_INSTRUCTION_SNAPSHOT_BYTES, repositoryInstructionPath, repositoryInstructionSnapshot,
  MAX_REPOSITORY_CONTEXT_ENTRIES, MAX_REPOSITORY_CONTEXT_METADATA_BYTES, repositoryAgentRootExtensions,
  repositoryConfigPaths, repositoryContextKind, repositoryPackagePaths, repositorySkillRoots,
} from "@tideline/contracts";
import type { RepositoryContextEntry, RepositoryInstructionSnapshot } from "@tideline/contracts";
import { postToTideline } from "./login";
import { createRepositoryGit, readCheckout, readRepository } from "./repository";
import { isSensitiveFile, redactCaptureText } from "./session-capture";
import type { SyncConfig } from "./sync-storage";

const refreshMs = 30_000;
const names = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"];
const pathspecs = names.map((name) => `:(glob)**/${name}`);
const contextPathspecs = [...repositorySkillRoots, ...Object.keys(repositoryAgentRootExtensions)].map((root) => `:(glob)${root}/**`)
  .concat([...repositoryConfigPaths, ...repositoryPackagePaths].map((path) => `:(literal)${path}`));
const rootNames = names.flatMap((name) => [name, `.claude/${name}`, `.codex/${name}`]);
const safeRevision = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

async function readSnapshotFile(directory: string, path: string, maxBytes: number) {
  const file = join(directory, path);
  if (await realpath(file).catch(() => undefined) !== file) return;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (!handle) return;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) return;
    const buffer = Buffer.alloc(stat.size + 1);
    let written = 0;
    while (written < buffer.length) {
      const { bytesRead } = await handle.read(buffer, written, buffer.length - written, written);
      if (!bytesRead) break;
      written += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(file);
    if (current.ino !== stat.ino || current.dev !== stat.dev || after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs || written !== stat.size || await realpath(file) !== file) return;
    return buffer.subarray(0, written);
  } catch {
    return;
  } finally {
    await handle.close();
  }
}

async function readInstruction(directory: string, path: string) {
  const bytes = await readSnapshotFile(directory, path, MAX_REPOSITORY_INSTRUCTION_FILE_BYTES);
  if (!bytes) return;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return;
    const content = redactCaptureText(text.replaceAll(directory + "/", ""));
    if (Buffer.byteLength(content) <= MAX_REPOSITORY_INSTRUCTION_FILE_BYTES) return content;
  } catch {
    return;
  }
}

function safePath(path: string) {
  return !isSensitiveFile(path) && redactCaptureText(path) === path;
}

function trackedChanges(status: string) {
  const records = status.split("\0");
  const changes = { staged: 0, unstaged: 0 };
  for (let i = 0; i < records.length - 1; i++) {
    const [index, worktree] = records[i];
    if (index !== " ") changes.staged++;
    if (worktree !== " ") changes.unstaged++;
    if (index === "R" || index === "C" || worktree === "R" || worktree === "C") i++;
  }
  return changes;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function readJsonMetadata(bytes: Buffer) {
  try {
    return jsonObject(JSON.parse(bytes.toString("utf8")));
  } catch {
    return undefined;
  }
}

async function captureContext(directory: string, listed: string | undefined, status: string | undefined,
  revision: string | null, key: string) {
  const entries: RepositoryContextEntry[] = [];
  const context = { revision, entries, partial: listed === undefined || status === undefined,
    trackedChanges: status === undefined ? undefined : trackedChanges(status) };
  const priorities = { skill: 0, agent: 1, config: 2, package: 3, resource: 4 };
  const candidates = [...new Set(listed?.split("\0") ?? [])].flatMap((path) => {
    const kind = repositoryContextKind(path);
    return kind ? [{ path, kind }] : [];
  }).sort((left, right) => priorities[left.kind] - priorities[right.kind] || left.path.localeCompare(right.path));
  const definitions = new Set(candidates.filter(({ kind }) => kind === "skill").map(({ path }) => path));
  const capturedDefinitions = new Set<string>();
  for (const { kind, path } of candidates) {
    if (entries.length >= MAX_REPOSITORY_CONTEXT_ENTRIES) { context.partial = true; break; }
    if (!safePath(path)) continue;
    if (kind === "skill" || kind === "agent") {
      const content = await readInstruction(directory, path);
      if (content === undefined) { context.partial = true; continue; }
      entries.push({ kind, path, content });
    } else {
      let definitionPath: string | undefined;
      if (kind === "resource") {
        for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
          const candidate = `${parent}/SKILL.md`;
          if (definitions.has(candidate)) { definitionPath = candidate; break; }
        }
        if (!definitionPath || !capturedDefinitions.has(definitionPath)) continue;
      }
      const bytes = await readSnapshotFile(directory, path, MAX_REPOSITORY_CONTEXT_METADATA_BYTES);
      if (!bytes) { context.partial = true; continue; }
      const fingerprint = createHmac("sha256", key).update(path).update("\0").update(bytes).digest("hex");
      const metadata = { path, bytes: bytes.length, fingerprint };
      if (kind === "resource" && definitionPath) entries.push({ ...metadata, definitionPath, kind });
      if (kind === "config") {
        const mcp = readJsonMetadata(bytes);
        const servers = jsonObject(mcp?.mcpServers) ?? jsonObject(mcp?.mcp);
        entries.push({ ...metadata, kind, mcpServers: servers ? Object.keys(servers).length : undefined });
      }
      if (kind === "package") {
        const manifest = path === "package.json" ? readJsonMetadata(bytes) : undefined;
        entries.push({ ...metadata, kind, summary: manifest ? {
          dependencies: Object.keys(jsonObject(manifest.dependencies) ?? {}).length,
          developmentDependencies: Object.keys(jsonObject(manifest.devDependencies) ?? {}).length,
          scripts: Object.keys(jsonObject(manifest.scripts) ?? {}).length,
        } : undefined });
      }
    }
    if (Buffer.byteLength(JSON.stringify(context)) > MAX_REPOSITORY_INSTRUCTION_SNAPSHOT_BYTES - 16) {
      entries.pop();
      context.partial = true;
      break;
    }
    if (kind === "skill") capturedDefinitions.add(path);
  }
  return context;
}

export async function captureRepositoryInstructions(directory: string, selection: { instructions: boolean; contextKey?: string } = { instructions: true }) {
  if (await realpath(directory).catch(() => undefined) !== directory) return;
  const git = createRepositoryGit(directory, { maxBuffer: 256 * 1024, raw: true });
  const [listed, contextFiles, revisionText, status] = await Promise.all([
    selection.instructions ? git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs) : undefined,
    selection.contextKey ? git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...contextPathspecs) : undefined,
    git("rev-parse", "--verify", "HEAD"),
    selection.contextKey ? git("-c", "core.fsmonitor=false", "--no-optional-locks", "status", "--porcelain=v1", "-z",
      "--untracked-files=no", "--ignore-submodules=all") : undefined,
  ]);
  const head = revisionText?.trim();
  const revision = head && safeRevision.test(head) ? head : null;
  const snapshot: RepositoryInstructionSnapshot = {
    revision: selection.instructions ? revision : null, documents: [], partial: selection.instructions && listed === undefined,
  };
  const paths = [...new Set(listed?.split("\0") ?? [])]
    .filter((path) => repositoryInstructionPath.safeParse(path).success)
    .sort((left, right) => Number(rootNames.includes(right)) - Number(rootNames.includes(left)) ||
      left.split("/").length - right.split("/").length || left.localeCompare(right));
  if (paths.length > MAX_REPOSITORY_INSTRUCTION_FILES) snapshot.partial = true;
  for (const path of paths.slice(0, MAX_REPOSITORY_INSTRUCTION_FILES)) {
    if (!safePath(path)) {
      snapshot.partial = true;
      continue;
    }
    const content = await readInstruction(directory, path);
    if (content === undefined) {
      snapshot.partial = true;
      continue;
    }
    snapshot.documents.push({ path, content });
    if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_REPOSITORY_INSTRUCTION_SNAPSHOT_BYTES - 16) {
      snapshot.documents.pop();
      snapshot.partial = true;
      break;
    }
  }
  if (selection.contextKey) snapshot.context = await captureContext(directory, contextFiles, status, revision, selection.contextKey);
  return repositoryInstructionSnapshot.parse(snapshot);
}

export function createRepositoryInstructionSync(config: SyncConfig) {
  const nextScan = new Map<string, number>();
  const fingerprints = new Map<string, string>();
  const checkoutByRepository = new Map<string, string>();
  let index = 0;

  return async (accessToken: string, signal: AbortSignal) => {
    if ((!config.repositoryInstructions && !config.repositoryContext) || !config.projects.length || signal.aborted) return;
    const project = config.projects[index++ % config.projects.length];
    if (Date.now() < (nextScan.get(project.directory) ?? 0)) return;
    nextScan.set(project.directory, Date.now() + refreshMs);
    const approvedGit = "git" in project ? project.git : undefined;
    if (approvedGit === null) return;
    const checkout = await readCheckout(project.directory);
    if (!checkout || checkout.root !== project.directory ||
        (approvedGit && (checkout.root !== approvedGit.root || checkout.common !== approvedGit.common))) return;
    const repository = await readRepository(checkout.root);
    if (!repository || signal.aborted) return;
    const previous = checkoutByRepository.get(repository.key);
    if (previous && previous !== project.directory) return;
    checkoutByRepository.set(repository.key, project.directory);
    const snapshot = await captureRepositoryInstructions(checkout.root, {
      instructions: Boolean(config.repositoryInstructions), contextKey: config.repositoryContext ? config.account : undefined,
    });
    if (!snapshot || signal.aborted) return;

    const body = JSON.stringify({ workspaceId: config.workspaceId, repository: repository.key, snapshot,
      ...(config.repositoryInstructions ? {} : { contextOnly: true }) });
    const fingerprint = createHash("sha256").update(body).digest("hex");
    if (fingerprints.get(repository.key) === fingerprint) return;
    const response = await postToTideline({
      apiOrigin: config.apiOrigin, path: "/v1/cli/sync/repository-instructions", accessToken, body, signal,
    });
    if (response?.ok) fingerprints.set(repository.key, fingerprint);
  };
}
