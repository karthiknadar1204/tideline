"use server";

import { workspaceAccess, workspaceInviteAcceptance } from "@tideline/contracts";
import { redirect } from "next/navigation";
import type { TeamActionState } from "../../../lib/team-ui";
import { fetchWorkspaceResource } from "../../../lib/workspace";

export async function acceptInvite(token: string): Promise<TeamActionState> {
  const input = workspaceInviteAcceptance.safeParse({ token });
  if (!input.success) return { kind: "error", message: "This invitation is unavailable. Ask for a fresh link." };

  const response = await fetchWorkspaceResource("invites/accept", {
    method: "POST",
    allowNotFound: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.data),
  });
  if (response?.status === 409 || response?.status === 404) {
    return { kind: "error", message: "Check that you’re signed in with the verified email that was invited. If the link expired or was revoked, ask for a new one." };
  }
  if (!response?.ok) return { kind: "error", message: "Could not join the workspace. Try again." };

  const workspace = workspaceAccess.parse(await response.json());
  redirect(`/workspace/${workspace.id}`);
}
