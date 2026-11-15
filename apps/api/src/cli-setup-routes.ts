import { createHash, randomBytes } from "node:crypto";
import {
  cliSetupAuthorization,
  cliSetupClaim,
  cliSetupClaimed,
  cliSetupCreated,
  cliSetupSnapshot,
  cliSetupTerminalProgress,
  workspaceResponse,
} from "@tideline/contracts";
import type { createWorkspaceStore } from "@tideline/db";
import type { createCliSetupStore } from "@tideline/db/cli-setups";
import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkspaceContext } from "./workspace-routes";

function hash(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

const setupId = cliSetupSnapshot.shape.id;
const progressUpdate = cliSetupClaim.pick({ writer: true }).extend({ progress: cliSetupTerminalProgress });
const setupApproval = cliSetupClaim.pick({ writer: true }).extend({ workspaceId: workspaceResponse.shape.id });
const limit = bodyLimit({ maxSize: 2_048 });

export function registerCliSetupRoutes(
  routes: Hono<WorkspaceContext>,
  setups: ReturnType<typeof createCliSetupStore>,
  workspaces: ReturnType<typeof createWorkspaceStore>,
  requireClerkCli: MiddlewareHandler<WorkspaceContext>,
) {
  async function accessibleWorkspace(candidate: string, userId: string) {
    const workspaceId = workspaceResponse.shape.id.safeParse(candidate);
    return workspaceId.success && await workspaces.findAccessible({ workspaceId: workspaceId.data, userId });
  }

  routes.post("/workspaces/:workspaceId/cli-setups", async (context) => {
    const userId = context.get("userId");
    const workspace = await accessibleWorkspace(context.req.param("workspaceId"), userId);
    if (!workspace) return context.json({ error: "Workspace not found." }, 404);
    const code = randomBytes(16).toString("base64url");
    const setup = await setups.begin(workspace.id, userId, hash(code));
    return context.json(cliSetupCreated.parse({ ...setup, expiresAt: setup.expiresAt.toISOString(), code }), 201);
  });

  routes.get("/workspaces/:workspaceId/cli-setups/:id", async (context) => {
    const id = setupId.safeParse(context.req.param("id"));
    const userId = context.get("userId");
    const workspace = id.success && await accessibleWorkspace(context.req.param("workspaceId"), userId);
    if (!workspace || !id.success) return context.json({ error: "Connection not found." }, 404);
    const setup = await setups.read(id.data, workspace.id, userId);
    if (!setup) return context.json({ error: "Connection not found or expired." }, 404);
    return context.json(cliSetupSnapshot.parse({ ...setup, expiresAt: setup.expiresAt.toISOString() }));
  });

  routes.post("/cli/setup/claim", limit, async (context) => {
    const claim = cliSetupClaim.safeParse(await context.req.json().catch(() => null));
    if (!claim.success) return context.json({ error: "Invalid setup code." }, 400);
    const setup = await setups.claim(hash(claim.data.code), hash(claim.data.writer));
    if (!setup) return context.json({ error: "Connection code expired or was already used." }, 404);
    return context.json(cliSetupClaimed.parse(setup));
  });

  routes.post("/cli/setup/:id/progress", limit, async (context) => {
    const id = setupId.safeParse(context.req.param("id"));
    const update = progressUpdate.safeParse(await context.req.json().catch(() => null));
    if (!id.success || !update.success) return context.json({ error: "Invalid setup update." }, 400);
    if (!await setups.update(id.data, hash(update.data.writer), update.data.progress)) {
      return context.json({ error: "Connection expired or moved on." }, 409);
    }
    return context.body(null, 204);
  });

  routes.post("/cli/setup/:id/approve", limit, requireClerkCli, async (context) => {
    const id = setupId.safeParse(context.req.param("id"));
    const request = setupApproval.safeParse(await context.req.json().catch(() => null));
    if (!id.success || !request.success) return context.json({ error: "Invalid approval." }, 400);
    const userId = context.get("userId");
    const workspace = await accessibleWorkspace(request.data.workspaceId, userId);
    const setup = workspace && await setups.approve(id.data, workspace.id, hash(request.data.writer), userId);
    if (!setup) return context.json({ error: "Approve with the same account that opened workspace setup." }, 403);
    return context.json(cliSetupAuthorization.parse({ ...setup, userId }));
  });
}
