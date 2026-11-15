import { listWorkspaceSessions, readWorkspaceAccess, readWorkspaceUsageTargets } from "../../../../../lib/workspace";
import { RefreshSessions } from "../../refresh-sessions";
import { UsageTargets } from "../../usage-targets";

export default async function WorkspaceUsageSettings({ params }: PageProps<"/workspace/[id]/settings/usage">) {
  const { id } = await params;
  const [workspace, targets, sessions] = await Promise.all([
    readWorkspaceAccess(id),
    readWorkspaceUsageTargets(id),
    listWorkspaceSessions(id),
  ]);

  return (
    <main aria-label="Usage limits" className="max-w-5xl">
      <RefreshSessions />
      <UsageTargets workspaceId={id} targets={targets} sessions={sessions} canEdit={workspace.role !== "member"} />
    </main>
  );
}
