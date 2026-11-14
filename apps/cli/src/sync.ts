import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  codexImportResponse,
  MAX_CODEX_IMPORT_BYTES,
  sessionImportRequest,
  sessionSourceLabel,
  syncEnrollmentRequest,
  syncEnrollmentResponse,
  workspaceResponse,
} from "@tideline/contracts";
import type { SessionImportRequest } from "@tideline/contracts";
import { findSessionCommits } from "./commit-links";
import { approveInBrowser, postToTideline, readJson, tidelineApiOrigin } from "./login";
import { readRepository } from "./repository";
import { redactConversationText } from "./session-safety";
import type { LiveSession, SessionCandidate } from "./session-jsonl";
import { openCollectorStorage, readBackgroundStatus, startBackgroundSync, stopBackgroundSync } from "./sync-background";
import { chooseProjects, createApprovedScope, explicitProjects, historyStart, sameCheckout, terminalText } from "./sync-projects";
import { configuredAgentRoots, databaseSources, databaseVersion, fileSources, isInaccessible, isWithin, readPhysicalDirectory, sessionFiles } from "./sync-sources";
import {
  backgroundStartupTimeout,
  deleteSyncCredential,
  loadSyncCredential,
  openSyncStorage,
  storeSyncCredential,
  SyncLockError,
  SyncSetupMissingError,
} from "./sync-storage";
import type { SyncConfig } from "./sync-storage";

type SetupOptions = {
  workspace?: string;
  project?: string[];
  history?: boolean;
  background?: boolean;
  conversations?: boolean;
  browser: boolean;
  credentialFile?: boolean;
};

const syncRoutes = {
  enroll: "/v1/cli/sync/enroll",
  sessions: "/v1/cli/sync/sessions",
  revoke: "/v1/cli/sync/revoke",
};

async function readCurrentSetup() {
  const storage = await openSyncStorage().catch((error) => {
    if (!(error instanceof SyncSetupMissingError)) throw error;
  });
  if (!storage) return;
  try {
    return storage.config();
  } finally {
    storage.close();
  }
}

async function enrollSync(storage: Storage, options: SetupOptions, settings: Omit<SyncConfig, "workspaceId" | "expiresAt">) {
  const accessToken = await approveInBrowser(options.browser);
  let workspaceId = options.workspace;
  if (!workspaceId) {
    const approved = await postToTideline({ apiOrigin: settings.apiOrigin, path: "/v1/cli/approve", accessToken });
    const workspace = workspaceResponse.safeParse(approved?.ok ? await readJson(approved) : null);
    if (!workspace.success) throw new Error("Tideline could not open your personal workspace.");
    workspaceId = workspace.data.id;
  }
  const response = await postToTideline({
    apiOrigin: settings.apiOrigin, path: syncRoutes.enroll, accessToken, body: JSON.stringify({ workspaceId }),
  });
  const enrollment = syncEnrollmentResponse.safeParse(response?.ok ? await readJson(response) : null);
  if (!enrollment.success) throw new Error("Tideline could not enroll sync for this workspace.");

  const config = { ...settings, workspaceId, expiresAt: enrollment.data.expiresAt };
  try {
    await storeSyncCredential(storage.directory, config, enrollment.data.token);
    storage.saveConfig(config);
  } catch {
    await postToTideline({ apiOrigin: settings.apiOrigin, path: syncRoutes.revoke, accessToken: enrollment.data.token });
    await deleteSyncCredential(storage.directory, config).catch(() => {});
    throw new Error("Tideline could not save sync setup. Check access to the credential store and try again.");
  }
}

