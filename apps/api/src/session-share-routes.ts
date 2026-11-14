import { randomBytes } from "node:crypto";
import { createSessionShareRequest, sessionShareToken, workspaceResponse } from "@tideline/contracts";
import type { createSessionShareStore } from "@tideline/db/shares";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkspaceContext } from "./workspace-routes";

const scopedPath = "/workspaces/:workspaceId/sessions/:sessionId/share";

function readAccess(context: Context<WorkspaceContext, typeof scopedPath>) {
  const uuid = workspaceResponse.shape.id;
  const workspaceId = uuid.safeParse(context.req.param("workspaceId"));
  const sessionId = uuid.safeParse(context.req.param("sessionId"));
  if (workspaceId.success && sessionId.success) {
    return { workspaceId: workspaceId.data, sessionId: sessionId.data, userId: context.get("userId") };
  }
}

export function registerSessionShareRoutes(routes: Hono<WorkspaceContext>, shares: ReturnType<typeof createSessionShareStore>) {
  routes.get(scopedPath, async (context) => {
    const access = readAccess(context);
    const status = access && await shares.readStatus(access);
    return status ? context.json(status) : context.json({ error: "Session not found." }, 404);
  });

  routes.post(scopedPath, bodyLimit({ maxSize: 512 }), async (context) => {
    const access = readAccess(context);
    if (!access) return context.json({ error: "Session not found." }, 404);
    const displayed = createSessionShareRequest.safeParse(await context.req.json().catch(() => null));
    if (!displayed.success) return context.json({ error: "Expected the displayed conversation version." }, 400);

    const result = await shares.create(access, displayed.data, `tdshare_${randomBytes(32).toString("hex")}`);
    switch (result.kind) {
      case "shared": return context.json({ token: result.token });
      case "changed": return context.json({ error: "The conversation changed. Review it before sharing." }, 409);
      case "missing": return context.json({ error: "Session not found." }, 404);
    }
  });

  routes.delete(scopedPath, async (context) => {
    const access = readAccess(context);
    if (!access || !await shares.revoke(access)) return context.json({ error: "Session not found." }, 404);
    return context.body(null, 204);
  });

  routes.get("/shares/:token", async (context) => {
    context.header("Cache-Control", "private, no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Robots-Tag", "noindex, nofollow");
    const token = sessionShareToken.safeParse(context.req.param("token"));
    const snapshot = token.success && await shares.readPublic(token.data);
    return snapshot ? context.json(snapshot) : context.json({ error: "Shared conversation not found." }, 404);
  });
}
