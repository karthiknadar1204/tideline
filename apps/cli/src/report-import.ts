import { linkSavedReportSessionRequest, savedReportSummary, sessionSource } from "@tideline/contracts";
import { importSession } from "./import";
import type { ImportOptions } from "./import";
import { linkReportSession, ReportSessionNotReady } from "./report-link";
import { configuredAgentRoots, fileSources, sessionFiles } from "./sync-sources";

export async function importReportSession(sessionId: string, options: ImportOptions & { analysis: string }) {
  const reportId = savedReportSummary.shape.id.safeParse(options.analysis.toLowerCase()).data;
  if (!reportId) throw new Error("Provide the UUID of a saved Tideline report with --analysis.");
  const id = linkSavedReportSessionRequest.shape.sessionId.safeParse(sessionId).data;
  if (!id) {
    let workspace = options.workspace;
    const receipt = await importSession(sessionId, options, {
      async beforeUpload({ sourceSessionId, source, workspace: destination }) {
        workspace = destination;
        try {
          await linkReportSession(reportId, sourceSessionId, { workspace, source });
          return false;
        } catch (error) {
          if (!(error instanceof ReportSessionNotReady)) throw error;
          return true;
        }
      },
    });
    if (options.dryRun) console.info(`Would link the session to report ${reportId} after import.`);
    if (receipt) await linkReportSession(reportId, receipt.id, { workspace, waitForSession: true });
    return;
  }

  if (!options.dryRun) {
    try {
      await linkReportSession(reportId, sessionId, options);
      return;
    } catch (error) {
      if (!(error instanceof ReportSessionNotReady)) throw error;
      if (!options.sanitized) throw new Error("Review the local session, then pass --sanitized to approve a local upload.");
    }
  }

  const source = sessionSource.optional().safeParse(options.source);
  if (!source.success) throw new Error("Use --source codex, claude-code, cursor, or opencode.");
  if (source.data === "cursor" || source.data === "opencode") {
    throw new Error("Use sync for local Cursor or OpenCode sessions, then link the synced session to the report.");
  }
  const candidates = new Map<"codex" | "claude-code", string>();
  for (const { source: kind, root, depth, discover } of fileSources(await configuredAgentRoots())) {
    if (!root || (source.data && kind !== source.data) || candidates.has(kind)) continue;
    for await (const file of sessionFiles(root, depth, () => {})) {
      const candidate = await discover(file).catch(() => undefined);
      if (candidate?.sourceSessionId.toLowerCase() !== id) continue;
      candidates.set(kind, file);
      break;
    }
  }
  if (candidates.size > 1) throw new Error("More than one local agent used this session ID. Retry with --source.");
  const candidate = candidates.entries().next().value;
  if (!candidate) throw new Error("No matching local Codex or Claude Code session was found.");

  const [kind, file] = candidate;
  const receipt = await importSession(file, { ...options, source: kind }, { expectedSessionId: id });
  if (!receipt) {
    console.info(`Would link the session to report ${reportId} after import.`);
    return;
  }
  await linkReportSession(reportId, receipt.id, { workspace: options.workspace, waitForSession: true });
}
