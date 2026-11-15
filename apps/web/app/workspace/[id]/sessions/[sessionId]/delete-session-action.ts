"use server";

import { workspaceResponse } from "@tideline/contracts";
import type { WorkspaceSessionSearchQuery } from "@tideline/contracts";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { sessionListHref } from "../../../../../lib/session-filters";
import { fetchWorkspaceResource } from "../../../../../lib/workspace";

export async function deleteSession(workspaceId: string, sessionId: string, filters: WorkspaceSessionSearchQuery): Promise<string | null> {
  const uuid = workspaceResponse.shape.id;
  if (!uuid.safeParse(workspaceId).success || !uuid.safeParse(sessionId).success) notFound();
  const response = await fetchWorkspaceResource(`${workspaceId}/sessions/${sessionId}`, { method: "DELETE", allowNotFound: true });
  if (!response?.ok) return "Could not delete this session. Refresh to check whether it is still available.";

  revalidatePath(`/workspace/${workspaceId}`, "layout");
  redirect(sessionListHref(workspaceId, { ...filters, page: 1 }));
}
