import { createTranscriptSync } from "./full-transcript";
import type { LocatedSubagents } from "./full-transcript";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { createGitHubActivitySync, readGitHubRepository } from "./github-activity";
import { approveInBrowser, postToTideline, readJson, tidelineApiOrigin, tidelineWebOrigin } from "./login";
import { readRepository } from "./repository";
import { createRepositoryInstructionSync } from "./repository-instructions";
import { redactConversationText } from "./session-safety";
import type { LiveSession, SessionCandidate } from "./session-jsonl";
import { openSetupConnection } from "./setup-connection";
import type { SetupConnection } from "./setup-connection";
import { openCollectorStorage, readBackgroundStatus, startBackgroundSync, stopBackgroundSync } from "./sync-background";
import { syncAutostart } from "./sync-autostart";
import { createSessionInventory } from "./sync-inventory";
import { chooseProjects, createApprovedScope, explicitProjects, historyStart, sameCheckout, terminalText } from "./sync-projects";
import { configuredAgentRoots, createCodexSubagentIndex, databaseSources, databaseVersion, fileSources, isInaccessible, isWithin, readPhysicalDirectory, sessionFiles } from "./sync-sources";
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
import { watchCollectorWake } from "./sync-wake";

type SetupOptions = {
  workspace?: string;
  project?: string[];
  history?: boolean;
  background?: boolean;
  hooks?: boolean;
  conversations?: boolean;
  sessionDetails?: boolean;
  fullTranscripts?: boolean;
  subagentTranscripts?: boolean;
  repositoryInstructions?: boolean;
  repositoryContext?: boolean;
  githubActivity?: boolean;
  browser: boolean;
  credentialFile?: boolean;
  onboarding?: boolean;
  code?: string;
};

const syncRoutes = {
  enroll: "/v1/cli/sync/enroll?includeUser=1",
  sessions: "/v1/cli/sync/sessions",
  revoke: "/v1/cli/sync/revoke",
};

async function readCurrentSetup() {
  const storage = await openSyncStorage().catch((error) => {
    if (!(error instanceof SyncSetupMissingError)) throw error;
  });
  if (!storage) return;
  try {
    return { config: storage.config(), received: storage.receivedSessionKeys() };
  } finally {
    storage.close();
  }
}

async function enrollSync(storage: Storage, options: SetupOptions, settings: Omit<SyncConfig, "workspaceId" | "expiresAt" | "userId">, approvedToken?: string) {
  const accessToken = approvedToken ?? await approveInBrowser(options.browser);
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

  const config = { ...settings, workspaceId, expiresAt: enrollment.data.expiresAt, userId: enrollment.data.userId };
  try {
    await storeSyncCredential(storage.directory, config, enrollment.data.token);
    storage.saveConfig(config);
  } catch {
    await postToTideline({ apiOrigin: settings.apiOrigin, path: syncRoutes.revoke, accessToken: enrollment.data.token });
    await deleteSyncCredential(storage.directory, config).catch(() => {});
    throw new Error("Tideline could not save sync setup. Check access to the credential store and try again.");
  }
  return workspaceId;
}

export async function setupSync(options: SetupOptions) {
  if (options.code === undefined) return configureSync(options);
  if (options.workspace !== undefined) throw new Error("Use the browser setup code by itself to select a workspace.");
  if (process.platform === "win32") throw new Error("Tideline automatic sync currently requires macOS or Linux.");
  const connection = await openSetupConnection(tidelineApiOrigin(), options.code);
  try {
    await configureSync({ ...options, workspace: connection.workspaceId }, connection);
  } catch (error) {
    await connection.update({ phase: "failed" });
    throw error;
  }
}

