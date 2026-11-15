import { priceSession, workspaceActivityKind, workspaceActivityQuery, workspaceResponse, workspaceTrendsQuery, workspaceTrendsSessions } from "@tideline/contracts";
import type { createSessionStore } from "@tideline/db/sessions";
import type { Hono } from "hono";
import type { WorkspaceContext } from "./workspace-routes";

export function registerWorkspaceActivityRoutes(routes: Hono<WorkspaceContext>, sessions: ReturnType<typeof createSessionStore>) {
  routes.get("/workspaces/:id/trends", async (context) => {
    const id = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: "Workspace not found." }, 404);
    const range = workspaceTrendsQuery.safeParse(context.req.query());
    if (!range.success) return context.json({ error: "Choose a valid trends period." }, 400);
    const rows = await sessions.listReadyForTrends({ workspaceId: id.data, userId: context.get("userId") }, range.data);
    return rows ? context.json(workspaceTrendsSessions.parse(rows.map(priceSession))) : context.json({ error: "Workspace not found." }, 404);
  });

  routes.get("/workspaces/:id/activity/:kind", async (context) => {
    const id = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: "Workspace not found." }, 404);

    const kind = workspaceActivityKind.safeParse(context.req.param("kind"));
    const filters = workspaceActivityQuery.safeParse(context.req.query());
    if (!kind.success || !filters.success) return context.json({ error: "Invalid activity filters." }, 400);

    const activity = await sessions.activity({ workspaceId: id.data, userId: context.get("userId") }, kind.data, filters.data);
    return activity ? context.json(activity) : context.json({ error: "Workspace not found." }, 404);
  });
}
