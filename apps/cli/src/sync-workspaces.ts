import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { workspaceResponse } from "@tideline/contracts";
import { tidelineApiOrigin } from "./login";
import { terminalText } from "./sync-projects";
import { isWithin } from "./sync-sources";
import {
  collectorWorkspace, ensureSyncDirectory, openPrivateDatabase, openSyncStorage, SyncSetupMissingError, syncDirectoryPath, withCollectorWorkspace,
} from "./sync-storage";
import type { ApprovedProject, SyncConfig } from "./sync-storage";

function workspaceId(value: string) {
  const workspace = workspaceResponse.shape.id.safeParse(value.toLowerCase()).data;
  if (!workspace) throw new Error("Set --workspace to the destination workspace UUID.");
  return workspace;
}

async function readConfig() {
  const storage = await openSyncStorage().catch((error: unknown) => {
    if (!(error instanceof SyncSetupMissingError)) throw error;
  });
  if (!storage) return;
  try {
    return storage.config();
  } finally {
    storage.close();
  }
}

export async function withSelectedCollector<T>(requested: string | undefined, work: () => Promise<T>, { setup = false } = {}) {
  if (requested === undefined) {
    if (!collectorWorkspace() && !await readConfig() && (await readLocalCollectors()).length) {
      throw new Error("Choose a collector with --workspace. Run tideline sync workspaces to see your local setups.");
    }
    return work();
  }
  const workspace = workspaceId(requested);
  const original = await withCollectorWorkspace(undefined, readConfig);
  const profile = await withCollectorWorkspace(workspace, readConfig);
  if (original?.workspaceId === workspace && profile) throw new Error("This workspace has multiple local collector configs.");
  if (original?.workspaceId === workspace || (setup && !original && !profile && (await readLocalCollectors()).length === 0)) {
    return withCollectorWorkspace(undefined, work);
  }
  return withCollectorWorkspace(workspace, work);
}

export async function readLocalCollectors(): Promise<{ workspace?: string; config: SyncConfig }[]> {
  try {
    await ensureSyncDirectory(false);
  } catch (error) {
    if (error instanceof SyncSetupMissingError) return [];
    throw error;
  }
  const directory = join(syncDirectoryPath(), "workspaces");
  const scoped = await lstat(directory).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
  if (scoped && (!scoped.isDirectory() || (process.getuid && scoped.uid !== process.getuid()) || (scoped.mode & 0o077) !== 0)) {
    throw new Error("Tideline workspace collector storage must be private.");
  }
  const profiles = scoped ? (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && workspaceResponse.shape.id.safeParse(entry.name).success)
    .map(({ name }) => name).sort() : [];
  const routes = await Promise.all([undefined, ...profiles].map(async (workspace) => {
    const config = await withCollectorWorkspace(workspace, readConfig);
    return config ? [{ workspace, config }] : [];
  }));
  return routes.flat();
}

export async function withCollectorSetupLock<T>(work: () => Promise<T>) {
  const lock = await openPrivateDatabase(await ensureSyncDirectory(true), "sync-workspaces-lock.sqlite", true);
  try {
    lock.exec("PRAGMA busy_timeout = 1000");
    try {
      lock.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (!(error instanceof Error && "errcode" in error && typeof error.errcode === "number" && [5, 6].includes(error.errcode & 0xff))) throw error;
      throw new Error("Another Tideline command is updating workspace routing. Try again in a moment.");
    }
    return await work();
  } finally {
    lock.close();
  }
}

export async function requireExclusiveProjects(projects: Pick<ApprovedProject, "directory" | "git">[]) {
  for (const { workspace, config } of await readLocalCollectors()) {
    if (workspace === collectorWorkspace() || config.revoked || Date.now() >= Date.parse(config.expiresAt)) continue;
    for (const project of projects) {
      const conflict = config.projects.some((prior) =>
        isWithin(prior.directory, project.directory) || isWithin(project.directory, prior.directory) ||
        (project.git && prior.git?.common === project.git.common),
      );
      if (conflict) {
        throw new Error(`${terminalText(project.directory)} is already routed to workspace ${config.workspaceId}. Remove it there before routing it here.`);
      }
    }
  }
}

export async function listSyncWorkspaces({ json }: { json?: boolean }) {
  const api = tidelineApiOrigin();
  const routes = (await readLocalCollectors()).filter(({ config }) => config.apiOrigin === api)
    .map(({ config }) => ({
      workspaceId: config.workspaceId,
      projects: config.projects.map(({ directory }) => directory),
      active: !config.revoked && Date.now() < Date.parse(config.expiresAt),
    }));
  if (json) {
    console.info(JSON.stringify(routes));
    return;
  }
  if (!routes.length) console.info("No workspaces have a local sync setup.");
  for (const { workspaceId, projects, active } of routes) {
    console.info(`Workspace ${workspaceId}${active ? "" : " (approval inactive)"}`);
    for (const directory of projects) console.info(`  ${terminalText(directory)}`);
  }
}
