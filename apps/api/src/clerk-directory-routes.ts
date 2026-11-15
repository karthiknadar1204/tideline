import type { createClerkClient } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { clerkOrganizationId, workspaceClerkDirectory, workspaceClerkDirectoryLink, workspaceInviteRequest, workspaceResponse, workspaceSessionSearchQuery } from "@tideline/contracts";
import type { createClerkDirectoryStore } from "@tideline/db/clerk-directory";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WorkspaceContext } from "./workspace-routes";

const settingsPath = "/workspaces/:workspaceId/clerk-directory";
const membershipPageSize = 100;

function workspaceUser(context: Context<WorkspaceContext>) {
  const workspaceId = workspaceResponse.shape.id.safeParse(context.req.param("workspaceId")).data;
  return workspaceId && { workspaceId, userId: context.get("userId") };
}

function directoryMember(user: unknown, identifier: unknown, role: unknown, active: boolean) {
  const userId = workspaceSessionSearchQuery.shape.member.safeParse(user).data;
  if (!userId) return;
  const email = active ? workspaceInviteRequest.shape.email.safeParse(identifier).data ?? null : null;
  return { userId, email, role: role === "org:admin" ? "admin" as const : "member" as const, active };
}

async function organizationMembers(clerk: Pick<ReturnType<typeof createClerkClient>, "organizations">, organizationId: string) {
  const collected = new Map<string, NonNullable<ReturnType<typeof directoryMember>>>();
  let offset = 0;
  for (;;) {
    const batch = await clerk.organizations.getOrganizationMembershipList({ organizationId, limit: membershipPageSize, offset });
    for (const { publicUserData, role, organization } of batch.data) {
      const member = organization?.id === organizationId && directoryMember(publicUserData?.userId, publicUserData?.identifier, role, true);
      if (member) collected.set(member.userId, member);
    }
    offset += batch.data.length;
    if (!batch.data.length || offset >= batch.totalCount) return [...collected.values()];
  }
}

export function registerClerkDirectoryRoutes(
  routes: Hono<WorkspaceContext>,
  directory: ReturnType<typeof createClerkDirectoryStore>,
  clerk: Pick<ReturnType<typeof createClerkClient>, "organizations">,
  signingSecret: string | undefined,
) {
  routes.get(settingsPath, async (context) => {
    const access = workspaceUser(context);
    const status = access && await directory.status(access);
    return status ? context.json(workspaceClerkDirectory.parse({ ...status, configured: Boolean(signingSecret) }))
      : context.json({ error: "Team workspace not found." }, 404);
  });

  routes.post(settingsPath, bodyLimit({ maxSize: 1_024 }), async (context) => {
    if (!signingSecret) return context.json({ error: "Enterprise identity is not configured." }, 503);
    const access = workspaceUser(context);
    if (!access) return context.json({ error: "Team workspace not found." }, 404);
    const draft = workspaceClerkDirectoryLink.safeParse(await context.req.json().catch(() => null));
    if (!draft.success) return context.json({ error: "Choose a Clerk organization." }, 400);

    const { organizationId } = draft.data;
    try {
      const { data } = await clerk.organizations.getOrganizationMembershipList({ organizationId, userId: [access.userId], limit: 1 });
      if (!data.some((membership) => membership.organization?.id === organizationId && membership.role === "org:admin" && membership.publicUserData?.userId === access.userId)) {
        return context.json({ error: "An administrator of the Clerk organization must link it." }, 403);
      }
    } catch {
      return context.json({ error: "Could not verify Clerk organization access." }, 502);
    }

    const result = await directory.link(access, organizationId);
    if (result === "unavailable") return context.json({ error: "Team workspace not found." }, 404);
    if (result === "conflict") return context.json({ error: "This workspace or organization is already linked elsewhere." }, 409);
    try {
      const observedAt = new Date();
      const members = await organizationMembers(clerk, organizationId);
      await directory.reconcile(organizationId, members, observedAt);
    } catch {
      return context.json({ error: "The organization is linked. Retry syncing its members." }, 502);
    }
    return context.json(workspaceClerkDirectory.parse({ configured: true, organizationId }));
  });

  routes.delete(settingsPath, async (context) => {
    const access = workspaceUser(context);
    return access && await directory.unlink(access) ? context.body(null, 204) : context.json({ error: "Team workspace not found." }, 404);
  });

  routes.post("/webhooks/clerk-directory", bodyLimit({ maxSize: 262_144 }), async (context) => {
    if (!signingSecret) return context.json({ error: "Enterprise identity is not configured." }, 503);
    const event = await verifyWebhook(context.req.raw, { signingSecret }).catch(() => null);
    if (!event) return context.json({ error: "Invalid Clerk signature." }, 400);
    const at = new Date(event.timestamp);
    if (!Number.isFinite(at.getTime())) return context.json({ error: "Invalid event timestamp." }, 400);

    switch (event.type) {
      case "organizationMembership.created":
      case "organizationMembership.updated":
      case "organizationMembership.deleted": {
        const organization = clerkOrganizationId.safeParse(event.data.organization?.id).data;
        const member = directoryMember(event.data.public_user_data?.user_id, event.data.public_user_data?.identifier, event.data.role,
          event.type !== "organizationMembership.deleted");
        if (!organization || !member) return context.json({ error: "Invalid organization membership." }, 400);
        await directory.changeMembership(organization, member, at);
        break;
      }
      case "organization.deleted": {
        const organization = clerkOrganizationId.safeParse(event.data.id).data;
        if (organization) await directory.removeOrganization(organization);
        break;
      }
      case "user.updated":
      case "user.deleted": {
        const user = workspaceSessionSearchQuery.shape.member.safeParse(event.data.id).data;
        const inactive = event.type === "user.deleted" ? true : event.data.deprovisioned;
        if (user && typeof inactive === "boolean") await directory.setUserBlocked(user, inactive, at);
        break;
      }
    }
    return context.body(null, 204);
  });
}
