import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { syncEnrollmentResponse } from "@tideline/contracts";
import { z } from "zod";

const execute = promisify(execFile);
const keychainService = "Tideline sync";
const maximumQueueBytes = 16 * 1_048_576;
export const backgroundStartupTimeout = 15_000;

const approvedProjectSchema = z.strictObject({
  directory: z.string().min(1),
  since: z.iso.datetime(),
  git: z.strictObject({ root: z.string().min(1), common: z.string().min(1) }).nullable().optional(),
});

const sharedConfig = z.strictObject({
  apiOrigin: z.url(),
  workspaceId: z.uuid(),
  userId: z.string().min(1).optional(),
  startedAt: z.iso.datetime(),
  expiresAt: syncEnrollmentResponse.shape.expiresAt,
  account: z.uuid(),
  credentialStore: z.enum(["file", "keychain"]),
  codexRoot: z.string().min(1),
  codexArchiveRoot: z.string().min(1).optional(),
  claudeRoot: z.string().min(1),
  cursorRoot: z.string().min(1).optional(),
  openCodeRoot: z.string().min(1).optional(),
  sessionDetails: z.boolean().optional(),
  revoked: z.boolean().optional(),
});

const configSchema = z.union([
  sharedConfig.extend({ projects: z.array(approvedProjectSchema) }),
  sharedConfig.extend({ projectDirectory: z.string().min(1) }).transform(({ projectDirectory, ...config }) => ({
    ...config,
    projects: [{ directory: projectDirectory, since: config.startedAt }],
  })),
]);

export type ApprovedProject = z.infer<typeof approvedProjectSchema>;
export type SyncConfig = z.infer<typeof configSchema>;

const backgroundRun = z.object({
  id: z.uuid(),
  phase: z.enum(["starting", "running", "stopping", "stopped", "failed"]),
  startedAt: z.int(),
});

export class SyncLockError extends Error {}
export class SyncSetupMissingError extends Error {}

function hasErrorCode(error: unknown, code: string | number) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isLocked(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR" &&
    "errcode" in error && typeof error.errcode === "number" && [5, 6].includes(error.errcode & 0xff);
}

