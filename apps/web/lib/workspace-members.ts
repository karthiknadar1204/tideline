import type { WorkspaceTeam } from "@tideline/contracts";

export function workspaceMemberLabels(members: WorkspaceTeam["members"], viewerId?: string | null) {
  let memberNumber = 0;
  return new Map(members.map(({ userId, role, email }) => {
    const fallback = role === "owner" ? "Workspace owner" : `Team member ${++memberNumber}`;
    return [userId, userId === viewerId ? "You" : email ?? fallback];
  }));
}