export async function setupSync(options: SetupOptions) {
  if (options.workspace !== undefined && !syncEnrollmentRequest.shape.workspaceId.safeParse(options.workspace).success) {
    throw new Error("Set --workspace to the destination workspace UUID.");
  }
  if (process.platform === "win32") throw new Error("Tideline automatic sync currently requires macOS or Linux.");
  const previous = await readCurrentSetup();
  const apiOrigin = tidelineApiOrigin();
  if (!options.workspace && !previous) {
    const { approvedWorkspaceDefault } = await import("./cli-account");
    options = { ...options, workspace: await approvedWorkspaceDefault() };
  }
  if (previous && (previous.apiOrigin !== apiOrigin || (options.workspace && options.workspace !== previous.workspaceId) ||
      previous.revoked || Date.now() >= Date.parse(previous.expiresAt))) {
    throw new Error("Revoke this collector before changing its workspace or renewing its approval.");
  }
  if (!previous && !options.credentialFile && process.platform !== "darwin") {
    throw new Error("Use --credential-file to store the sync credential in a private local file on this platform.");
  }

  const roots = previous ? {
    ...previous,
    codexArchiveRoot: previous.codexArchiveRoot ?? join(dirname(previous.codexRoot), "archived_sessions"),
  } : await configuredAgentRoots();
  if (options.project?.length && !options.conversations) {
    throw new Error("Pass --conversations to approve syncing conversation text and available metadata from the selected projects.");
  }
  const selection = options.project?.length ? {
    projects: await explicitProjects(options.project), history: options.history ?? false, background: options.background ?? false,
  } : await chooseProjects(roots, previous?.projects ?? [], { ...options, allowEmpty: Boolean(previous) });
  if (!selection) {
    console.info("Setup canceled.");
    return;
  }

  if (previous) await stopBackgroundSync({ quiet: true });
  const storage = await openSyncStorage({ lock: true, create: true });
  try {
    if (JSON.stringify(storage.config()) !== JSON.stringify(previous)) throw new Error("Sync setup changed. Run tideline sync setup again.");
    const now = new Date().toISOString();
    const retained = previous?.projects.filter((prior) => selection.projects.some((project) => sameCheckout(prior, project))) ?? [];
    const sinceByPath = new Map(retained.map((project) => [project.directory, project.since]));
    const projects = selection.projects.map((project) => ({ ...project, since: selection.history ? historyStart : sinceByPath.get(project.directory) ?? now }));
    if (previous) {
      const removed = previous.projects.filter((prior) => !retained.includes(prior));
      storage.updateProjects({ ...previous, projects, codexArchiveRoot: roots.codexArchiveRoot }, removed);
    } else {
      const sources = [sessionSourceLabel.codex, sessionSourceLabel["claude-code"], sessionSourceLabel.cursor];
      if (roots.openCodeRoot) sources.push(sessionSourceLabel.opencode);
      const destination = options.workspace ? `workspace ${options.workspace}` : "your personal workspace";
      console.info(`Syncing ${projects.length} ${projects.length === 1 ? "project" : "projects"} from ${sources.join(", ")} to ${destination} at ${apiOrigin}.`);
      if (selection.history) console.info("This approval includes older sessions.");
      await enrollSync(storage, options, {
        apiOrigin, projects, startedAt: now, account: randomUUID(), credentialStore: options.credentialFile ? "file" : "keychain",
        codexRoot: roots.codexRoot, codexArchiveRoot: roots.codexArchiveRoot,
        claudeRoot: roots.claudeRoot, cursorRoot: roots.cursorRoot, openCodeRoot: roots.openCodeRoot,
      });
    }
  } finally {
    storage.close();
  }
  if (!selection.projects.length) {
    console.info("Uploads are paused. Run tideline enable to choose repositories again.");
  } else if (selection.background) {
    await startBackgroundSync();
  } else {
    console.info("Sync is set up. Run tideline sync start in the background or tideline sync run in this terminal.");
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

type Storage = Awaited<ReturnType<typeof openSyncStorage>>;
type SourceReader = ReturnType<typeof fileSources>[number]["read"];
type ObservedFile = { version: string; retryAt?: number };
type ObservedDatabase = { version: string; reconcileAt: number };
type UploadRetry = { id: string; candidates: Set<string> };

function sessionKey({ source, sourceSessionId }: Pick<SessionCandidate, "source" | "sourceSessionId">) {
  return `${source}:${sourceSessionId}`;
}

async function collectNewSessions(
  config: SyncConfig,
  storage: Storage,
  observed: Map<string, ObservedFile>,
  databases: Map<string, ObservedDatabase>,
  signal: AbortSignal,
  retry?: UploadRetry,
) {
  const scope = createApprovedScope(config.projects);
  const options = {
    live: true as const,
    ...scope,
    sessionAllowed: (candidate: SessionCandidate) => scope.sessionAllowed(candidate) &&
      (!retry || retry.candidates.has(sessionKey(candidate))),
  };
  const nextObserved = new Map<string, ObservedFile>();
  const repositories = new Map<string, Awaited<ReturnType<typeof readRepository>>>();
  let inaccessible = false;

  async function queueSession(result: LiveSession) {
    const { source, analytics } = result.session;
    const project = await scope.projectScope(result.projectDirectory);
    if (!project || signal.aborted || !options.sessionAllowed({ ...result.session, projectDirectory: project })) return;
    const projectDirectory = scope.projectRoot(project);
    if (!projectDirectory) return;
    if (!repositories.has(project)) repositories.set(project, await readRepository(project));
    const evidence = result.evidence;
    const review = evidence && {
      throughLine: evidence.throughLine,
      truncated: evidence.truncated,
      findings: evidence.findings,
      commits: await findSessionCommits(project, evidence.commitCandidates),
    };

    const candidate = sessionImportRequest.safeParse({
      version: 1, workspaceId: config.workspaceId,
      session: {
        ...result.session, source,
        analytics: analytics && { ...analytics, repository: repositories.get(project) ?? null },
        review,
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
      sessionKey: sessionKey(session),
      projectDirectory,
      fingerprint: createHash("sha256").update(body).digest("hex"),
      messageCount: session.events.length,
      tailLine: Math.max(lastMessage.line, session.analytics?.throughLine ?? 0, session.activity?.throughLine ?? 0, session.review?.throughLine ?? 0),
      projection: session.activity ? 2 : 1,
      body,
    }, retry?.id);
    return phase === "full" ? "full" : undefined;
  }

  async function collect(path: string, root: string, source: SessionImportRequest["session"]["source"], read: SourceReader) {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.mtimeMs < scope.since) return;
    const physicalPath = await realpath(path);
    if (physicalPath !== path || !isWithin(physicalPath, root)) return;
    const version = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
    const previous = observed.get(path);
    if (previous?.version === version && (!previous.retryAt || previous.retryAt > Date.now())) {
      nextObserved.set(path, previous);
      return;
    }

    let result: Awaited<ReturnType<SourceReader>>;
    let retryProject = false;
    try {
      result = await read(physicalPath, {
        ...options,
        async projectScope(directory) {
          const project = await scope.projectScope(directory);
          if (!project && directory && scope.projectRoot(directory)) retryProject = true;
          return project;
        },
      });
    } catch {
      console.warn(`${source}: skipped a session file that could not be read or parsed.`);
      nextObserved.set(path, { version, retryAt: Date.now() + 30_000 });
      return;
    }

    nextObserved.set(path, { version, retryAt: retryProject ? Date.now() + 30_000 : undefined });
    if (result && await queueSession(result) === "full") {
      nextObserved.delete(path);
      return "full";
    }
  }

  let full = false;
  for (const { source, root, depth, read } of fileSources(config)) {
    if (signal.aborted || full) break;
    if (!root) continue;
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

  for (const { source, root, read, files } of databaseSources(config)) {
    if (signal.aborted || full) break;
    if (!root) continue;
    try {
      if (await realpath(root) !== root) {
        console.warn(`${sessionSourceLabel[source]}: the configured session location changed. Revoke and set up sync again.`);
        continue;
      }
      const version = await databaseVersion(await files(root));
      const previous = databases.get(source);
      if (previous?.version === version && previous.reconcileAt > Date.now()) continue;
      for await (const result of read(root, options)) {
        if (signal.aborted) break;
        if (await queueSession(result) === "full") {
          full = true;
          break;
        }
      }
      if (!full && !signal.aborted) databases.set(source, { version, reconcileAt: Date.now() + 30_000 });
    } catch (error) {
      if (!isInaccessible(error) || error.code !== "ENOENT") inaccessible = true;
    }
  }

  if (full) {
    for (const [key, value] of observed) if (!nextObserved.has(key)) nextObserved.set(key, value);
  }
  return { observed: nextObserved, full, inaccessible };
}

async function sendPending(storage: Storage, config: SyncConfig, token: string, signal: AbortSignal,
  pending = storage.pending(), retryId?: string) {
  for (const { sessionKey, body } of pending) {
    if (signal.aborted) return true;
    const response = await postToTideline({ apiOrigin: config.apiOrigin, path: syncRoutes.sessions, body, accessToken: token, signal });
    if (response?.status === 401 || response?.status === 403) {
      throw new Error("Tideline sync authorization expired or was revoked. Run tideline sync revoke and set it up again.");
    }
    if (response && [400, 404, 409, 413].includes(response.status)) {
      storage.finish(sessionKey, { phase: "failed", httpStatus: response.status }, retryId);
      console.warn(`A session could not be uploaded (HTTP ${response.status}). Run tideline sync status for local counts.`);
      continue;
    }
    if (!response?.ok || !codexImportResponse.safeParse(await readJson(response)).success) return false;
    storage.finish(sessionKey, { phase: "received" });
    console.info("A session update was received by Tideline.");
  }
  return true;
}

async function loadActiveSyncToken(storage: Storage, config: SyncConfig) {
  if (config.revoked || Date.now() >= Date.parse(config.expiresAt)) {
    throw new Error("Tideline sync authorization expired. Run tideline sync revoke and set it up again.");
  }
  return loadSyncCredential(storage.directory, config);
}

async function attemptRetry(storage: Storage, config: SyncConfig, token: string, id: string, signal: AbortSignal) {
  let observed = new Map<string, ObservedFile>();
  const databases = new Map<string, ObservedDatabase>();
  let scanned = false;
  while (!signal.aborted) {
    const pending = storage.pending();
    if (pending.length) {
      if (!await sendPending(storage, config, token, signal, pending, id)) return signal.aborted ? "interrupted" : "offline";
      continue;
    }
    if (scanned || !config.projects.length) break;
    const candidates = storage.retryCandidates(id);
    if (!candidates.size) break;
    const scan = await collectNewSessions(config, storage, observed, databases, signal, { id, candidates });
    observed = scan.observed;
    scanned = !scan.full;
  }
  if (signal.aborted) return "interrupted";
  storage.finishRetry(id);
  return "finished";
}

export async function retrySync() {
  const control = await openSyncStorage();
  try {
    const config = requireSetup(control);
    const token = await loadActiveSyncToken(control, config);
    if (!control.requestRetry(config.account, randomUUID())) throw new Error("Sync setup changed. Run tideline sync retry again.");
    const writer = await openSyncStorage({ lock: true }).catch((error) => {
      if (!(error instanceof SyncLockError)) throw error;
    });
    if (!writer) {
      console.info("Retry requested. It will run while sync is active. If sync stops, run tideline sync retry again.");
      return;
    }
    try {
      const current = requireSetup(writer);
      if (current.account !== config.account) throw new Error("Sync setup changed. Run tideline sync retry again.");
      const id = writer.requestedRetry(current.account);
      if (id) {
        const background = writer.background();
        if (background?.phase === "starting" && Date.now() - background.startedAt < backgroundStartupTimeout) {
          console.info("Retry requested. Background sync will retry failed uploads and drain the queue.");
          return;
        }
        const outcome = await attemptRetry(writer, current, token, id, AbortSignal.timeout(30_000));
        if (outcome === "offline") throw new Error("Tideline is unavailable. Uploads remain queued for the next sync or retry.");
        if (outcome === "interrupted") throw new Error("Retry paused after 30 seconds. Run tideline sync retry again or start sync to continue.");
      }
      const counts = writer.counts();
      const failed = counts.get("failed") ?? 0;
      console.info(`Retry complete. Received: ${counts.get("received") ?? 0}. Still failed: ${failed}.`);
      if (failed) {
        console.info("Run tideline sync status for failure details. Retry can recover only sessions still available in approved projects.");
        process.exitCode = 1;
      }
    } finally {
      writer.close();
    }
  } finally {
    control.close();
  }
}

export async function runSync({ backgroundId }: { backgroundId?: string } = {}) {
  const storage = await openCollectorStorage(backgroundId);
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let exitPhase: "stopped" | "failed" = "failed";
  let monitor: ReturnType<typeof setInterval> | undefined;
  try {
    if (!backgroundId && !storage.prepareForeground()) throw new Error("Background sync is starting. Check tideline sync status.");
    const config = requireSetup(storage);
    if (!config.projects.length) throw new Error("Choose repositories with tideline enable before starting sync.");
    const token = await loadActiveSyncToken(storage, config);
    if (backgroundId) {
      if (!storage.activateBackground(backgroundId)) return;
      monitor = setInterval(() => {
        if (!storage.backgroundIsRunning(backgroundId)) stop();
      }, 200);
    }
    const names = [sessionSourceLabel.codex, sessionSourceLabel["claude-code"]];
    if (config.cursorRoot) names.push(sessionSourceLabel.cursor);
    if (config.openCodeRoot) names.push(sessionSourceLabel.opencode);
    console.info(`Watching new sessions from ${names.join(", ")}. Press Ctrl+C to stop.`);
    let observed = new Map<string, ObservedFile>();
    const databases = new Map<string, ObservedDatabase>();
    let nextRetryAt = 0;
    let retryDelay = 2_000;
    let observedRetry: string | undefined;
    let offline = false;
    let queueFull = false;
    let inaccessible = false;
    let unavailableProjects = new Set<string>();
    while (!stopping.signal.aborted) {
      if (Date.now() >= Date.parse(config.expiresAt)) {
        throw new Error("Tideline sync authorization expired. Run tideline sync revoke and set it up again.");
      }

      const missing = await Promise.all(config.projects.map(async ({ directory }) =>
        await readPhysicalDirectory(directory) === directory ? undefined : directory));
      const unavailable = new Set(missing.filter((directory) => directory !== undefined));
      if ([...unavailable].some((directory) => !unavailableProjects.has(directory))) {
        console.warn("An approved project is unavailable. Its collection will resume when the folder returns.");
      }
      if ([...unavailableProjects].some((directory) => !unavailable.has(directory))) {
        observed.clear();
        databases.clear();
      }
      unavailableProjects = unavailable;
      const scan = await collectNewSessions(config, storage, observed, databases, stopping.signal);
      observed = scan.observed;
      if (scan.full && !queueFull) console.warn("The local queue is full. Discovery will catch up from the agent files once uploads resume.");
      queueFull = scan.full;
      if (scan.inaccessible && !inaccessible) console.warn("Some agent session files or folders are inaccessible. Sync will retry them.");
      inaccessible = scan.inaccessible;

      const requested = storage.requestedRetry(config.account);
      if (requested && requested !== observedRetry) nextRetryAt = 0;
      observedRetry = requested;
      if (Date.now() >= nextRetryAt) {
        const reachable = requested
          ? await attemptRetry(storage, config, token, requested, stopping.signal) !== "offline"
          : await sendPending(storage, config, token, stopping.signal);
        if (reachable) {
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
    exitPhase = "stopped";
  } finally {
    if (monitor) clearInterval(monitor);
    if (backgroundId) storage.finishBackground(backgroundId, exitPhase);
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
    for (const { directory, since } of config.projects) {
      console.info(`Project: ${terminalText(directory)} (${since === historyStart ? "includes older sessions" : `new sessions since ${since}`})`);
    }
    console.info(`Background sync: ${await readBackgroundStatus(storage)}.`);
    if (!config.cursorRoot) {
      console.info("To include Cursor and OpenCode, run tideline sync revoke, then set up sync again.");
    }
    console.info(config.revoked ? "Approval revoked." : `Approval expires: ${config.expiresAt}`);
    console.info(`Queued: ${counts.get("queued") ?? 0}. Received: ${counts.get("received") ?? 0}. Failed: ${counts.get("failed") ?? 0}.`);
    for (const { httpStatus, count } of storage.failureCounts()) {
      console.info(`${httpStatus === null ? "Unknown failure" : `HTTP ${httpStatus}`}: ${count}`);
    }
  } finally {
    storage.close();
  }
}

export async function revokeSync() {
  await stopBackgroundSync({ quiet: true });
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
