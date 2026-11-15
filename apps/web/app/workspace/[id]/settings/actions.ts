"use server";

import { confirmWorkspaceDeletion, workspaceAliasUpdate, workspaceNameUpdate, workspaceResponse } from "@tideline/contracts";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import type { TeamActionState } from "../../../../lib/team-ui";
import { fetchWorkspaceResource, updateWorkspaceName } from "../../../../lib/workspace";

export type NameSaveResult = { kind: "idle" } | { kind: "saved"; name: string } | { kind: "error"; message: string };

export async function saveWorkspaceName(workspaceId: string, form: FormData): Promise<NameSaveResult> {
  const id = workspaceResponse.shape.id.safeParse(workspaceId);
  if (!id.success) notFound();
  const update = workspaceNameUpdate.safeParse({ name: form.get("name") });
  if (!update.success) return { kind: "error", message: "Enter a workspace name between 1 and 80 characters." };
  const workspace = await updateWorkspaceName(id.data, update.data);
  if (!workspace) return { kind: "error", message: "Could not save the name. Try again." };

  revalidatePath(`/workspace/${id.data}`, "layout");
  return { kind: "saved", name: workspace.name };
}

export async function deleteWorkspace(workspaceId: string, _previous: TeamActionState, form: FormData): Promise<TeamActionState> {
  const id = workspaceResponse.shape.id.safeParse(workspaceId);
  if (!id.success) notFound();
  const draft = confirmWorkspaceDeletion.safeParse({ name: form.get("name") });
  if (!draft.success) return { kind: "error", message: "Enter the workspace name to confirm deletion." };

  const response = await fetchWorkspaceResource(id.data, { method: "DELETE", allowNotFound: true,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft.data) });
  if (response?.status === 409) return { kind: "error", message: "Enter the workspace name exactly as it appears in Settings." };
  if (response?.status !== 204) return { kind: "error", message: "Could not delete the workspace. Refresh to check if it is still available." };

  revalidatePath(`/workspace/${id.data}`, "layout");
  revalidatePath("/workspaces");
  redirect("/workspaces");
}

export async function saveWorkspaceAlias(workspaceId: string, _previous: TeamActionState, form: FormData): Promise<TeamActionState> {
  const id = workspaceResponse.shape.id.safeParse(workspaceId).data;
  if (!id) notFound();
  const draft = workspaceAliasUpdate.safeParse({ alias: form.get("alias") });
  if (!draft.success) return { kind: "error", message: "Enter 3 to 48 letters, digits, or hyphens, starting with a letter." };

  const response = await fetchWorkspaceResource(`${id}/address`, { method: "PATCH", allowNotFound: true,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft.data) });
  if (response?.status === 409) return { kind: "error", message: "That workspace URL alias is in use." };
  if (!response?.ok) return { kind: "error", message: "Could not save the workspace URL. Try again." };

  revalidatePath(`/workspace/${id}`, "layout");
  redirect(`/workspace/${draft.data.alias}/settings`);
}
