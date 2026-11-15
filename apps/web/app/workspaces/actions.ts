"use server";

import { workspaceAccess, workspaceNameUpdate } from "@tideline/contracts";
import { redirect } from "next/navigation";
import type { TeamActionState } from "../../lib/team-ui";
import { fetchWorkspaceResource } from "../../lib/workspace";

export async function createTeamWorkspace(_previous: TeamActionState, form: FormData): Promise<TeamActionState> {
  const input = workspaceNameUpdate.safeParse({ name: form.get("name") });
  if (!input.success) return { kind: "error", message: "Enter a workspace name between 1 and 80 characters." };

  const response = await fetchWorkspaceResource("team", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.data),
  });
  if (!response?.ok) return { kind: "error", message: "Could not create the workspace. Try again." };

  const workspace = workspaceAccess.parse(await response.json());
  redirect(`/workspace/${workspace.id}/dashboard`);
}
