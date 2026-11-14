import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tidelineApiOrigin } from "./login";
import { backgroundStartupTimeout, openSyncStorage, SyncLockError, SyncSetupMissingError } from "./sync-storage";

type Storage = Awaited<ReturnType<typeof openSyncStorage>>;

export async function openCollectorStorage(backgroundId?: string) {
  if (!backgroundId) return openSyncStorage({ lock: true });
  const deadline = performance.now() + backgroundStartupTimeout;
  for (;;) {
    try {
      return await openSyncStorage({ lock: true });
    } catch (error) {
      if (!(error instanceof SyncLockError) || performance.now() >= deadline) throw error;
      const storage = await openSyncStorage();
      try {
        const run = storage.background();
        if (run?.id !== backgroundId || run.phase !== "starting") throw error;
      } finally {
        storage.close();
      }
      await delay(50);
    }
  }
}

export async function readBackgroundStatus(storage: Storage) {
  const run = storage.background();
  if (!run || run.phase === "stopped") return "Stopped";
  if (run.phase === "starting") {
    return Date.now() - run.startedAt < backgroundStartupTimeout ? "Starting" : "Start interrupted";
  }
  if (run.phase === "failed") return "Exited with an error. Run tideline sync run for details";
  if (!await storage.collectorLockHeld()) return run.phase === "stopping" ? "Stopped" : "Exited unexpectedly";
  return run.phase === "running" ? "Running" : "Stopping";
}

export async function startBackgroundSync() {
  const id = randomUUID();
  const entry = process.argv[1] && await realpath(process.argv[1]);
  if (!entry) throw new Error("Run background sync from the Tideline CLI executable.");

  const storage = await openSyncStorage();
  try {
    const config = storage.config();
    if (!config) throw new SyncSetupMissingError("Set up Tideline sync first with tideline sync setup.");
    if (!config.projects.length) throw new Error("Choose repositories with tideline enable before starting sync.");
    if (config.apiOrigin !== tidelineApiOrigin()) throw new Error("TIDELINE_API_URL differs from the approved sync destination.");
    if (config.revoked || Date.now() >= Date.parse(config.expiresAt)) {
      throw new Error("Tideline sync authorization expired. Run tideline sync revoke and set it up again.");
    }

    const locked = await openSyncStorage({ lock: true }).catch((error) => {
      if (!(error instanceof SyncLockError)) throw error;
    });
    if (!locked) {
      if (storage.background()?.phase === "running") {
        console.info("Background sync is already running.");
        return;
      }
      throw new Error("Another sync command is active. Check tideline sync status.");
    }
    try {
      if (locked.config()?.account !== config.account) throw new Error("Sync setup changed. Run tideline sync start again.");
      const run = locked.background();
      if (run?.phase === "starting" && Date.now() - run.startedAt < backgroundStartupTimeout) {
        throw new Error("Background sync is already starting. Check tideline sync status.");
      }
      locked.reserveBackground(id);
    } finally {
      locked.close();
    }

    const child = spawn(process.execPath, [entry, "sync", "run", "--background-id", id], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, TIDELINE_SYNC_HOME: storage.directory },
    });
    let exited = false;
    child.once("error", () => { exited = true; });
    child.once("exit", () => { exited = true; });
    try {
      const deadline = performance.now() + backgroundStartupTimeout;
      while (!exited && performance.now() < deadline) {
        const run = storage.background();
        if (run?.id !== id || run.phase !== "starting") {
          if (run?.id === id && run.phase === "running" && await storage.collectorLockHeld()) {
            console.info("Background sync is running. Use tideline sync status to check progress.");
            return;
          }
          break;
        }
        await delay(50);
      }
      throw new Error("Background sync could not start. Run tideline sync run for details.");
    } catch (error) {
      if (!exited) child.kill("SIGTERM");
      storage.finishBackground(id, "failed");
      throw error;
    } finally {
      child.unref();
    }
  } finally {
    storage.close();
  }
}

export async function stopBackgroundSync({ quiet = false }: { quiet?: boolean } = {}) {
  const storage = await openSyncStorage().catch((error) => {
    if (!quiet || !(error instanceof SyncSetupMissingError)) throw error;
  });
  if (!storage) return;
  try {
    const run = storage.background();
    if (run && run.phase !== "stopped" && run.phase !== "failed") {
      storage.requestBackgroundStop(run.id);
      const deadline = performance.now() + 15_000;
      while (storage.background()?.id === run.id && await storage.collectorLockHeld()) {
        if (performance.now() >= deadline) throw new Error("Background sync is still stopping. Check tideline sync status.");
        await delay(100);
      }
      storage.finishBackground(run.id, "stopped");
    }
    if (!quiet) console.info("Background sync is stopped.");
  } finally {
    storage.close();
  }
}
