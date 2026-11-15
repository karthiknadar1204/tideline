import { linkSavedReportSessionRequest, savedReportSummary, sessionSource } from "@tideline/contracts";
import { openCliAccount } from "./cli-account";
import { importSession } from "./import";
import type { ImportOptions } from "./import";
import { prepareReportFollower, saveReportFollower } from "./report-follow-up";
import { linkReportSession, ReportSessionNotReady } from "./report-link";
import { configuredAgentRoots, fileSources, sessionFiles } from "./sync-sources";

export async function importReportSession(sessionId: string, options: ImportOptions & { analysis: string; follow?: boolean }) {
  const reportId = savedReportSummary.shape.id.safeParse(options.analysis.toLowerCase()).data;
  if (!reportId) throw new Error("Provide the UUID of a saved Tideline report with --analysis.");
  const id = linkSavedReportSessionRequest.shape.sessionId.safeParse(sessionId).data;
  if (options.follow) {
    if (!options.dryRun && !options.sanitized) throw new Error("Review this local session and pass --sanitized to approve report follow-up.");
    const candidate = id ? await findLocalSession(id, options.source) : [localFollowSource(options.source), sessionId] as const;
    if (!candidate) throw new Error("Use the local native session ID or JSONL file to approve follow-up.");
    const [source, file] = candidate;
    const local = await prepareReportFollower(file, source, id);
    if (options.dryRun) {
      await importSession(local.path, { ...options, source }, { expectedSessionId: local.sourceSessionId });
      console.info(`Would link the session to report ${reportId} and approve new messages for seven days.`);
      return;
    }
    const { workspaceId: workspace } = await openCliAccount(options);
    let link: Awaited<ReturnType<typeof linkReportSession>>;
    try {
      link = await linkReportSession(reportId, local.sourceSessionId, { workspace, source, follow: true });
    } catch (error) {
      if (!(error instanceof ReportSessionNotReady)) throw error;
      const receipt = await importSession(local.path, { ...options, workspace, source }, { expectedSessionId: local.sourceSessionId });
      if (!receipt) throw error;
      link = await linkReportSession(reportId, receipt.id, { workspace, waitForSession: true, follow: true });
    }
    await saveReportFollower(local, { ...link, reportId });
    try {
      const { configureNativeHooks } = await import("./native-hooks");
      await configureNativeHooks("install", source, { reportFollowUp: true });
    } catch {
      console.warn("Run tideline report sync to check for new messages, or use the installed Tideline CLI to enable automatic hooks.");
    }
    return;
  }

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
    if (options.dryRun) previewReportImport(reportId);
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

  const candidate = await findLocalSession(id, options.source);
  if (!candidate) throw new Error("No matching local Codex or Claude Code session was found.");

  const [kind, file] = candidate;
  const receipt = await importSession(file, { ...options, source: kind }, { expectedSessionId: id });
  if (!receipt) {
    previewReportImport(reportId);
    return;
  }
  await linkReportSession(reportId, receipt.id, { workspace: options.workspace, waitForSession: true });
}

function previewReportImport(reportId: string) {
  console.info(`Would link the session to report ${reportId} after import.`);
}

function localFollowSource(value?: string) {
  if (value === undefined || value === "codex") return "codex";
  if (value === "claude-code") return value;
  throw new Error("Report follow-up supports Codex and Claude Code.");
}

async function findLocalSession(id: string, requestedSource?: string) {
  const source = sessionSource.optional().safeParse(requestedSource);
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
  return candidates.entries().next().value;
}
