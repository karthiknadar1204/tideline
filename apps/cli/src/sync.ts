import { createHash, randomUUID } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  codexImportResponse,
  MAX_CODEX_IMPORT_BYTES,
  sessionImportRequest,
  syncEnrollmentRequest,
  syncEnrollmentResponse,
} from "@tideline/contracts";
import type { SessionImportRequest } from "@tideline/contracts";
import { readClaudeSession } from "./claude-session";
import { readCodexSession } from "./codex-session";
import { approveInBrowser, postToTideline, readJson, tidelineApiOrigin } from "./login";
import { readRepository } from "./repository";
import {
  deleteSyncCredential,
  loadSyncCredential,
  openSyncStorage,
  storeSyncCredential,
} from "./sync-storage";
import type { SyncConfig } from "./sync-storage";

type SetupOptions = {
  workspace: string;
  project: string;
  conversations?: boolean;
  browser: boolean;
  credentialFile?: boolean;
};

const syncRoutes = {
  enroll: "/v1/cli/sync/enroll",
  sessions: "/v1/cli/sync/sessions",
  revoke: "/v1/cli/sync/revoke",
};

const automaticRedactions: [RegExp, string][] = [
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:test|live)_[A-Za-z0-9_+=/-]{16,}|AIza[A-Za-z0-9_-]{35}|tdsync_[0-9a-f]{64}|(?:github_pat_|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g, "[REDACTED TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, "Bearer [REDACTED]"],
  [/(\b(?:[A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)|password)\s*[:=]\s*)(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/gi, "$1[REDACTED]"],
  [/(https?:\/\/[^\s:/@]+:)[^\s/@]+(?=@)/gi, "$1[REDACTED]"],
];

function redactConversationText(text: string) {
  return automaticRedactions.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

function isWithin(path: string, directory: string) {
  const offset = relative(directory, path);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

async function readPhysicalProjectDirectory(path: string) {
  const directory = await realpath(path).catch(() => "");
  if (!directory || !(await lstat(directory)).isDirectory()) {
    throw new Error("Set --project to an existing project directory.");
  }
  return directory;
}

function configuredAgentRoots() {
  return {
    codexRoot: resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
    claudeRoot: resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
  };
}

async function bindRoot(path: string) {
  try {
    return await realpath(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return path;
    throw error;
  }
}

export async function setupSync(options: SetupOptions) {
  const workspace = syncEnrollmentRequest.shape.workspaceId.safeParse(options.workspace);
  if (!workspace.success) throw new Error("Set --workspace to the destination workspace UUID.");
  if (!options.conversations) {
    throw new Error("Pass --conversations to approve syncing conversations and session analytics from this project.");
  }
  if (process.platform === "win32") {
    throw new Error("Tideline automatic sync currently requires macOS or Linux.");
  }
  if (!options.credentialFile && process.platform !== "darwin") {
    throw new Error("Use --credential-file to store the sync credential in a private local file on this platform.");
  }

  const projectDirectory = await readPhysicalProjectDirectory(options.project);
  const { codexRoot, claudeRoot } = configuredAgentRoots();
  const apiOrigin = tidelineApiOrigin();
  const storage = await openSyncStorage({ lock: true, create: true });
  try {
    if (storage.config()) throw new Error("This collector is already set up. Revoke it before changing its scope.");

    const account = randomUUID();
    const credentialStore = options.credentialFile ? "file" : "keychain";
    const roots = await Promise.all([bindRoot(codexRoot), bindRoot(claudeRoot)]);
    console.info(`Syncing new Codex and Claude Code conversations from ${projectDirectory} to workspace ${workspace.data} at ${apiOrigin}.`);
    console.info("The collector sends user and assistant text, source references, times, Git repository names and identifiers, models, and token counts. Common credentials in text are redacted.");
    if (credentialStore === "file") console.info("The sync credential will be stored in an owner-only local file.");

    const accessToken = await approveInBrowser(options.browser);
    const response = await postToTideline({
      apiOrigin, path: syncRoutes.enroll, accessToken, body: JSON.stringify({ workspaceId: workspace.data }),
    });
    const enrollment = syncEnrollmentResponse.safeParse(response?.ok ? await readJson(response) : null);
    if (!enrollment.success) throw new Error("Tideline could not enroll sync for this workspace.");

    const config: SyncConfig = {
      apiOrigin, workspaceId: workspace.data, projectDirectory, startedAt: new Date().toISOString(),
      expiresAt: enrollment.data.expiresAt, account, credentialStore, codexRoot: roots[0], claudeRoot: roots[1],
    };
    try {
      await storeSyncCredential(storage.directory, config, enrollment.data.token);
      storage.saveConfig(config);
    } catch {
      await postToTideline({ apiOrigin, path: syncRoutes.revoke, accessToken: enrollment.data.token });
      await deleteSyncCredential(storage.directory, config).catch(() => {});
      throw new Error("Tideline could not save sync setup. Check access to the credential store and try again.");
    }
    console.info("Sync is set up. Run tideline sync run to follow new sessions.");
  } finally {
    storage.close();
  }
}

function requireSetup(storage: Awaited<ReturnType<typeof openSyncStorage>>) {
  const config = storage.config();
  if (!config) throw new Error("Set up Tideline sync first with tideline sync setup.");
  if (config.apiOrigin !== tidelineApiOrigin()) {
    throw new Error("TIDELINE_API_URL differs from the approved sync destination.");
  }
  return config;
}

function isInaccessible(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code));
}

async function* sessionFiles(root: string, depth: number, onInaccessible: () => void): AsyncGenerator<string> {
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

type Storage = Awaited<ReturnType<typeof openSyncStorage>>;
type SourceReader = typeof readCodexSession | typeof readClaudeSession;
type ObservedFile = { version: string; retryAt?: number };

async function collectNewSessions(config: SyncConfig, storage: Storage, observed: Map<string, ObservedFile>, signal: AbortSignal) {
  const since = Date.parse(config.startedAt);
  const nextObserved = new Map<string, ObservedFile>();
  const repositories = new Map<string, Awaited<ReturnType<typeof readRepository>>>();
  let inaccessible = false;
  const sources = [
    { source: "codex", root: config.codexRoot, depth: 3, read: readCodexSession },
    { source: "claude-code", root: config.claudeRoot, depth: 1, read: readClaudeSession },
  ] as const;

  async function collect(path: string, root: string, source: SessionImportRequest["session"]["source"], read: SourceReader) {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.mtimeMs < since) return;
    const physicalPath = await realpath(path);
    if (physicalPath !== path || !isWithin(physicalPath, root)) return;
    const version = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
    const previous = observed.get(path);
    if (previous?.version === version && (!previous.retryAt || previous.retryAt > Date.now())) {
      nextObserved.set(path, previous);
      return;
    }

    let result: Awaited<ReturnType<SourceReader>>;
    try {
      result = await read(physicalPath, { live: true, projectDirectory: config.projectDirectory, since });
    } catch {
      console.warn(`${source}: skipped a session file that could not be read or parsed.`);
      nextObserved.set(path, { version, retryAt: Date.now() + 30_000 });
      return;
    }

    nextObserved.set(path, { version });
    if (!result || Date.parse(result.session.startedAt) < since) return;
    const project = await realpath(result.projectDirectory).catch(() => "");
    if (!project || !isWithin(project, config.projectDirectory)) return;
    if (!repositories.has(project)) repositories.set(project, await readRepository(project));
    const { analytics } = result.session;

    const candidate = sessionImportRequest.safeParse({
      version: 1, workspaceId: config.workspaceId,
      session: {
        ...result.session, source,
        analytics: analytics && { ...analytics, repository: repositories.get(project) ?? null },
        events: result.session.events.map((event) => ({ ...event, text: redactConversationText(event.text) })),
      },
    });
    if (!candidate.success) {
      console.warn(`${source}: skipped a session outside the supported message format or limits.`);
      return;
    }

    const session = candidate.data.session;
    const lastMessage = session.events.at(-1);
    if (!lastMessage) return;
    const body = JSON.stringify(candidate.data);
    if (Buffer.byteLength(body) > MAX_CODEX_IMPORT_BYTES) {
      console.warn(`${source}: a session exceeded the 1 MiB upload limit.`);
      return;
    }

    const phase = storage.queue({
      sessionKey: `${source}:${session.sourceSessionId}`,
      fingerprint: createHash("sha256").update(body).digest("hex"),
      messageCount: session.events.length,
      tailLine: session.analytics?.throughLine ?? lastMessage.line,
      body,
    });
    if (phase === "full") {
      nextObserved.delete(path);
      return "full";
    }
  }

  let full = false;
  for (const { source, root, depth, read } of sources) {
    if (signal.aborted || full) break;
    try {
      const physicalRoot = await realpath(root);
      if (physicalRoot !== root) {
        console.warn(`${source}: the configured session directory changed location. Revoke and set up sync again.`);
        continue;
      }
      for await (const path of sessionFiles(root, depth, () => { inaccessible = true; })) {
        if (signal.aborted) break;
        try {
          if (await collect(path, root, source, read) === "full") {
            full = true;
            break;
          }
        } catch (error) {
          if (!isInaccessible(error)) throw error;
          inaccessible = true;
        }
      }
    } catch (error) {
      if (!isInaccessible(error)) throw error;
      if (error.code !== "ENOENT") inaccessible = true;
    }
  }

  if (full) {
    for (const [key, value] of observed) if (!nextObserved.has(key)) nextObserved.set(key, value);
  }
  return { observed: nextObserved, full, inaccessible };
}

async function sendPending(storage: Storage, config: SyncConfig, token: string, signal: AbortSignal) {
  for (const { sessionKey, body } of storage.pending()) {
    if (signal.aborted) return true;
    const response = await postToTideline({ apiOrigin: config.apiOrigin, path: syncRoutes.sessions, body, accessToken: token });
    if (response?.status === 401 || response?.status === 403) {
      throw new Error("Tideline sync authorization expired or was revoked. Run tideline sync revoke and set it up again.");
    }
    if (response && [400, 404, 409, 413].includes(response.status)) {
      storage.finish(sessionKey, "failed");
      console.warn(`A session could not be uploaded (HTTP ${response.status}). Run tideline sync status for local counts.`);
      continue;
    }
    if (!response?.ok || !codexImportResponse.safeParse(await readJson(response)).success) return false;
    storage.finish(sessionKey, "received");
    console.info("A session update was received by Tideline.");
  }
  return true;
}

export async function runSync() {
  const storage = await openSyncStorage({ lock: true });
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const config = requireSetup(storage);
    if (config.revoked || Date.now() >= Date.parse(config.expiresAt)) {
      throw new Error("Tideline sync authorization expired. Run tideline sync revoke and set it up again.");
    }
    const token = await loadSyncCredential(storage.directory, config);
    console.info("Watching new Codex and Claude Code sessions. Press Ctrl+C to stop.");
    let observed = new Map<string, ObservedFile>();
    let nextRetryAt = 0;
    let retryDelay = 2_000;
    let offline = false;
    let queueFull = false;
    let inaccessible = false;
    while (!stopping.signal.aborted) {
      if (await realpath(config.projectDirectory).catch(() => "") !== config.projectDirectory) {
        throw new Error("The approved project directory changed location. Revoke and set up sync again.");
      }
      if (Date.now() >= Date.parse(config.expiresAt)) {
        throw new Error("Tideline sync authorization expired. Run tideline sync revoke and set it up again.");
      }

      const scan = await collectNewSessions(config, storage, observed, stopping.signal);
      observed = scan.observed;
      if (scan.full && !queueFull) console.warn("The local queue is full. Discovery will catch up from the agent files once uploads resume.");
      queueFull = scan.full;
      if (scan.inaccessible && !inaccessible) console.warn("Some agent session files or folders are inaccessible. Sync will retry them.");
      inaccessible = scan.inaccessible;

      if (Date.now() >= nextRetryAt) {
        if (await sendPending(storage, config, token, stopping.signal)) {
          if (offline) console.info("Tideline is reachable. Resuming uploads.");
          offline = false;
          retryDelay = 2_000;
        } else {
          if (!offline) console.warn("Tideline is unavailable. Session updates are queued locally.");
          offline = true;
          nextRetryAt = Date.now() + retryDelay;
          retryDelay = Math.min(retryDelay * 2, 30_000);
        }
      }

      await delay(2_000, undefined, { signal: stopping.signal }).catch(() => {});
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    storage.close();
  }
}

export async function syncStatus() {
  const storage = await openSyncStorage();
  try {
    const config = requireSetup(storage);
    const counts = storage.counts();
    console.info(`Workspace: ${config.workspaceId} at ${config.apiOrigin}`);
    console.info(`Project: ${config.projectDirectory}`);
    console.info(`New sessions since: ${config.startedAt}`);
    console.info(config.revoked ? "Approval revoked." : `Approval expires: ${config.expiresAt}`);
    console.info(`Queued: ${counts.get("queued") ?? 0}. Received: ${counts.get("received") ?? 0}. Failed: ${counts.get("failed") ?? 0}.`);
  } finally {
    storage.close();
  }
}

export async function revokeSync() {
  const storage = await openSyncStorage({ lock: true });
  try {
    if (!storage.config()) {
      console.info("Sync was revoked.");
      return;
    }
    const config = requireSetup(storage);
    if (!config.revoked && Date.now() < Date.parse(config.expiresAt)) {
      const token = await loadSyncCredential(storage.directory, config);
      const response = await postToTideline({ apiOrigin: config.apiOrigin, path: syncRoutes.revoke, accessToken: token });
      if (response?.status !== 204 && response?.status !== 401) {
        throw new Error("Tideline could not revoke sync. Check the API and try again.");
      }
    }
    storage.markRevoked(config);
    await deleteSyncCredential(storage.directory, config);
    storage.clear();
    console.info("Sync was revoked.");
  } finally {
    storage.close();
  }
}