async function configureSync(options: SetupOptions, connection?: SetupConnection) {
  if (options.workspace !== undefined && !syncEnrollmentRequest.shape.workspaceId.safeParse(options.workspace).success) {
    throw new Error("Set --workspace to the destination workspace UUID.");
  }
  if (process.platform === "win32") throw new Error("Tideline automatic sync currently requires macOS or Linux.");
  const existingSetup = await readCurrentSetup();
  const previous = existingSetup?.config;
  const apiOrigin = tidelineApiOrigin();
  const webOrigin = options.onboarding ? tidelineWebOrigin() : undefined;
  if (!options.workspace && !previous) {
    const { approvedWorkspaceDefault } = await import("./cli-account");
    options = { ...options, workspace: await approvedWorkspaceDefault() };
  }
  if (previous && (previous.apiOrigin !== apiOrigin || (options.workspace && options.workspace !== previous.workspaceId) ||
      previous.revoked || Date.now() >= Date.parse(previous.expiresAt))) {
    throw new Error("Revoke this collector before changing its workspace or renewing its approval.");
  }
  const useLocalCredential = options.onboarding && process.platform !== "darwin";
  const credentialFile = options.credentialFile || useLocalCredential;
  if (!previous && !credentialFile && process.platform !== "darwin") {
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
    sessionDetails: options.sessionDetails ?? previous?.sessionDetails ?? false,
    subagentTranscripts: options.subagentTranscripts ?? previous?.subagentTranscripts ?? false,
  } : await chooseProjects(roots, previous?.projects ?? [], {
    ...options,
    fullTranscripts: options.fullTranscripts ?? previous?.fullTranscripts,
    previousSessionDetails: previous?.sessionDetails,
    previousSubagentTranscripts: previous?.subagentTranscripts,
    received: existingSetup?.received,
    allowEmpty: Boolean(previous) && !connection,
    onDiscovered: connection && (async (repositoriesFound, localSessionsFound) => {
      await connection.update({ phase: "choosing", repositoriesFound, localSessionsFound });
    }),
  });
  if (!selection) {
    await connection?.update({ phase: "cancelled" });
    console.info("Setup canceled.");
    return;
  }
  const fullTranscripts = (options.fullTranscripts ?? previous?.fullTranscripts) || undefined;
  const repositoryInstructions = (options.repositoryInstructions ?? previous?.repositoryInstructions) || undefined;
  const repositoryContext = (options.repositoryContext ?? previous?.repositoryContext) || undefined;
  if (options.subagentTranscripts && !selection.sessionDetails) {
    throw new Error("Enable --session-details to include subagent conversations.");
  }
  const subagentTranscripts = (selection.sessionDetails && selection.subagentTranscripts) || undefined;
  let approvedToken: string | undefined;
  if (connection) {
    if (!await connection.update({ phase: "approving", checkoutsSelected: selection.projects.length, history: selection.history })) {
      throw new Error("This setup connection expired or became unavailable. Copy a fresh command from Tideline.");
    }
    console.info("Approve with the account that opened this setup page.");
    const approval = await connection.approve(options.browser);
    if (previous && previous.userId !== approval.userId) {
      throw new Error("This collector was set up with a different account or an older CLI. Revoke it before pairing again.");
    }
    approvedToken = approval.accessToken;
  }

  if (previous) await stopBackgroundSync({ quiet: true });
  const storage = await openSyncStorage({ lock: true, create: true });
  let workspaceId: string;
  try {
    if (JSON.stringify(storage.config()) !== JSON.stringify(previous)) throw new Error("Sync setup changed. Run tideline sync setup again.");
    const now = new Date().toISOString();
    const retained = previous?.projects.filter((prior) => selection.projects.some((project) => sameCheckout(prior, project))) ?? [];
    const retainedByPath = new Map(retained.map((project) => [project.directory, project]));
    const projects = await Promise.all(selection.projects.map(async (project) => {
      const retained = retainedByPath.get(project.directory);
      const githubRepository = options.githubActivity === undefined ? retained?.githubRepository :
        options.githubActivity && project.git ? await readGitHubRepository(project.directory) : undefined;
      return { ...project, since: selection.history ? historyStart : retained?.since ?? now, githubRepository };
    }));
    if (previous) {
      const removed = previous.projects.filter((prior) => !retained.includes(prior));
      storage.updateProjects({ ...previous, projects, codexArchiveRoot: roots.codexArchiveRoot, sessionDetails: selection.sessionDetails || undefined,
        repositoryInstructions, repositoryContext, fullTranscripts, subagentTranscripts }, removed);
      workspaceId = previous.workspaceId;
      if (!projects.length) {
        const token = await loadActiveSyncToken(storage, previous).catch(() => null);
        if (token) await createSessionInventory({ ...previous, projects })(token, AbortSignal.timeout(4_000));
      }
    } else {
      const sources = [sessionSourceLabel.codex, sessionSourceLabel["claude-code"], sessionSourceLabel.cursor];
      if (roots.openCodeRoot) sources.push(sessionSourceLabel.opencode);
      const destination = options.workspace ? `workspace ${options.workspace}` : "your personal workspace";
      console.info(`Syncing ${projects.length} ${projects.length === 1 ? "project" : "projects"} from ${sources.join(", ")} to ${destination} at ${apiOrigin}.`);
      if (selection.history) console.info("This approval includes older sessions.");
      if (useLocalCredential) console.info("Tideline will store the sync credential in an owner-only file on this computer.");
      if (options.onboarding && !connection) console.info("Sign in and approve this collector in your browser.");
      workspaceId = await enrollSync(storage, options, {
        apiOrigin, projects, startedAt: now, account: randomUUID(), credentialStore: credentialFile ? "file" : "keychain",
        codexRoot: roots.codexRoot, codexArchiveRoot: roots.codexArchiveRoot,
        claudeRoot: roots.claudeRoot, cursorRoot: roots.cursorRoot, openCodeRoot: roots.openCodeRoot,
        sessionDetails: selection.sessionDetails || undefined,
        subagentTranscripts,
        repositoryInstructions, repositoryContext, fullTranscripts,
      }, approvedToken);
    }
  } finally {
    storage.close();
  }
  if (!selection.projects.length) {
    console.info("Uploads are paused. Run tideline enable to choose repositories again.");
    return;
  }
  if (selection.sessionDetails) console.info("Session details are enabled for Codex and Claude Code.");
  if (options.hooks) {
    const { configureNativeHooks } = await import("./native-hooks");
    await configureNativeHooks("install").catch((error: unknown) => {
      console.warn(`Hooks could not be installed. Sync can still run. ${error instanceof Error ? error.message : "Run tideline hooks install to retry."}`);
    });
  }
  if (subagentTranscripts) console.info("Redacted subagent conversations are enabled for Codex and Claude Code.");
  if (fullTranscripts) console.info("Full transcripts and recorded image attachments are enabled for Codex and Claude Code.");
  if (repositoryInstructions) console.info("Redacted repository instruction snapshots are enabled for the selected Git checkouts.");
  if (repositoryContext) console.info("Repository context is enabled for selected Git checkouts. Skill and agent text is redacted. Configs and skill resources include file metadata.");
  if (options.githubActivity) console.info("GitHub activity is enabled for selected checkouts with a github.com origin. Run gh auth login if needed.");
  if (selection.background) await startBackgroundSync();
  else console.info("Sync is set up. Run tideline sync start in the background or tideline sync run in this terminal.");
  if (connection && !await connection.update({ phase: "ready", checkoutsSelected: selection.projects.length, background: selection.background })) {
    console.warn("Sync setup succeeded. The browser setup page could not be updated.");
  }

  if (webOrigin) {
    console.info(`Open your dashboard at ${new URL(`/workspace/${workspaceId}/dashboard`, webOrigin).href}`);
    console.info("Sessions appear in the dashboard after they finish syncing.");
    if (!selection.history) console.info("Start a new agent session in a selected repository to see it there.");
  }
}

