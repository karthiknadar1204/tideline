import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { healthResponse, sessionSourceLabel, syncEnrollmentRequest } from "@tideline/contracts";
import { CliLoginRequired, readAccountStatus } from "./cli-account";
import { checkClerkDevice, readJson, requestTideline, tidelineApiOrigin } from "./login";
import { readBackgroundStatus } from "./sync-background";
import { databaseSources, fileSources } from "./sync-sources";
import { withSelectedCollector } from "./sync-workspaces";
import { loadSyncCredential, openSyncStorage, SyncSetupMissingError } from "./sync-storage";

type Check = { name: string; status: "ok" | "warning" | "error"; detail: string };

async function collectorStatus() {
  const storage = await openSyncStorage().catch((error) => {
    if (!(error instanceof SyncSetupMissingError)) throw error;
  });
  if (!storage) return;
  try {
    const config = storage.config();
    if (!config) return;
    const counts = storage.counts();
    return {
      config,
      directory: storage.directory,
      background: await readBackgroundStatus(storage),
      counts: { queued: counts.get("queued") ?? 0, received: counts.get("received") ?? 0, failed: counts.get("failed") ?? 0 },
      failures: storage.failureCounts(),
    };
  } finally {
    storage.close();
  }
}

export async function whoami({ json }: { json?: boolean }) {
  const status = await readAccountStatus();
  const collector = await withSelectedCollector(status.workspaceId, collectorStatus);
  const uploads = collector?.config.workspaceId === status.workspaceId &&
    collector.config.apiOrigin === tidelineApiOrigin() ? { ...collector.counts, failures: collector.failures } : null;
  if (json) {
    console.info(JSON.stringify({ ...status, uploads }));
    return;
  }
  console.info(`Signed in as ${status.account.userId}`);
  console.info(`Workspace: ${status.workspaceId === status.account.workspace.id ? status.account.workspace.name : "Selected workspace"} (${status.workspaceId})`);
  console.info(`Approval expires: ${status.expiresAt}`);
  if (!uploads) {
    if (collector) console.info("The local collector is configured for a different workspace or API origin.");
    return;
  }
  console.info(`Uploads: ${uploads.queued} queued, ${uploads.received} received, ${uploads.failed} failed.`);
  for (const { httpStatus, count } of uploads.failures) {
    console.info(`  ${count} ${httpStatus ? `HTTP ${httpStatus}` : "without a recorded reason"}`);
  }
}

async function probe(name: string, inspect: () => Promise<string>, fallback: string): Promise<Check> {
  try {
    return { name, status: "ok", detail: await inspect() };
  } catch {
    return { name, status: "error", detail: fallback };
  }
}

async function accountCheck(): Promise<Check> {
  const name = "CLI account";
  try {
    const { account } = await readAccountStatus();
    return { name, status: "ok", detail: `Signed in to ${account.workspace.name}.` };
  } catch (error) {
    if (error instanceof CliLoginRequired) return { name, status: "warning", detail: "Run tideline login to approve this CLI." };
    return { name, status: "error", detail: "Could not verify the saved account. Check the API origin and connection." };
  }
}

async function inspectCollector(): Promise<Check[]> {
  const name = "Sync setup";
  const collector = await collectorStatus();
  if (!collector) return [{ name, status: "warning", detail: "Run tideline sync setup to choose repositories." }];
  const { config, background, counts, directory } = collector;
  const currentOrigin = tidelineApiOrigin();
  const valid = config.apiOrigin === currentOrigin && !config.revoked && Date.now() < Date.parse(config.expiresAt);
  const checks: Check[] = [
    valid ? { name, status: "ok", detail: `${config.projects.length} approved ${config.projects.length === 1 ? "folder" : "folders"}.` }
      : { name, status: "error", detail: "Check the configured API origin or renew sync approval." },
    { name: "Background sync", status: background === "Running" ? "ok" : "warning", detail: background },
    {
      name: "Upload queue", status: counts.failed || counts.queued ? "warning" : "ok",
      detail: `${counts.queued} queued, ${counts.received} received, ${counts.failed} failed.${counts.failed ? " Run tideline sync retry." : ""}`,
    },
  ];
  if (valid) {
    checks.push(await probe("Sync credential", async () => {
      const token = await loadSyncCredential(directory, config);
      const response = await requestTideline({ apiOrigin: currentOrigin, path: "/v1/cli/sync/status", method: "GET", accessToken: token });
      const verified = syncEnrollmentRequest.safeParse(response?.ok ? await readJson(response) : null);
      if (!verified.success || verified.data.workspaceId !== config.workspaceId) throw new Error();
      return "Upload approval is active.";
    }, "Could not verify upload approval. Check the API or set up sync again."));
  }
  const roots = [...fileSources(config), ...databaseSources(config)];
  for (const source of new Set(roots.map(({ source }) => source))) {
    const locations = roots.filter((entry) => entry.source === source).flatMap(({ root }) => root ? [root] : []);
    const present = await Promise.all(locations.map(async (root) =>
      await realpath(root).catch(() => undefined) === root &&
      await lstat(root).then((entry) => entry.isDirectory() || entry.isFile(), () => false),
    ));
    const available = present.some(Boolean);
    checks.push({
      name: sessionSourceLabel[source], status: available ? "ok" : "warning",
      detail: available ? "Local storage found." : "Local storage is unavailable for this setup.",
    });
  }
  return checks;
}

export async function doctor({ json }: { json?: boolean }) {
  const [api, clerk, git, sqlite, account, collector] = await Promise.all([
    probe("Tideline API", async () => {
      const origin = tidelineApiOrigin();
      const response = await requestTideline({ apiOrigin: origin, path: "/health", method: "GET" });
      if (!response?.ok || !healthResponse.safeParse(await readJson(response)).success) throw new Error();
      return `Reachable at ${origin}.`;
    }, "Check TIDELINE_API_URL and the API connection."),
    probe("Browser approval", async () => {
      await checkClerkDevice();
      return "Clerk device authorization is available.";
    }, "Check TIDELINE_CLERK_ISSUER and TIDELINE_CLERK_OAUTH_CLIENT_ID."),
    probe("Git", async () => (await promisify(execFile)("git", ["--version"], { timeout: 2_000 })).stdout.trim(),
      "Install Git to detect repositories and worktrees."),
    probe("SQLite", async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const sqlite = new DatabaseSync(":memory:");
      sqlite.close();
      return "Available.";
    }, "Use Bun or Node.js 22.13 or later for sync and queries."),
    accountCheck(),
    inspectCollector().catch((): Check[] => [{ name: "Sync setup", status: "error", detail: "Could not read local sync settings. Check the storage directory and its permissions." }]),
  ]);
  const checks = [api, clerk, git, sqlite, account, ...collector];
  const ok = checks.every(({ status }) => status !== "error");
  if (json) console.info(JSON.stringify({ ok, checks }));
  else for (const check of checks) console.info(`${check.status.toUpperCase().padEnd(7)} ${check.name}   ${check.detail}`);
  if (!ok) process.exitCode = 1;
}
