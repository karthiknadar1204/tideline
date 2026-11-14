"use server";

import { workspaceNameUpdate, workspaceResponse } from "@tideline/contracts";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { updateWorkspaceName } from "../../../../lib/workspace";

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