class SyncApprovalError extends Error {}

function requireSetup(storage: Awaited<ReturnType<typeof openSyncStorage>>) {
  const config = storage.config();
  if (!config) throw new SyncSetupMissingError("Set up Tideline sync first with tideline sync setup.");
  if (config.apiOrigin !== tidelineApiOrigin()) {
    throw new Error("TIDELINE_API_URL differs from the approved sync destination.");
  }
  return config;
}

type Storage = Awaited<ReturnType<typeof openSyncStorage>>;
type SourceReader = ReturnType<typeof fileSources>[number]["read"];
type ObservedFile = {
  version: string;
  retryAt?: number;
  sidecar?: NonNullable<LiveSession["sidecarRevision"]> & { reconcileAt: number };
  rawSubagents?: LocatedSubagents;
};
function* observedSubagents(observed: Map<string, ObservedFile>) {
  for (const { rawSubagents } of observed.values()) if (rawSubagents) yield rawSubagents;
}
const sidecarInterval = 10_000;
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
  codexSubagents: ReturnType<typeof createCodexSubagentIndex> | undefined,
  signal: AbortSignal,
  retry?: UploadRetry,
) {
  const scope = createApprovedScope(config.projects);
  await codexSubagents?.refresh(signal);
  const options = {
    live: true as const,
    captureDetails: config.sessionDetails,
    transcriptPreview: config.fullTranscripts,
    captureSubagents: config.subagentTranscripts,
    findCodexSubagent: codexSubagents?.find,
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

    const { capture, ...projection } = result.session;
    const upload = {
      version: 1, workspaceId: config.workspaceId,
      session: {
        ...projection, source,
        analytics: analytics && { ...analytics, repository: repositories.get(project) ?? null },
        review,
        events: result.session.events.map((event) => ({ ...event, text: redactConversationText(event.text) })),
      },
    };
    const candidate = sessionImportRequest.safeParse(upload);
    if (!candidate.success) {
      console.warn(`${source}: skipped a session outside the supported message format or limits.`);
      return;
    }

    const baseBody = JSON.stringify(candidate.data);
    if (Buffer.byteLength(baseBody) > MAX_CODEX_IMPORT_BYTES) {
      console.warn(`${source}: a session exceeded the 1 MiB upload limit.`);
      return;
    }
    const expanded = config.sessionDetails && capture
      ? sessionImportRequest.safeParse({ ...candidate.data, session: { ...candidate.data.session, capture } })
      : undefined;
    if (expanded && !expanded.success) {
      console.warn(`${source}: synced the conversation without session details outside the supported format or limits.`);
    }
    const data = expanded?.success ? expanded.data : candidate.data;
    const session = data.session;
    const lastMessage = session.events.at(-1);
    if (!lastMessage) return;
    const body = expanded?.success ? JSON.stringify(data) : baseBody;

    const phase = storage.queue({
      sessionKey: sessionKey(session),
      projectDirectory,
      fingerprint: createHash("sha256").update(body).digest("hex"),
      messageCount: session.events.length,
      tailLine: Math.max(lastMessage.line, session.analytics?.throughLine ?? 0, session.activity?.throughLine ?? 0,
        session.review?.throughLine ?? 0, session.capture?.throughLine ?? 0),
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
      const sidecar = previous.sidecar;
      if (!sidecar || sidecar.reconcileAt > Date.now()) {
        nextObserved.set(path, previous);
        return;
      }
      if (await sidecar.read() === sidecar.value) {
        nextObserved.set(path, { ...previous, sidecar: { ...sidecar, reconcileAt: Date.now() + sidecarInterval } });
        return;
      }
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

    const sidecar = result?.sidecarRevision;
    const streams = result?.rawSubagents;
    const rawSubagents = streams?.length && result ? {
      sourceSessionId: result.session.sourceSessionId, projectDirectory: result.projectDirectory, streams,
    } : undefined;
    nextObserved.set(path, { version, retryAt: retryProject ? Date.now() + 30_000 : undefined,
      sidecar: sidecar && { ...sidecar, reconcileAt: Date.now() + sidecarInterval }, rawSubagents });
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
      throw new SyncApprovalError("Tideline sync authorization expired or was revoked. Run tideline sync revoke and set it up again.");
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
    throw new SyncApprovalError("Tideline sync authorization expired. Run tideline sync revoke and set it up again.");
  }
  return loadSyncCredential(storage.directory, config);
}

async function attemptRetry(storage: Storage, config: SyncConfig, token: string, id: string, signal: AbortSignal) {
  let observed = new Map<string, ObservedFile>();
  const databases = new Map<string, ObservedDatabase>();
  const codexSubagents = config.subagentTranscripts ? createCodexSubagentIndex(config) : undefined;
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
    const scan = await collectNewSessions(config, storage, observed, databases, codexSubagents, signal, { id, candidates });
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

export async function syncOnce() {
  const storage = await openSyncStorage({ lock: true });
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const config = requireSetup(storage);
    if (!config.projects.length) throw new Error("Choose repositories with tideline enable before starting sync.");
    const token = await loadActiveSyncToken(storage, config);
    let observed = new Map<string, ObservedFile>();
    const databases = new Map<string, ObservedDatabase>();
    const codexSubagents = config.subagentTranscripts ? createCodexSubagentIndex(config) : undefined;
    while (!stopping.signal.aborted) {
      const pending = storage.pending();
      if (pending.length) {
        if (!await sendPending(storage, config, token, stopping.signal, pending)) {
          throw new Error("Tideline is unavailable. Uploads remain queued for the next sync or retry.");
        }
        if (storage.pending().length) continue;
      }
      const scan = await collectNewSessions(config, storage, observed, databases, codexSubagents, stopping.signal);
      observed = scan.observed;
      if (!scan.full && !storage.pending().length) break;
    }
    if (stopping.signal.aborted) throw new Error("Sync was interrupted. Run tideline sync once to continue.");
    await createRepositoryInstructionSync(config)(token, stopping.signal);
    await createGitHubActivitySync(config, storage)(token, stopping.signal, true);
    await createSessionInventory(config)(token, stopping.signal).catch(() => {});
    const transcriptResult = await createTranscriptSync(config)(token, stopping.signal, observedSubagents(observed), true);
    if (transcriptResult?.deferredChildren) {
      console.warn("Some subagent transcripts are waiting for session processing. Run tideline sync once again to continue.");
    }
    const counts = storage.counts();
    const failed = counts.get("failed") ?? 0;
    console.info(`Sync complete. Received: ${counts.get("received") ?? 0}. Failed: ${failed}.`);
    if (failed) throw new Error("Some sessions could not sync. Run tideline sync status for details.");
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    storage.close();
  }
}

export async function runSync({ backgroundId, autostart }: { backgroundId?: string; autostart?: boolean } = {}) {
  try {
    await runCollector(backgroundId, autostart);
  } catch (error) {
    if (!autostart || !(error instanceof SyncApprovalError || error instanceof SyncSetupMissingError)) throw error;
    console.warn(error.message);
  }
}

async function runCollector(backgroundId?: string, autostart = false) {
  const storage = await openCollectorStorage(backgroundId);
  const stopping = new AbortController();
  const wake = watchCollectorWake(storage.directory);
  const stop = () => stopping.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let exitPhase: "stopped" | "failed" = "failed";
  let monitor: ReturnType<typeof setInterval> | undefined;
  let githubTask: Promise<void> | undefined;
  try {
    if (!backgroundId && !storage.prepareForeground()) throw new Error("Background sync is starting. Check tideline sync status.");
    const config = requireSetup(storage);
    if (!config.projects.length) {
      if (autostart) return;
      throw new Error("Choose repositories with tideline enable before starting sync.");
    }
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
    const codexSubagents = config.subagentTranscripts ? createCodexSubagentIndex(config) : undefined;
    let nextRetryAt = 0;
    let retryDelay = 2_000;
    let observedRetry: string | undefined;
    let offline = false;
    let queueFull = false;
    let inaccessible = false;
    let unavailableProjects = new Set<string>();
    const syncInstructions = createRepositoryInstructionSync(config);
    const syncGitHubActivity = createGitHubActivitySync(config, storage);
    const syncInventory = createSessionInventory(config);
    const syncTranscripts = createTranscriptSync(config);
    let transcriptTask: Promise<void> | undefined;
    let inventoryTask: Promise<void> | undefined;
    while (!stopping.signal.aborted) {
      if (Date.now() >= Date.parse(config.expiresAt)) {
        throw new SyncApprovalError("Tideline sync authorization expired. Run tideline sync revoke and set it up again.");
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
      const scan = await collectNewSessions(config, storage, observed, databases, codexSubagents, stopping.signal);
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
          await syncInstructions(token, stopping.signal);
          transcriptTask ??= syncTranscripts(token, stopping.signal, observedSubagents(observed))
            .then(() => {}, () => {
              if (!stopping.signal.aborted) console.warn("Transcript archives could not sync. Tideline will retry.");
            }).finally(() => { transcriptTask = undefined; });
          githubTask ??= syncGitHubActivity(token, stopping.signal).catch(() => {
            if (!stopping.signal.aborted) console.warn("GitHub activity could not sync.");
          }).finally(() => { githubTask = undefined; });
          inventoryTask ??= syncInventory(token, stopping.signal).catch(() => {}).finally(() => { inventoryTask = undefined; });
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

      await wake.wait(stopping.signal);
    }
    exitPhase = "stopped";
  } finally {
    stopping.abort();
    wake.close();
    await githubTask;
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
    for (const { directory, since, githubRepository } of config.projects) {
      const history = since === historyStart ? "includes older sessions" : `new sessions since ${since}`;
      console.info(`Project: ${terminalText(directory)} (${history}${githubRepository ? ", GitHub activity on" : ""})`);
    }
    console.info(`Background sync: ${await readBackgroundStatus(storage)}.`);
    console.info(`Full transcripts and images: ${config.fullTranscripts ? "on" : "off"}.`);
    console.info(`Session details: ${config.sessionDetails ? "on for Codex and Claude Code" : "off"}.`);
    console.info(`Subagent transcripts: ${config.subagentTranscripts ? "on for Codex and Claude Code" : "off"}.`);
    console.info(`Repository instruction snapshots: ${config.repositoryInstructions ? "on" : "off"}.`);
    console.info(`Expanded repository context: ${config.repositoryContext ? "on" : "off"}.`);
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
  await syncAutostart()?.disable();
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
