import { syncInventoryUpdate, workspaceResponse } from "@tideline/contracts";
import type { createSessionStore } from "@tideline/db/sessions";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkspaceContext } from "./workspace-routes";

function readCoverage(sessions: ReturnType<typeof createSessionStore>, context: Context<WorkspaceContext>, userId: string) {
  const uuid = workspaceResponse.shape.id.safeParse(context.req.param("id"));
  return uuid.success ? sessions.coverage(uuid.data, userId) : Promise.resolve(null);
}

export function registerSyncInventoryRoutes(
  routes: Hono<WorkspaceContext>, sessions: ReturnType<typeof createSessionStore>,
  parseToken: (authorization: string | undefined) => string | undefined,
) {
  routes.get("/workspaces/:id/sync-coverage", async (context) => {
    const report = await readCoverage(sessions, context, context.get("userId"));
    if (!report) return context.json({ error: "Workspace not found." }, 404);
    context.header("Cache-Control", "private, no-store");
    return context.json(report);
  });
  routes.get("/workspaces/:id/repository-sync", async (context) => {
    const uuid = workspaceResponse.shape.id.safeParse(context.req.param("id"));
    const query = context.req.query("q")?.trim().slice(0, 100);
    if (query?.includes("\0")) return context.json({ error: "Invalid repository filter." }, 400);
    const result = uuid.success && await sessions.repositorySyncStatus(uuid.data, context.get("userId"), query);
    if (!result) return context.json({ error: "Workspace not found." }, 404);
    context.header("Cache-Control", "private, no-store");
    return context.json(result);
  });

  routes.post("/cli/sync/inventory", bodyLimit({ maxSize: 900_000 }), async (context) => {
    const token = parseToken(context.req.header("Authorization"));
    if (!token) return context.json({ error: "A sync credential is required." }, 401);
    const update = syncInventoryUpdate.safeParse(await context.req.json().catch(() => null));
    if (!update.success) return context.json({ error: "Invalid session inventory." }, 400);
    const result = await sessions.updateInventory(token, update.data);
    switch (result) {
      case "unauthorized": return context.json({ error: "Sync approval is required." }, 401);
      case "foreign-workspace": return context.json({ error: "Workspace not found." }, 404);
      case "accepted": return context.body(null, 204);
    }
  });
}

export function registerCliSyncCoverageRoute(
  routes: Hono<WorkspaceContext>, sessions: ReturnType<typeof createSessionStore>, requireCli: MiddlewareHandler<WorkspaceContext>,
) {
  routes.get("/cli/workspaces/:id/sync-coverage", requireCli, async (context) => {
    const report = await readCoverage(sessions, context, context.get("cliAccount").userId);
    if (!report) return context.json({ error: "Workspace not found." }, 404);
    context.header("Cache-Control", "private, no-store");
    return context.json(report);
  });
}
