"use server";

import { workspaceClerkDirectoryLink, workspaceResponse } from "@tideline/contracts";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import type { TeamActionState } from "../../../../../lib/team-ui";
import { fetchWorkspaceResource } from "../../../../../lib/workspace";

export type DirectoryActionState = TeamActionState | { kind: "saved" };

export async function linkDirectory(workspaceId: string, _previous: DirectoryActionState, form: FormData): Promise<DirectoryActionState> {
  const id = workspaceResponse.shape.id.safeParse(workspaceId).data;
  if (!id) notFound();
  const input = workspaceClerkDirectoryLink.safeParse({ organizationId: form.get("organizationId") });
  if (!input.success) return { kind: "error", message: "Choose a Clerk organization." };
  const response = await fetchWorkspaceResource(`${id}/clerk-directory`, { method: "POST", allowNotFound: true,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data) });
  const errors: Record<number, string> = {
    403: "Sign in as an administrator of the selected Clerk organization.",
    409: "This workspace or organization already has a different link.",
    502: "Could not verify or sync Clerk members. Try again.",
  };
  if (!response?.ok) return { kind: "error", message: errors[response?.status ?? 0] ?? "Could not link this organization." };
  revalidatePath(`/workspace/${id}`, "layout");
  return { kind: "saved" };
}

export async function unlinkDirectory(workspaceId: string): Promise<DirectoryActionState> {
  const id = workspaceResponse.shape.id.safeParse(workspaceId).data;
  if (!id) notFound();
  const response = await fetchWorkspaceResource(`${id}/clerk-directory`, { method: "DELETE", allowNotFound: true });
  if (!response?.ok) return { kind: "error", message: "Could not disconnect the organization." };
  revalidatePath(`/workspace/${id}`, "layout");
  return { kind: "saved" };
}
