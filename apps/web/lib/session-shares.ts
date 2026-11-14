import { sessionShareStatus } from "@tideline/contracts";
import { fetchWorkspaceResource } from "./workspace";

export function sessionSharePath(workspaceId: string, sessionId: string) {
  return `${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/share`;
}

export async function readSessionShare(workspaceId: string, sessionId: string) {
  const response = await fetchWorkspaceResource(sessionSharePath(workspaceId, sessionId), { allowNotFound: true });
  if (response?.ok) return sessionShareStatus.parse(await response.json());
}
