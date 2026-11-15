import { MAX_CODEX_IMPORT_BYTES, sessionImportRequest, codexImportResponse, sessionSourceLabel } from "@tideline/contracts";
import { readClaudeSession } from "./claude-session";
import { approvedWorkspaceDefault } from "./cli-account";
import { readCodexSession } from "./codex-session";
import { approveInBrowser, postToTideline, readJson, tidelineApiOrigin } from "./login";

export type ImportOptions = {
  workspace?: string;
  source?: string;
  browser: boolean;
  sanitized?: boolean;
  dryRun?: boolean;
};

export async function importSession(file: string, options: ImportOptions, {
  expectedSessionId, beforeUpload,
}: {
  expectedSessionId?: string;
  beforeUpload?: (session: { sourceSessionId: string; source: "codex" | "claude-code"; workspace: string }) => Promise<boolean>;
} = {}) {
  const workspaceId = sessionImportRequest.shape.workspaceId.safeParse(options.workspace ?? await approvedWorkspaceDefault());
  if (!workspaceId.success) throw new Error("Pass --workspace with the destination workspace ID, or sign in with tideline login.");

  const apiOrigin = tidelineApiOrigin();
  const source = options.source ?? "codex";
  if (source !== "codex" && source !== "claude-code") throw new Error("JSONL import supports codex and claude-code. Use sync to collect Cursor and OpenCode sessions.");

  const session = source === "claude-code"
    ? await readClaudeSession(file)
    : await readCodexSession(file);
  if (expectedSessionId && session.sourceSessionId.toLowerCase() !== expectedSessionId) {
    throw new Error("The selected local session changed while it was being read. Retry after checking its ID.");
  }
  const payload = sessionImportRequest.safeParse({
    version: 1,
    workspaceId: workspaceId.data,
    session: { ...session, source },
  });
  if (!payload.success) throw new Error("The file exceeds the supported message limits or contains invalid session data.");

  const body = JSON.stringify(payload.data);
  if (Buffer.byteLength(body) > MAX_CODEX_IMPORT_BYTES) {
    throw new Error("The prepared import exceeds the 1 MiB upload limit.");
  }

  const count = session.events.length;
  const messageLabel = count === 1 ? "message" : "messages";
  process.stdout.write(`Destination workspace: ${workspaceId.data} at ${apiOrigin}\n`);
  const sourceName = sessionSourceLabel[source];
  process.stdout.write(`${sourceName} session: ${session.sourceSessionId} with ${count} text ${messageLabel}.\n`);
  if (session.analytics?.models.length) {
    process.stdout.write("The file also contains model metadata. Tideline includes token counts where the agent reports them.\n");
  }
  const activity = session.activity;
  if (activity && (activity.tools.length || activity.skills.length || activity.children.length)) {
    process.stdout.write(`Activity recorded: ${activity.tools.length} tool calls, ${activity.skills.length} skill entries, and ${activity.children.length} child agent runs.\n`);
  }

  if (options.dryRun) {
    process.stdout.write("Dry run complete. No data was sent.\n");
    return;
  }
  if (!options.sanitized) {
    throw new Error("Review the conversation text and session metadata, then pass --sanitized to confirm it is safe to upload.");
  }
  if (beforeUpload && !await beforeUpload({ sourceSessionId: session.sourceSessionId, source, workspace: workspaceId.data })) return;

  const accessToken = await approveInBrowser(options.browser);
  const response = await postToTideline({ apiOrigin, path: "/v1/cli/imports", accessToken, body });
  if (response?.status === 404) throw new Error("The signed-in account cannot import to this workspace.");
  if (response?.status === 409) throw new Error("This workspace already has different content for that session.");
  if (!response?.ok) throw new Error("Tideline could not accept the import. Check the API and retry.");

  const receipt = codexImportResponse.safeParse(await readJson(response));
  if (!receipt.success) throw new Error("Tideline returned an invalid import receipt.");

  const status = receipt.data.alreadyReceived ? "Import already received" : "Import received";
  process.stdout.write(`${status}: ${receipt.data.id}. Open the workspace to see it after processing.\n`);
  return receipt.data;
}
