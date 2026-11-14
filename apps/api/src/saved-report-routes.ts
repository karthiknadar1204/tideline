import { savedReportPage, saveReportRequest, workspaceResponse } from "@tideline/contracts";
import type { createSavedReportStore } from "@tideline/db/reports";
import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkspaceContext } from "./workspace-routes";

const reportListPath = "/workspaces/:workspaceId/saved-reports";
const reportDetailPath = `${reportListPath}/:reportId` as const;
const uuid = workspaceResponse.shape.id;

export function registerSavedReportRoutes(
  routes: Hono<WorkspaceContext>,
  reports: ReturnType<typeof createSavedReportStore>,
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

  routes.post(`/cli${reportListPath}`, requireCliAccount, bodyLimit({ maxSize: 131_072 }), async (context) => {
    const workspaceId = uuid.safeParse(context.req.param("workspaceId"));
    if (!workspaceId.success) return context.json({ error: "Workspace not found." }, 404);
    const draft = saveReportRequest.safeParse(await context.req.json().catch(() => null));
    if (!draft.success) return context.json({ error: "Provide a title, Markdown, and valid session references." }, 400);

    const result = await reports.save({ workspaceId: workspaceId.data, userId: context.get("cliAccount").userId }, draft.data);
    if (result.kind === "saved") return context.json(result.report, result.created ? 201 : 200);
    if (result.kind === "invalid-sessions") return context.json({ error: "Cited sessions must be ready in this workspace." }, 400);
    return context.json({ error: "Workspace not found." }, 404);
  });
}
