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

const configSchema = z.strictObject({
  apiOrigin: z.url(),
  workspaceId: z.uuid(),
  projectDirectory: z.string().min(1),
  startedAt: z.iso.datetime(),
  expiresAt: syncEnrollmentResponse.shape.expiresAt,
  account: z.uuid(),
  credentialStore: z.enum(["file", "keychain"]),
  codexRoot: z.string().min(1),
  claudeRoot: z.string().min(1),
  revoked: z.boolean().optional(),
});

export type SyncConfig = z.infer<typeof configSchema>;

function hasErrorCode(error: unknown, code: string | number) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function checkPrivatePath(path: string, type: "directory" | "file") {
  const stats = await lstat(path);
  const expectedType = type === "directory" ? stats.isDirectory() : stats.isFile();
  if (!expectedType || (process.getuid && stats.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    throw new Error("Tideline sync storage must be owned by you and accessible only to you.");
  }
}

async function openDatabase(directory: string, name: string, create: boolean) {
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

export async function openSyncStorage({ lock = false, create = false } = {}) {
  const directory = resolve(process.env.TIDELINE_SYNC_HOME ?? join(homedir(), ".tideline"));
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await checkPrivatePath(directory, "directory");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) throw new Error("Set up Tideline sync first with tideline sync setup.");
    throw error;
  }

  const writer = lock ? await openDatabase(directory, "sync-lock.sqlite", true) : undefined;
  try {
    writer?.exec("BEGIN IMMEDIATE");
  } catch {
    writer?.close();
    throw new Error("Tideline sync is already running. Stop it before changing its setup.");
  }

  let db: DatabaseSync;
  try {
    db = await openDatabase(directory, "sync.sqlite", create);
  } catch (error) {
    writer?.close();
    if (hasErrorCode(error, "ENOENT")) throw new Error("Set up Tideline sync first with tideline sync setup.");
    throw error;
  }
  try {
    db.exec(`
      PRAGMA busy_timeout = 1000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
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
  } catch (error) {
    db.close();
    writer?.close();
    throw error;
  }

  return {
    directory,
    config() {
      const row = db.prepare("SELECT value FROM config WHERE id = 1").get();
      return row ? configSchema.parse(JSON.parse(String(row.value))) : undefined;
    },
    saveConfig(config: SyncConfig) {
      db.prepare("INSERT INTO config (id, value) VALUES (1, ?)").run(JSON.stringify(config));
    },
    queue(upload: {
      sessionKey: string; fingerprint: string; messageCount: number; tailLine: number; body: string;
    }) {
      const existing = db.prepare(
        "SELECT fingerprint, message_count, tail_line FROM uploads WHERE session_key = ?",
      ).get(upload.sessionKey);
      if (existing && (
        existing.fingerprint === upload.fingerprint ||
        upload.messageCount < Number(existing.message_count) ||
        (upload.messageCount === Number(existing.message_count) && upload.tailLine < Number(existing.tail_line))
      )) return "unchanged";

      const queued = db.prepare(
        "SELECT coalesce(sum(length(cast(body AS blob))), 0) AS bytes FROM uploads WHERE session_key <> ?",
      ).get(upload.sessionKey);
      if (Number(queued?.bytes ?? 0) + Buffer.byteLength(upload.body) > maximumQueueBytes) return "full";

      db.prepare(`
        INSERT INTO uploads (session_key, fingerprint, message_count, tail_line, phase, body, queued_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?)
        ON CONFLICT (session_key) DO UPDATE SET
          fingerprint = excluded.fingerprint, message_count = excluded.message_count,
          tail_line = excluded.tail_line, phase = 'queued', body = excluded.body, queued_at = excluded.queued_at
      `).run(upload.sessionKey, upload.fingerprint, upload.messageCount, upload.tailLine, upload.body, Date.now());
      return "queued";
    },
    pending() {
      return db.prepare(`
        SELECT session_key, body FROM uploads WHERE phase = 'queued'
        ORDER BY queued_at, session_key LIMIT 10
      `).all().map((row) => ({ sessionKey: String(row.session_key), body: String(row.body) }));
    },
    finish(sessionKey: string, phase: "received" | "failed") {
      db.prepare("UPDATE uploads SET phase = ?, body = NULL WHERE session_key = ?").run(phase, sessionKey);
    },
    counts() {
      const rows = db.prepare("SELECT phase, count(*) AS count FROM uploads GROUP BY phase").all();
      return new Map(rows.map((row) => [String(row.phase), Number(row.count)]));
    },
    markRevoked(config: SyncConfig) {
      db.prepare("UPDATE config SET value = ? WHERE id = 1").run(JSON.stringify({ ...config, revoked: true }));
    },
    clear() {
      db.exec("BEGIN; DELETE FROM uploads; DELETE FROM config; COMMIT;");
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
