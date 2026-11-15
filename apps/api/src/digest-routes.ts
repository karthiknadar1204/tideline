import { digestCadence, digestSettingsUpdate, priceSession, weeklyDigestRange, weeklyDigestSessionsResponse, workspaceResponse } from "@tideline/contracts";
import type { createWorkspaceStore } from "@tideline/db";
import type { createSessionStore } from "@tideline/db/sessions";
import type { createDigestDeliveryStore } from "@tideline/db/digest-delivery";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkspaceContext } from "./workspace-routes";

const workspaceId = workspaceResponse.shape.id;

export function registerDigestRoutes(
  routes: Hono<WorkspaceContext>,
  { sessions, workspaces, digestDelivery }: {
    sessions: ReturnType<typeof createSessionStore>;
    workspaces: ReturnType<typeof createWorkspaceStore>;
    digestDelivery: ReturnType<typeof createDigestDeliveryStore>;
  },
) {
  routes.get("/workspaces/:id/weekly-digest", async (context) => {
    const id = workspaceId.safeParse(context.req.param("id")).data;
    const userId = context.get("userId");
    if (!id || !await workspaces.findAccessible({ workspaceId: id, userId })) {
      return context.json({ error: "Workspace not found." }, 404);
    }
    const range = weeklyDigestRange.safeParse(context.req.query());
    if (!range.success) return context.json({ error: "Choose two complete weeks." }, 400);
    const rows = await sessions.listReadyForDigest(id, range.data);
    return context.json(weeklyDigestSessionsResponse.parse(rows.map(priceSession)));
  });

  for (const cadence of digestCadence.options) {
    const settingsPath = `/workspaces/:id/${cadence}-digest/settings` as const;
    const notFound = { error: "Digest settings not found." };
    routes.get(settingsPath, async (context) => {
      const id = workspaceId.safeParse(context.req.param("id")).data;
      const settings = id && await digestDelivery.read({ workspaceId: id, userId: context.get("userId") }, cadence);
      return settings ? context.json(settings) : context.json(notFound, 404);
    });

    routes.put(settingsPath, bodyLimit({ maxSize: 4_096 }), async (context) => {
      const id = workspaceId.safeParse(context.req.param("id")).data;
      if (!id) return context.json(notFound, 404);
      const input = digestSettingsUpdate.safeParse(await context.req.json().catch(() => null));
      if (!input.success || (cadence === "daily" && input.data.schedule && input.data.schedule.weekday !== 0)) {
        return context.json({ error: "Choose a UTC hour and at least one recipient." }, 400);
      }
      const result = await digestDelivery.update({ workspaceId: id, userId: context.get("userId") }, cadence, input.data.schedule);
      if (result === "invalid-recipients") return context.json({ error: "Only current workspace members can receive a digest." }, 400);
      return result === "updated" ? context.body(null, 204) : context.json(notFound, 404);
    });
  }
}
