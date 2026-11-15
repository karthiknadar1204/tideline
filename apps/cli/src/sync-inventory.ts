import { MAX_INVENTORY_REPOSITORIES, MAX_INVENTORY_SESSIONS, type SyncInventoryUpload } from "@tideline/contracts";
import cliPackage from "../package.json";
import { postToTideline } from "./login";
import { readRepository } from "./repository";
import { createApprovedScope, discoverSessions } from "./sync-projects";
import type { SyncConfig } from "./sync-storage";

const snapshotInterval = 30 * 60_000;
const failureInterval = 60_000;

export function createSessionInventory(config: SyncConfig) {
  let nextRun = 0;
  return async (token: string, signal: AbortSignal) => {
    if (signal.aborted || Date.now() < nextRun) return;
    nextRun = Date.now() + failureInterval;
    const sessions = new Map<string, SyncInventoryUpload["sessions"][number]>();
    let partial = false;
    const enabled = process.env.TIDELINE_SESSION_INVENTORY !== "0";
    const scope = createApprovedScope(config.projects);
    const repositories = new Map<string, NonNullable<SyncInventoryUpload["repositorySettings"]>["rows"][number]>();
    let complete = true;
    if (enabled && config.projects.length) {
      for (const project of config.projects) {
        if (signal.aborted) return;
        if ("git" in project && project.git === null) continue;
        const verified = await scope.projectScope(project.directory);
        if (!verified) { complete = false; continue; }
        const repository = await readRepository(verified);
        if (!repository || repositories.has(repository.key)) continue;
        if (repositories.size === MAX_INVENTORY_REPOSITORIES) { complete = false; break; }
        repositories.set(repository.key, { ...repository, enabled: true });
      }
      for await (const { source, sourceSessionId, startedAt, projectDirectory } of discoverSessions(config, () => { partial = true; })) {
        if (signal.aborted) return;
        const directory = await scope.projectScope(projectDirectory);
        if (!directory || !scope.sessionAllowed({ startedAt, projectDirectory: directory })) continue;
        const key = `${source}:${sourceSessionId}`;
        if (sessions.has(key)) continue;
        if (sessions.size >= MAX_INVENTORY_SESSIONS) {
          partial = true;
          break;
        }
        sessions.set(key, { source, id: sourceSessionId, startedAt });
      }
    }
    const payload = enabled ? { workspaceId: config.workspaceId, version: cliPackage.version, partial, sessions: [...sessions.values()],
      repositorySettings: { complete, rows: [...repositories.values()] } }
      : { workspaceId: config.workspaceId, clear: true };
    const result = await postToTideline({ apiOrigin: config.apiOrigin, path: "/v1/cli/sync/inventory", accessToken: token,
      body: JSON.stringify(payload), signal });
    nextRun = Date.now() + (result?.ok || result?.status === 404 ? snapshotInterval : failureInterval);
  };
}
