"use server";

import { workspaceInviteLink, workspaceInviteRequest, workspaceMemberUpdate, workspaceResponse, workspaceTeam } from "@tideline/contracts";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import type { TeamActionState } from "../../../../lib/team-ui";
import { fetchWorkspaceResource } from "../../../../lib/workspace";

export type InviteActionState = TeamActionState | { kind: "created"; token: string; id: string };

function membersPath(workspaceId: string) {
  if (!workspaceResponse.shape.id.safeParse(workspaceId).success) notFound();
  return `/workspace/${workspaceId}/members`;
}

export async function inviteMember(workspaceId: string, _previous: InviteActionState, form: FormData): Promise<InviteActionState> {
  const path = membersPath(workspaceId);
  const input = workspaceInviteRequest.safeParse({ email: form.get("email"), role: form.get("role") });
  if (!input.success) return { kind: "error", message: "Enter a valid email address and choose a role." };

  const response = await fetchWorkspaceResource(`${workspaceId}/invites`, {
    method: "POST",
    allowNotFound: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.data),
  });
  if (response?.status === 404) return { kind: "error", message: "Could not invite this person. Check their existing access and the role you selected." };
  if (!response?.ok) return { kind: "error", message: "Could not create the invitation. Try again." };

  const invite = workspaceInviteLink.parse(await response.json());
  revalidatePath(path);
  return { kind: "created", ...invite };
}

export async function revokeInvite(workspaceId: string, inviteId: string, _previous: TeamActionState): Promise<TeamActionState> {
  const path = membersPath(workspaceId);
  if (!workspaceResponse.shape.id.safeParse(inviteId).success) notFound();
  const response = await fetchWorkspaceResource(`${workspaceId}/invites/${inviteId}`, { method: "DELETE", allowNotFound: true });
  if (!response?.ok) return { kind: "error", message: "Could not revoke this invitation. Refresh to check its status." };

  revalidatePath(path);
  return { kind: "idle" };
}

export async function updateMember(workspaceId: string, userId: string, _previous: TeamActionState, form: FormData): Promise<TeamActionState> {
  const path = membersPath(workspaceId);
  if (!workspaceTeam.shape.members.element.shape.userId.safeParse(userId).success) notFound();
  const resource = `${workspaceId}/members/${encodeURIComponent(userId)}`;

  const remove = form.get("intent") === "remove";
  const input = workspaceMemberUpdate.safeParse({ role: form.get("role") });
  if (!remove && !input.success) return { kind: "error", message: "Choose a role." };

  const response = await fetchWorkspaceResource(resource, remove ? { method: "DELETE", allowNotFound: true } : {
    method: "PATCH",
    allowNotFound: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.data),
  });
  if (!response?.ok) return { kind: "error", message: "Could not update this member. Refresh to check their access." };

  revalidatePath(path);
  return { kind: "idle" };
}