async function checkPrivatePath(path: string, type: "directory" | "file") {
  const stats = await lstat(path);
  const expectedType = type === "directory" ? stats.isDirectory() : stats.isFile();
  if (!expectedType || (process.getuid && stats.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    throw new Error("Tideline sync storage must be owned by you and accessible only to you.");
  }
}

export async function openPrivateDatabase(directory: string, name: string, create: boolean) {
  const file = join(directory, name);
  if (create) {
    try {
      await writeFile(file, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
  }
  await checkPrivatePath(file, "file");
  const { DatabaseSync } = await import("node:sqlite").catch(() => {
    throw new Error("Sync needs Node.js 22.13 or later, or Bun.");
  });
  return new DatabaseSync(file);
}

export async function ensureSyncDirectory(create: boolean) {
  const directory = resolve(process.env.TIDELINE_SYNC_HOME ?? join(homedir(), ".tideline"));
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await checkPrivatePath(directory, "directory");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) throw new SyncSetupMissingError("Set up Tideline sync first with tideline sync setup.");
    throw error;
  }
  return directory;
}

export async function openSyncStorage({ lock = false, create = false } = {}) {
  const directory = await ensureSyncDirectory(create);

  const writer = lock ? await openPrivateDatabase(directory, "sync-lock.sqlite", true) : undefined;
  try {
    writer?.exec("BEGIN IMMEDIATE");
  } catch (error) {
    writer?.close();
    if (!isLocked(error)) throw error;
    throw new SyncLockError("Tideline sync is already running. Stop it before changing its setup.");
  }

  let db: DatabaseSync;
  try {
    db = await openPrivateDatabase(directory, "sync.sqlite", create);
  } catch (error) {
    writer?.close();
    if (hasErrorCode(error, "ENOENT")) throw new SyncSetupMissingError("Set up Tideline sync first with tideline sync setup.");
    throw error;
  }
  try {
    db.exec(`
      PRAGMA busy_timeout = 1000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS background (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('starting', 'running', 'stopping', 'stopped', 'failed')),
        started_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retry_request (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id TEXT NOT NULL,
        account TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uploads (
        session_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        tail_line INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('queued', 'received', 'failed')),
        body TEXT,
        queued_at INTEGER NOT NULL
      );
    `);
    if (writer && !db.prepare("SELECT 1 FROM pragma_table_info('uploads') WHERE name = 'projection'").get()) {
      db.exec("ALTER TABLE uploads ADD COLUMN projection INTEGER NOT NULL DEFAULT 1");
    }
    if (writer && !db.prepare("SELECT 1 FROM pragma_table_info('uploads') WHERE name = 'project_directory'").get()) {
      db.exec("ALTER TABLE uploads ADD COLUMN project_directory TEXT");
    }
    if (writer && !db.prepare("SELECT 1 FROM pragma_table_info('uploads') WHERE name = 'http_status'").get()) {
      db.exec("ALTER TABLE uploads ADD COLUMN http_status INTEGER");
    }
    if (writer && !db.prepare("SELECT 1 FROM pragma_table_info('uploads') WHERE name = 'retry_id'").get()) {
      db.exec("ALTER TABLE uploads ADD COLUMN retry_id TEXT");
    }
  } catch (error) {
    db.close();
    writer?.close();
    throw error;
  }

  return {
    directory,
    background() {
      const row = db.prepare("SELECT id, phase, started_at AS startedAt FROM background WHERE singleton = 1").get();
      return row && backgroundRun.parse(row);
    },
    reserveBackground(id: string) {
      db.prepare(`
        INSERT INTO background (singleton, id, phase, started_at) VALUES (1, ?, 'starting', ?)
        ON CONFLICT (singleton) DO UPDATE SET id = excluded.id, phase = excluded.phase, started_at = excluded.started_at
      `).run(id, Date.now());
    },
    activateBackground(id: string) {
      const result = db.prepare(`
        UPDATE background SET phase = 'running' WHERE id = ? AND phase = 'starting' AND started_at >= ?
      `).run(id, Date.now() - backgroundStartupTimeout);
      return Number(result.changes) === 1;
    },
    backgroundIsRunning(id: string) {
      return db.prepare("SELECT 1 FROM background WHERE id = ? AND phase = 'running'").get(id) !== undefined;
    },
    requestBackgroundStop(id: string) {
      db.prepare("UPDATE background SET phase = 'stopping' WHERE id = ? AND phase IN ('starting', 'running')").run(id);
    },
    finishBackground(id: string, phase: "stopped" | "failed") {
      db.prepare(`
        UPDATE background SET phase = CASE WHEN phase = 'stopping' THEN 'stopped' ELSE ? END
        WHERE id = ? AND phase IN ('starting', 'running', 'stopping')
      `).run(phase, id);
    },
    prepareForeground() {
      const row = db.prepare("SELECT started_at FROM background WHERE phase = 'starting'").get();
      if (row && Date.now() - Number(row.started_at) < backgroundStartupTimeout) return false;
      db.exec("DELETE FROM background");
      return true;
    },
    async collectorLockHeld() {
      const probe = await openPrivateDatabase(directory, "sync-lock.sqlite", false).catch((error) => {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      });
      if (!probe) return false;
      try {
        probe.exec("BEGIN IMMEDIATE");
        return false;
      } catch (error) {
        if (!isLocked(error)) throw error;
        return true;
      } finally {
        probe.close();
      }
    },
    config() {
      const row = db.prepare("SELECT value FROM config WHERE id = 1").get();
      return row ? configSchema.parse(JSON.parse(String(row.value))) : undefined;
    },
    saveConfig(config: SyncConfig) {
      db.prepare("INSERT INTO config (id, value) VALUES (1, ?)").run(JSON.stringify(config));
    },
    updateProjects(config: SyncConfig, removed: ApprovedProject[]) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (removed.length) {
          db.exec("DELETE FROM uploads WHERE phase <> 'received' AND project_directory IS NULL");
          const remove = db.prepare("DELETE FROM uploads WHERE phase <> 'received' AND project_directory = ?");
          for (const { directory } of removed) remove.run(directory);
        }
        if (!config.sessionDetails) {
          db.exec("DELETE FROM uploads WHERE phase = 'queued' AND json_type(body, '$.session.capture') IS NOT NULL");
        }
        db.prepare("UPDATE config SET value = ? WHERE id = 1").run(JSON.stringify(config));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    requestRetry(account: string, id: string) {
      const result = db.prepare(`
        INSERT INTO retry_request (singleton, id, account)
        SELECT 1, ?, ? FROM config WHERE id = 1 AND json_extract(value, '$.account') = ?
          AND coalesce(json_extract(value, '$.revoked'), 0) = 0
        ON CONFLICT (singleton) DO UPDATE SET id = excluded.id, account = excluded.account
        WHERE retry_request.account <> excluded.account
      `).run(id, account, account);
      return Number(result.changes) > 0 || Boolean(db.prepare("SELECT 1 FROM retry_request WHERE account = ?").get(account));
    },
    requestedRetry(account: string) {
      const row = db.prepare("SELECT id FROM retry_request WHERE account = ?").get(account);
      return typeof row?.id === "string" ? row.id : undefined;
    },
    finishRetry(id: string) {
      db.prepare("DELETE FROM retry_request WHERE id = ?").run(id);
    },
    retryCandidates(id: string) {
      const rows = db.prepare("SELECT session_key FROM uploads WHERE phase = 'failed' AND retry_id IS NOT ?").all(id);
      return new Set(rows.map((row) => String(row.session_key)));
    },
    queue(upload: {
      sessionKey: string; fingerprint: string; messageCount: number; tailLine: number; body: string; projection: 1 | 2; projectDirectory: string;
    }, retryId?: string) {
      const existing = db.prepare(
        "SELECT fingerprint, message_count, tail_line, projection, phase, retry_id, project_directory FROM uploads WHERE session_key = ?",
      ).get(upload.sessionKey);
      if (retryId && (existing?.phase !== "failed" || existing.retry_id === retryId ||
        (existing.project_directory && existing.project_directory !== upload.projectDirectory))) return "unchanged";
      if (existing && (
        (!retryId && existing.fingerprint === upload.fingerprint) ||
        upload.tailLine < Number(existing.tail_line) ||
        (upload.projection <= Number(existing.projection) && upload.messageCount < Number(existing.message_count))
      )) return "unchanged";

      const queued = db.prepare(
        "SELECT coalesce(sum(length(cast(body AS blob))), 0) AS bytes FROM uploads WHERE session_key <> ?",
      ).get(upload.sessionKey);
      if (Number(queued?.bytes ?? 0) + Buffer.byteLength(upload.body) > maximumQueueBytes) return "full";

      db.prepare(`
        INSERT INTO uploads (session_key, fingerprint, message_count, tail_line, phase, body, queued_at, projection, project_directory, retry_id)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
        ON CONFLICT (session_key) DO UPDATE SET
          fingerprint = excluded.fingerprint, message_count = excluded.message_count,
          tail_line = excluded.tail_line, phase = 'queued', body = excluded.body, queued_at = excluded.queued_at,
          projection = excluded.projection, project_directory = excluded.project_directory,
          retry_id = excluded.retry_id, http_status = NULL
      `).run(upload.sessionKey, upload.fingerprint, upload.messageCount, upload.tailLine, upload.body, Date.now(), upload.projection, upload.projectDirectory, retryId ?? null);
      return "queued";
    },
    pending() {
      return db.prepare(`
        SELECT session_key, body FROM uploads WHERE phase = 'queued'
        ORDER BY queued_at, session_key LIMIT 10
      `).all().map((row) => ({ sessionKey: String(row.session_key), body: String(row.body) }));
    },
    finish(sessionKey: string, result: { phase: "received" } | { phase: "failed"; httpStatus: number }, retryId?: string) {
      db.prepare("UPDATE uploads SET phase = ?, body = NULL, http_status = ?, retry_id = coalesce(?, retry_id) WHERE session_key = ?")
        .run(result.phase, result.phase === "failed" ? result.httpStatus : null, retryId ?? null, sessionKey);
    },
    counts() {
      const rows = db.prepare("SELECT phase, count(*) AS count FROM uploads GROUP BY phase").all();
      return new Map(rows.map((row) => [String(row.phase), Number(row.count)]));
    },
    failureCounts() {
      const migrated = db.prepare("SELECT 1 FROM pragma_table_info('uploads') WHERE name = 'http_status'").get();
      const status = migrated ? "http_status" : "NULL";
      const rows = db.prepare(`
        SELECT ${status} AS status, count(*) AS count FROM uploads WHERE phase = 'failed' GROUP BY status ORDER BY status
      `).all();
      return rows.map((row) => ({ httpStatus: typeof row.status === "number" ? row.status : null, count: Number(row.count) }));
    },
    markRevoked(config: SyncConfig) {
      db.prepare("UPDATE config SET value = ? WHERE id = 1").run(JSON.stringify({ ...config, revoked: true }));
    },
    clear() {
      db.exec("BEGIN; DELETE FROM uploads; DELETE FROM config; DELETE FROM background; DELETE FROM retry_request; COMMIT;");
    },
    close() {
      db.close();
      writer?.close();
    },
  };
}

type CredentialLocation = Pick<SyncConfig, "account" | "credentialStore">;
function credentialsPath(directory: string, credential: CredentialLocation) {
  return join(directory, `sync-${credential.account}.token`);
}

export async function storeSyncCredential(directory: string, credential: CredentialLocation, token: string) {
  if (credential.credentialStore === "file") {
    await writeFile(credentialsPath(directory, credential), token, { flag: "wx", mode: 0o600 });
    return;
  }

  await new Promise<void>((done, reject) => {
    const child = spawn("/usr/bin/security", ["-i"], {
      stdio: ["pipe", "ignore", "ignore"],
      signal: AbortSignal.timeout(10_000),
    });
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) done();
      else reject(new Error("Could not save the Tideline sync credential in Keychain."));
    });
    child.stdin.end(`add-generic-password -a ${credential.account} -s "${keychainService}" -w ${token}\n`);
  });

  const loaded = await loadSyncCredential(directory, credential);
  if (loaded !== token) throw new Error("Could not save the Tideline sync credential in Keychain.");
}

