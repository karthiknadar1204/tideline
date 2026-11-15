import Link from "next/link";
import { teamLink, teamPanel, workspaceRoleLabel } from "../../../../lib/team-ui";
import { readWorkspaceAccess } from "../../../../lib/workspace";
import { WorkspaceNameForm } from "./workspace-name-form";

export default async function WorkspaceSettingsPage({ params }: PageProps<"/workspace/[id]/settings">) {
  const { id } = await params;
  const workspace = await readWorkspaceAccess(id);

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
      <section aria-labelledby="private-data" className={teamPanel}>
        <h2 id="private-data" className="font-semibold">Session visibility</h2>
        <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
          {workspace.kind === "team" ? "Team members can read sessions synced here." : "You control who can view links you share from this workspace."}
        </p>
        <Link className={teamLink} href="/docs/data-and-privacy">What Tideline uploads</Link>
      </section>
    </main>
  );
}
