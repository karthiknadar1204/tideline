import { listWorkspaceSessions, readWorkspaceAccess, readWorkspaceUsageTargets } from "../../../../lib/workspace";
import { RefreshSessions } from "../refresh-sessions";
import { SyncSetup } from "../sync-setup";
import { UsageTargets } from "../usage-targets";
import { WorkspaceNameForm } from "./workspace-name-form";

export default async function WorkspaceSettingsPage({ params }: PageProps<"/workspace/[id]/settings">) {
  const { id } = await params;
  const [workspace, targets, sessions] = await Promise.all([
    readWorkspaceAccess(id),
    readWorkspaceUsageTargets(id),
    listWorkspaceSessions(id),
  ]);

  return (
    <main className="space-y-8 pt-7 sm:pt-9">
      <RefreshSessions />
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Settings</h1>
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <div className="grid gap-5">
          <section aria-labelledby="workspace-details" className="space-y-4 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-5">
            <h2 id="workspace-details" className="font-semibold">Workspace details</h2>
            {workspace.role === "member" ? <p className="text-sm">{workspace.name}</p> : <WorkspaceNameForm workspaceId={id} name={workspace.name} />}
          </section>
          <section aria-labelledby="private-data" className="space-y-2 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-5">
            <h2 id="private-data" className="font-semibold">Private data</h2>
            <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
              {workspace.kind === "team" ? "Team members can read the sessions synced here." : "Your account controls access to this workspace."} Run <code className="text-xs">sync setup</code> to change which repositories upload. Sessions already uploaded stay in the workspace.
            </p>
          </section>
        </div>
        <SyncSetup workspaceId={id} />
      </div>
      <UsageTargets workspaceId={id} targets={targets} sessions={sessions} canEdit={workspace.role !== "member"} />
    </main>
  );
}