export async function loadSyncCredential(directory: string, credential: CredentialLocation) {
  let token: string;
  try {
    if (credential.credentialStore === "keychain") {
      const { stdout } = await execute(
        "/usr/bin/security",
        ["find-generic-password", "-a", credential.account, "-s", keychainService, "-w"],
        { timeout: 10_000 },
      );
      token = stdout.trim();
    } else {
      const file = credentialsPath(directory, credential);
      await checkPrivatePath(file, "file");
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.alloc(72);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        token = bytes.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    }
  } catch {
    throw new Error("Could not open the Tideline sync credential.");
  }

  const parsed = syncEnrollmentResponse.shape.token.safeParse(token);
  if (!parsed.success) throw new Error("The saved Tideline sync credential is invalid.");
  return parsed.data;
}

export async function deleteSyncCredential(directory: string, credential: CredentialLocation) {
  if (credential.credentialStore === "keychain") {
    try {
      await execute(
        "/usr/bin/security",
        ["delete-generic-password", "-a", credential.account, "-s", keychainService],
        { timeout: 10_000 },
      );
    } catch (error) {
      if (!hasErrorCode(error, 44)) throw new Error("Could not remove the Tideline sync credential from Keychain.");
    }
  } else {
    try {
      await unlink(credentialsPath(directory, credential));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw new Error("Could not remove the Tideline sync credential.");
    }
  }
}
