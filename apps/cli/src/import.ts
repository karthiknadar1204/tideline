import { MAX_CODEX_IMPORT_BYTES, sessionImportRequest, codexImportResponse, sessionSource } from "@tideline/contracts";
import { readClaudeSession } from "./claude-session";
import { readCodexSession } from "./codex-session";
import { approveInBrowser, postToTideline, readJson, tidelineApiOrigin } from "./login";

type ImportOptions = {
  workspace: string;
  source: string;
  browser: boolean;
  sanitized?: boolean;
  dryRun?: boolean;
};

export async function importSession(file: string, options: ImportOptions) {
  const workspaceId = sessionImportRequest.shape.workspaceId.safeParse(options.workspace);
  if (!workspaceId.success) throw new Error("Set --workspace to the destination workspace UUID.");

  const apiOrigin = tidelineApiOrigin();
  const source = sessionSource.safeParse(options.source);
  if (!source.success) throw new Error("Set --source to codex or claude-code.");

  const session = source.data === "claude-code"
    ? await readClaudeSession(file)
    : await readCodexSession(file);
  const payload = sessionImportRequest.safeParse({
    version: 1,
    workspaceId: workspaceId.data,
    session: { ...session, source: source.data },
  });
  if (!payload.success) throw new Error("The file exceeds the supported message limits or contains invalid session data.");

  const body = JSON.stringify(payload.data);
  if (Buffer.byteLength(body) > MAX_CODEX_IMPORT_BYTES) {
    throw new Error("The prepared import exceeds the 1 MiB upload limit.");
  }

  const count = session.events.length;
  const messageLabel = count === 1 ? "message" : "messages";
  process.stdout.write(`Destination workspace: ${workspaceId.data} at ${apiOrigin}\n`);
  const sourceName = source.data === "claude-code" ? "Claude Code" : "Codex";
  process.stdout.write(`${sourceName} session: ${session.sourceSessionId} with ${count} text ${messageLabel}.\n`);
  if (session.analytics?.models.length) {
    process.stdout.write("The file also contains model metadata. Tideline includes token counts where the agent reports them.\n");
  }

  if (options.dryRun) {
    process.stdout.write("Dry run complete. No data was sent.\n");
    return;
  }
  if (!options.sanitized) {
    throw new Error("Review the conversation text and session metadata, then pass --sanitized to confirm it is safe to upload.");
  }

  const accessToken = await approveInBrowser(options.browser);
  const response = await postToTideline({ apiOrigin, path: "/v1/cli/imports", accessToken, body });
  if (response?.status === 404) throw new Error("The signed-in account cannot import to this workspace.");
  if (response?.status === 409) throw new Error("This workspace already has different content for that session.");
  if (!response?.ok) throw new Error("Tideline could not accept the import. Check the API and retry.");

  const receipt = codexImportResponse.safeParse(await readJson(response));
  if (!receipt.success) throw new Error("Tideline returned an invalid import receipt.");

  const status = receipt.data.alreadyReceived ? "Import already received" : "Import received";
  process.stdout.write(`${status}: ${receipt.data.id}. Open the workspace to see it after processing.\n`);
}
