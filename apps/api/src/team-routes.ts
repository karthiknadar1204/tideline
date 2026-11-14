import { createHash, randomBytes } from "node:crypto";
import type { createClerkClient } from "@clerk/backend";
import { workspaceInviteAcceptance, workspaceInviteRequest, workspaceMemberUpdate, workspaceNameUpdate, workspaceResponse } from "@tideline/contracts";
import type { createWorkspaceStore } from "@tideline/db";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkspaceContext } from "./workspace-routes";

const inviteLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const limit = bodyLimit({ maxSize: 2_048 });

function inviteHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function targetWorkspace(context: Context<WorkspaceContext>) {
  const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId")).data;
  return workspaceId && { workspaceId, userId: context.get("userId") };
}

function inaccessible(context: Context<WorkspaceContext>) {
  return context.json({ error: "Team or action unavailable." }, 404);
}

export function registerTeamRoutes(
  routes: Hono<WorkspaceContext>,
  workspaces: ReturnType<typeof createWorkspaceStore>,
  clerk: ReturnType<typeof createClerkClient>,
) {
  routes.get("/workspaces/list", async (context) => {
    return context.json(await workspaces.listAccessible(context.get("userId")));
  });

  routes.post("/workspaces/team", limit, async (context) => {
    const input = workspaceNameUpdate.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "Enter a workspace name between 1 and 80 characters." }, 400);
    return context.json(await workspaces.createTeam(context.get("userId"), input.data.name), 201);
  });

  routes.post("/workspaces/invites/accept", limit, async (context) => {
    const input = workspaceInviteAcceptance.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "This invitation link is invalid." }, 400);

    const user = await clerk.users.getUser(context.get("userId"));
    const verifiedEmails = user.emailAddresses.filter(({ verification }) => verification?.status === "verified")
      .map(({ emailAddress }) => emailAddress.trim().toLowerCase());
    const workspace = await workspaces.acceptInvite({ userId: user.id, tokenHash: inviteHash(input.data.token), verifiedEmails });
    return workspace ? context.json(workspace) : context.json({ error: "Use an account with the invited email. The link may have expired or been revoked." }, 409);
  });

  routes.get("/workspaces/:workspaceId/team", async (context) => {
    const access = targetWorkspace(context);
    const team = access && await workspaces.listTeam(access);
    return team ? context.json(team) : inaccessible(context);
  });

  routes.post("/workspaces/:workspaceId/invites", limit, async (context) => {
    const access = targetWorkspace(context);
    if (!access) return inaccessible(context);
    const input = workspaceInviteRequest.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "Enter a valid email and role." }, 400);

    const token = randomBytes(32).toString("hex");
    const invitation = await workspaces.createInvite(access, {
      ...input.data, tokenHash: inviteHash(token), expiresAt: new Date(Date.now() + inviteLifetimeMs),
    });
    return invitation ? context.json({ token, id: invitation.id }, 201) : inaccessible(context);
  });

  routes.delete("/workspaces/:workspaceId/invites/:inviteId", async (context) => {
    const access = targetWorkspace(context);
    const inviteId = workspaceResponse.shape.id.safeParse(context.req.param("inviteId")).data;
    return access && inviteId && await workspaces.revokeInvite(access, inviteId) ? context.body(null, 204) : inaccessible(context);
  });

  routes.patch("/workspaces/:workspaceId/members/:userId", limit, async (context) => {
    const access = targetWorkspace(context);
    if (!access) return inaccessible(context);
    const input = workspaceMemberUpdate.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "Choose a valid team role." }, 400);
    const changed = await workspaces.setMemberRole(access, { ...input.data, userId: context.req.param("userId") });
    return changed ? context.body(null, 204) : inaccessible(context);
  });

  routes.delete("/workspaces/:workspaceId/members/:userId", async (context) => {
    const access = targetWorkspace(context);
    return access && await workspaces.removeMember(access, context.req.param("userId")) ? context.body(null, 204) : inaccessible(context);
  });
}
