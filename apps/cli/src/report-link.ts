import { linkSavedReportSessionRequest, linkSavedReportSessionResponse, MAX_REPORT_SESSION_REFERENCES, savedReportSummary, sessionSource } from "@tideline/contracts";
import { setTimeout as delay } from "node:timers/promises";
import { openCliAccount } from "./cli-account";
import { tidelineWebOrigin } from "./login";
import { sourceSessionUuid } from "./session-jsonl";

export class ReportSessionNotReady extends Error {}

export async function linkReportSession(reportId: string, session: string, options: {
  workspace?: string;
  source?: string;
  json?: boolean;
  waitForSession?: boolean;
  follow?: boolean;
}) {
  const report = savedReportSummary.shape.id.safeParse(reportId.toLowerCase()).data;
  if (!report) throw new Error("Provide the UUID of a saved Tideline report.");

  const source = sessionSource.optional().safeParse(options.source);
  if (!source.success) throw new Error("Use --source codex, claude-code, cursor, or opencode.");
  if (!session || session.length > 256) throw new Error("Provide a Tideline session UUID or native agent session ID.");
  const sessionId = source.data === "cursor" || source.data === "opencode" ? sourceSessionUuid(source.data, session) : session;
  const request = linkSavedReportSessionRequest.safeParse({ sessionId, source: source.data, follow: options.follow ? true : undefined });
  if (!request.success) throw new Error("Provide a session UUID, or use --source with the native agent session ID.");

  const client = await openCliAccount(options);
  const path = `/v1/cli/workspaces/${client.workspaceId}/saved-reports/${report}/sessions`;
  function attach() {
    return client.post(path, request.data, linkSavedReportSessionResponse).catch((error: unknown) => {
      if (error instanceof Error) {
        switch (error.message) {
          case "Tideline request failed (HTTP 422).": return undefined;
          case "The requested workspace or session is unavailable to this account.":
            throw new Error("That report is unavailable. Select its workspace and sign in as the report author.");
          case "Tideline request failed (HTTP 409).":
            throw new Error("More than one agent used this session ID. Retry with --source.");
          case "Tideline request failed (HTTP 403).":
            throw new Error("Follow-up requires a Codex or Claude Code session you uploaded.");
          case "Tideline request failed (HTTP 400).":
            throw new Error(`A report can reference up to ${MAX_REPORT_SESSION_REFERENCES} sessions.`);
        }
      }
      throw error;
    });
  }

  let result = await attach();
  if (options.waitForSession) {
    for (const milliseconds of [250, 500, 1000, 2000, 3000]) {
      if (result) break;
      await delay(milliseconds);
      result = await attach();
    }
  }
  if (!result) throw new ReportSessionNotReady("That session is not ready in this workspace. Sync it or wait for processing, then retry.");

  const url = new URL(`/workspace/${client.workspaceId}/reports/saved/${result.report.id}`, tidelineWebOrigin()).href;
  if (options.json) console.info(JSON.stringify({ ...result, url }));
  else console.info(`${result.linked ? "Linked session" : "Session already linked"} ${result.sessionId}.\n${url}`);
  return { ...result, workspaceId: client.workspaceId, userId: client.userId };
}
