"use server";

import type { CreateSessionShareRequest } from "@tideline/contracts";
import { revalidatePath } from "next/cache";
import { sessionSharePath } from "../../../../../lib/session-shares";
import { fetchWorkspaceResource } from "../../../../../lib/workspace";

export type ShareFeedback = { kind: "idle" } | { kind: "saved" | "error"; message: string };

export async function changeSessionShare(
  workspaceId: string,
  sessionId: string,
  displayed: CreateSessionShareRequest,
  _previous: ShareFeedback,
  form: FormData,
): Promise<ShareFeedback> {
  const intent = form.get("intent");
  if (intent !== "create" && intent !== "revoke") return { kind: "error", message: "Choose a sharing action." };
  const creating = intent === "create";
  const response = await fetchWorkspaceResource(sessionSharePath(workspaceId, sessionId), {
    allowNotFound: true,
    method: creating ? "POST" : "DELETE",
    ...(creating ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(displayed) } : {}),
  });
  if (response?.status === 409) {
    revalidatePath(`/workspace/${workspaceId}/sessions/${sessionId}`);
    return { kind: "error", message: "The conversation changed. Review it before sharing." };
  }
  if (!response?.ok) return { kind: "error", message: "Could not update sharing. Refresh and try again." };

  revalidatePath(`/workspace/${workspaceId}/sessions/${sessionId}`);
  return { kind: "saved", message: creating ? "Share link created." : "Share link revoked." };
}
