import { cliAccountResponse, cliLoginResponse, workspaceAccessList, workspaceResponse } from "@tideline/contracts";
import { z } from "zod";
import { approveInBrowser, postToTideline, readJson, requestTideline, tidelineApiOrigin } from "./login";
import { ensureSyncDirectory, openPrivateDatabase, openSyncStorage, SyncSetupMissingError } from "./sync-storage";
import type { SyncConfig } from "./sync-storage";

const accountPath = "/v1/cli/account";
const accountFile = "cli-account.sqlite";
const savedAccount = z.strictObject({
  apiOrigin: z.url(),
  token: cliLoginResponse.shape.token,
  expiresAt: cliLoginResponse.shape.expiresAt,
  account: cliAccountResponse,
  selectedWorkspaceId: workspaceResponse.shape.id.optional(),
});

type SavedAccount = z.infer<typeof savedAccount>;

export class CliLoginRequired extends Error {}

function isMissing(error: unknown) {
  return error instanceof SyncSetupMissingError ||
    (error instanceof Error && "code" in error && error.code === "ENOENT");
}

async function accountDatabase(create: boolean) {
  const directory = await ensureSyncDirectory(create);
  const db = await openPrivateDatabase(directory, accountFile, create);
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    if (create) db.exec(`CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function readAccount() {
  const db = await accountDatabase(false).catch((error) => {
    if (!isMissing(error)) throw error;
  });
  if (!db) return;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'account'").get()) return;
    const row = db.prepare("SELECT value FROM account WHERE id = 1").get();
    if (!row) return;
    try {
      return savedAccount.parse(JSON.parse(String(row.value)));
    } catch {
      throw new Error("Tideline could not read its saved CLI account.");
    }
  } finally {
    db.close();
  }
}

function endpoint(config: SavedAccount) {
  const apiOrigin = tidelineApiOrigin();
  if (config.apiOrigin !== apiOrigin) throw new Error("TIDELINE_API_URL differs from the saved CLI account.");
  return apiOrigin;
}

function requestAccount(config: SavedAccount, method: "GET" | "DELETE" | "POST", path = accountPath, options?: { body?: string; signal?: AbortSignal }) {
  return requestTideline({ apiOrigin: endpoint(config), path, method, accessToken: config.token, ...options });
}

async function deleteGrant(config: SavedAccount) {
  const response = await requestAccount(config, "DELETE");
  if (response?.status !== 204 && response?.status !== 401) {
    throw new Error("Tideline could not sign out. Check the API connection and run tideline logout again.");
  }
}

async function checkedResponse<T>(response: Response | null, schema: z.ZodType<T>) {
  if (response?.status === 401) throw new CliLoginRequired("CLI approval expired or was revoked. Run tideline login.");
  if (response?.status === 404) throw new Error("The requested workspace or session is unavailable to this account.");
  if (!response?.ok) throw new Error(response ? `Tideline request failed (HTTP ${response.status}).` : "Could not reach the Tideline API.");
  const parsed = schema.safeParse(await readJson(response));
  if (!parsed.success) throw new Error("Tideline returned an unexpected response.");
  return parsed.data;
}

export async function readAccountStatus() {
  const stored = await readAccount();
  if (!stored) throw new CliLoginRequired("Sign in with tideline login.");
  if (Date.now() >= Date.parse(stored.expiresAt)) throw new CliLoginRequired("CLI approval expired. Run tideline login.");
  const account = await checkedResponse(await requestAccount(stored, "GET"), cliAccountResponse);
  return { account, expiresAt: stored.expiresAt, workspaceId: stored.selectedWorkspaceId ?? account.workspace.id };
}

async function activeAccount() {
  const stored = await readAccount();
  if (!stored) throw new CliLoginRequired("Sign in with tideline login.");
  if (Date.now() >= Date.parse(stored.expiresAt)) throw new CliLoginRequired("CLI approval expired. Run tideline login.");
  endpoint(stored);
  return stored;
}

function workspaceIdFor(stored: SavedAccount, workspace: string | undefined) {
  const id = workspace === undefined ? stored.selectedWorkspaceId ?? stored.account.workspace.id
    : workspaceResponse.shape.id.safeParse(workspace.toLowerCase()).data;
  if (!id) throw new Error("Set --workspace to a workspace UUID.");
  return id;
}

export async function approvedWorkspaceDefault(): Promise<string | undefined> {
  const stored = await activeAccount().catch((error) => {
    if (!(error instanceof CliLoginRequired)) throw error;
    return undefined;
  });
  return stored && workspaceIdFor(stored, undefined);
}

export async function openCliAccount({ workspace }: { workspace?: string } = {}) {
  const stored = await activeAccount();
  return {
    workspaceId: workspaceIdFor(stored, workspace),
    userId: stored.account.userId,
    async get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
      return checkedResponse(await requestAccount(stored, "GET", path, { signal }), schema);
    },
    async download(path: string, maximumBytes: number) {
      const response = await requestAccount(stored, "GET", path);
      if (!response?.ok || !response.body) throw new Error("A transcript attachment could not be downloaded.");
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maximumBytes) {
            await reader.cancel();
            throw new Error("A transcript attachment exceeded its recorded size.");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    },
    async post<T>(path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal) {
      return checkedResponse(await requestAccount(stored, "POST", path, { body: JSON.stringify(body), signal }), schema);
    },
  };
}

export async function login({ browser }: { browser: boolean }) {
  const apiOrigin = tidelineApiOrigin();
  const previous = await readAccount();
  if (previous) {
    const status = await readAccountStatus().catch((error) => {
      if (!(error instanceof CliLoginRequired)) throw error;
    });
    if (status) {
      console.info(`Already signed in to ${status.account.workspace.name} (${status.account.workspace.id}).`);
      return;
    }
    endpoint(previous);
  }

  const accessToken = await approveInBrowser(browser);
  const response = await postToTideline({ apiOrigin, path: accountPath, accessToken });
  const login = await checkedResponse(response, cliLoginResponse);
  const config = { ...login, apiOrigin };
  try {
    const db = await accountDatabase(true);
    try {
      db.exec("PRAGMA secure_delete = ON");
      const result = previous
        ? db.prepare("UPDATE account SET value = ? WHERE id = 1 AND json_extract(value, '$.token') = ?")
          .run(JSON.stringify(config), previous.token)
        : db.prepare("INSERT INTO account VALUES (1, ?) ON CONFLICT DO NOTHING").run(JSON.stringify(config));
      if (!result.changes) throw new Error("CLI account changed during approval. Run tideline whoami.");
    } finally {
      db.close();
    }
  } catch (error) {
    await deleteGrant(config).catch(() => {});
    throw error;
  }
  console.info(`Browser approval verified for ${login.account.workspace.name} (${login.account.workspace.id}).`);
}

export async function logout() {
  const config = await readAccount();
  if (config) endpoint(config);
  const storage = await openSyncStorage().catch((error) => {
    if (!(error instanceof SyncSetupMissingError)) throw error;
  });
  let sync: SyncConfig | undefined;
  try {
    sync = storage?.config();
  } finally {
    storage?.close();
  }
  const ownsCollector = sync && (!config || (sync.apiOrigin === config.apiOrigin && (sync.userId
    ? sync.userId === config.account.userId : sync.workspaceId === config.account.workspace.id)));
  if (ownsCollector) {
    const { revokeSync } = await import("./sync");
    await revokeSync();
  }

  if (config) {
    await deleteGrant(config);
    const db = await accountDatabase(false);
    try {
      db.exec("PRAGMA secure_delete = ON");
      const result = db.prepare("DELETE FROM account WHERE id = 1 AND json_extract(value, '$.token') = ?").run(config.token);
      if (!result.changes) throw new Error("CLI account changed during sign-out. Run tideline whoami.");
      const { forgetReportFollowers } = await import("./report-follow-up");
      await forgetReportFollowers(config.account.userId, config.apiOrigin);
    } finally {
      db.close();
    }
  }
  console.info("Signed out of the Tideline CLI.");
  if (sync && !ownsCollector) console.info("A different workspace still has a local collector. Use tideline sync status to inspect it.");
}

export async function showWorkspace({ workspace, json }: { workspace?: string; json?: boolean }) {
  const client = await openCliAccount({ workspace });
  const selected = await client.get(`/v1/cli/workspaces/${client.workspaceId}`, workspaceResponse);
  if (json) console.info(JSON.stringify(selected));
  else console.info(`${selected.name} (${selected.id})`);
}

export async function selectWorkspace(workspace: string) {
  const stored = await activeAccount();
  const selected = await checkedResponse(
    await requestAccount(stored, "GET", `/v1/cli/workspaces/${workspaceIdFor(stored, workspace)}`),
    workspaceResponse,
  );
  const db = await accountDatabase(false);
  try {
    db.exec("PRAGMA secure_delete = ON");
    const result = db.prepare("UPDATE account SET value = json_set(value, '$.selectedWorkspaceId', ?) WHERE id = 1 AND json_extract(value, '$.token') = ?")
      .run(selected.id, stored.token);
    if (!result.changes) throw new Error("CLI account changed. Run tideline workspace use again.");
  } finally {
    db.close();
  }
  console.info(`Using ${selected.name} (${selected.id}).`);
}

export async function listWorkspaces({ json }: { json?: boolean }) {
  const client = await openCliAccount();
  const workspaces = await client.get("/v1/cli/workspaces", workspaceAccessList);
  if (json) console.info(JSON.stringify(workspaces));
  else for (const { name, id, role } of workspaces) console.info(`${name} (${id}) · ${role}`);
}
