import { codexImportResponse, linkSavedReportSessionRequest, MAX_CODEX_IMPORT_BYTES, reportFollowUpRequest, savedReportPage, saveReportRequest, workspaceResponse } from "@tideline/contracts";
import type { createSavedReportStore } from "@tideline/db/reports";
import type { createSessionStore } from "@tideline/db/sessions";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkspaceContext } from "./workspace-routes";

const reportListPath = "/workspaces/:workspaceId/saved-reports";
const reportDetailPath = `${reportListPath}/:reportId` as const;
const uuid = workspaceResponse.shape.id;

export function registerSavedReportRoutes(
  routes: Hono<WorkspaceContext>,
  reports: ReturnType<typeof createSavedReportStore>,
  sessions: ReturnType<typeof createSessionStore>,
  requireCliAccount: MiddlewareHandler<WorkspaceContext>,
) {
  routes.get(reportListPath, async (context) => {
    const workspaceId = uuid.safeParse(context.req.param("workspaceId"));
    const page = savedReportPage.safeParse(context.req.query("page"));
    if (!workspaceId.success) return context.json({ error: "Workspace not found." }, 404);
    if (!page.success) return context.json({ error: "Invalid report page." }, 400);

    const response = await reports.list({ workspaceId: workspaceId.data, userId: context.get("userId") }, page.data);
    return response ? context.json(response) : context.json({ error: "Workspace not found." }, 404);
  });

  routes.get(reportDetailPath, async (context) => {
    const workspaceId = uuid.safeParse(context.req.param("workspaceId"));
    const reportId = uuid.safeParse(context.req.param("reportId"));
    if (!workspaceId.success || !reportId.success) return context.json({ error: "Report not found." }, 404);

    const report = await reports.read({ workspaceId: workspaceId.data, userId: context.get("userId") }, reportId.data);
    return report ? context.json(report) : context.json({ error: "Report not found." }, 404);
  });

  routes.delete(reportDetailPath, async (context) => {
    const workspaceId = uuid.safeParse(context.req.param("workspaceId"));
    const reportId = uuid.safeParse(context.req.param("reportId"));
    if (!workspaceId.success || !reportId.success) return context.json({ error: "Report not found." }, 404);

    const removed = await reports.remove({ workspaceId: workspaceId.data, userId: context.get("userId") }, reportId.data);
    return removed ? context.body(null, 204) : context.json({ error: "Report not found." }, 404);
  });

  async function save(context: Context<WorkspaceContext, typeof reportListPath>, userId: string) {
    const workspaceId = uuid.safeParse(context.req.param("workspaceId"));
    if (!workspaceId.success) return context.json({ error: "Workspace not found." }, 404);
    const draft = saveReportRequest.safeParse(await context.req.json().catch(() => null));
    if (!draft.success) return context.json({ error: "Provide a title, Markdown, and valid session references." }, 400);

    const result = await reports.save({ workspaceId: workspaceId.data, userId }, draft.data);
    if (result.kind === "saved") return context.json(result.report, result.created ? 201 : 200);
    if (result.kind === "invalid-sessions") return context.json({ error: "Cited sessions must be ready in this workspace." }, 400);
    return context.json({ error: "Workspace not found." }, 404);
  }

  const limitReportBody = bodyLimit({ maxSize: 131_072 });
  routes.post(reportListPath, limitReportBody, (context) => save(context, context.get("userId")));
  routes.post(`/cli${reportListPath}`, requireCliAccount, limitReportBody, (context) => save(context, context.get("cliAccount").userId));

  routes.post(`/cli${reportDetailPath}/sessions`, requireCliAccount, bodyLimit({ maxSize: 1024 }), async (context) => {
    const workspaceId = uuid.safeParse(context.req.param("workspaceId"));
    const reportId = uuid.safeParse(context.req.param("reportId"));
    if (!workspaceId.success || !reportId.success) return context.json({ error: "Report not found." }, 404);
    const reference = linkSavedReportSessionRequest.safeParse(await context.req.json().catch(() => null));
    if (!reference.success) return context.json({ error: "Provide a valid session ID and optional agent source." }, 400);

    const access = { workspaceId: workspaceId.data, userId: context.get("cliAccount").userId };
    const result = await reports.linkSession(access, reportId.data, reference.data);
    switch (result.kind) {
      case "found": return context.json(result.result);
      case "report-unavailable": return context.json({ error: "Report not found." }, 404);
      case "session-unavailable": return context.json({ error: "The session is not ready in this workspace." }, 422);
      case "ambiguous": return context.json({ error: "Specify the agent source for this session ID." }, 409);
      case "follow-unavailable": return context.json({ error: "Follow-up requires a Codex or Claude Code session you uploaded." }, 403);
      case "limit": return context.json({ error: "This report already has the maximum number of session references." }, 400);
    }
  });
  routes.post(`/cli${reportDetailPath}/sessions/:sessionId/follow`, requireCliAccount,
    bodyLimit({ maxSize: MAX_CODEX_IMPORT_BYTES }), async (context) => {
      const workspaceId = uuid.safeParse(context.req.param("workspaceId")).data;
      const reportId = uuid.safeParse(context.req.param("reportId")).data;
      const sessionId = uuid.safeParse(context.req.param("sessionId")).data;
      if (!workspaceId || !reportId || !sessionId) return context.json({ error: "Follow-up is unavailable." }, 404);
      const request = reportFollowUpRequest.safeParse(await context.req.json().catch(() => null));
      if (!request.success) return context.json({ error: "Provide ordered conversation messages." }, 400);
      const receipt = await sessions.receiveReportFollowUp({
        workspaceId, reportId, sessionId, userId: context.get("cliAccount").userId, events: request.data.events,
      });
      if (receipt === undefined) return context.json({ error: "Follow-up is unavailable." }, 404);
      if (!receipt) return context.json({ error: "This session cannot accept more messages." }, 409);
      return context.json(codexImportResponse.parse(receipt), receipt.alreadyReceived ? 200 : 202);
    });

}
