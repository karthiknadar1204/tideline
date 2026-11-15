import Link from "next/link";
import { teamLink, teamPanel, workspaceRoleLabel } from "../../../../lib/team-ui";
import { readWorkspaceAccess, readWorkspaceAddress } from "../../../../lib/workspace";
import { DeleteWorkspaceForm } from "./delete-workspace-form";
import { SyncCoverage } from "./sync-coverage";
import { WorkspaceNameForm } from "./workspace-name-form";
import { WorkspaceAliasForm } from "./workspace-alias-form";

export default async function WorkspaceSettingsPage({ params }: PageProps<"/workspace/[id]/settings">) {
  const { id } = await params;
  const [workspace, address] = await Promise.all([readWorkspaceAccess(id), readWorkspaceAddress(id)]);

  return (
    <main aria-label="General settings" className="grid max-w-4xl gap-4">
      <section aria-labelledby="workspace-details" className={teamPanel}>
        <h2 id="workspace-details" className="font-semibold">Workspace details</h2>
        {workspace.role === "member" ? <p className="text-sm">{workspace.name}</p> : <WorkspaceNameForm workspaceId={id} name={workspace.name} />}
        <dl className="flex flex-wrap gap-x-8 gap-y-2 border-t border-[var(--workspace-border)] pt-3 text-sm">
          <div>
            <dt className="text-xs text-[var(--workspace-muted)]">Workspace type</dt>
            <dd className="mt-1 font-medium">{workspace.kind === "team" ? "Team" : "Personal"}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--workspace-muted)]">Your role</dt>
            <dd className="mt-1 font-medium">{workspaceRoleLabel[workspace.role]}</dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby="workspace-url" className={teamPanel}>
        <h2 id="workspace-url" className="font-semibold">Workspace URL</h2>
        {workspace.role === "owner" && <WorkspaceAliasForm key={address.alias} workspaceId={id} alias={address.alias} />}
        <Link href={`/workspace/${address.alias ?? id}/dashboard`} className={`${teamLink} break-all`}>/workspace/{address.alias ?? id}</Link>
        {workspace.role === "owner" && <p className="text-sm text-[var(--workspace-muted)]">Previous workspace links continue to work after you change the URL.</p>}
      </section>
      <section aria-labelledby="private-data" className={teamPanel}>
        <h2 id="private-data" className="font-semibold">Session visibility</h2>
        <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
          {workspace.kind === "team" ? "Team members can read sessions synced here." : "You control who can view links you share from this workspace."}
        </p>
        {workspace.role !== "member" && (
          <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">To delete a session and revoke its share link, open it from <Link className={teamLink} href={`/workspace/${id}`}>Sessions</Link>.</p>
        )}
        <Link className={teamLink} href="/docs/data-and-privacy">What Tideline uploads</Link>
      </section>
      <SyncCoverage workspaceId={id} />
      {workspace.role === "owner" && (
        <section aria-labelledby="delete-workspace" className={teamPanel}>
          <h2 id="delete-workspace" className="font-semibold">Danger zone</h2>
          <p className="text-sm text-[var(--workspace-muted)]">Delete this workspace and its synced sessions, reports, and settings. This also revokes its share links and stops authorized collectors from uploading here.</p>
          <DeleteWorkspaceForm workspaceId={workspace.id} workspaceName={workspace.name} />
        </section>
      )}
    </main>
  );
}
