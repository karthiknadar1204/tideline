import Link from "next/link";
import { teamLink, teamPanel } from "../../../../../lib/team-ui";
import { hasWorkspaceCliApproval, searchWorkspaceSessions } from "../../../../../lib/workspace";
import { RefreshSessions } from "../../refresh-sessions";
import { SyncSetup } from "../../sync-setup";

export default async function WorkspaceUploadsSettings({ params }: PageProps<"/workspace/[id]/settings/uploads">) {
  const { id } = await params;
  const [{ sessions, repositories }, approved] = await Promise.all([
    searchWorkspaceSessions(id, { page: 1 }),
    hasWorkspaceCliApproval(id),
  ]);
  const base = `/workspace/${id}`;
  const recent = sessions[0];

  return (
    <main aria-label="Upload settings" className="grid max-w-4xl gap-4">
      <RefreshSessions />
      <section className={teamPanel} aria-labelledby="cli-status">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="cli-status" className="font-semibold">CLI approval</h2>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${approved ? "bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent)]" : "bg-[var(--workspace-subtle)] text-[var(--workspace-muted)]"}`}>
            {approved ? "Approved" : "Awaiting approval"}
          </span>
        </div>
        {recent ? (
          <p className="text-sm text-[var(--workspace-muted)]">Latest session in Tideline <Link className={teamLink} href={`${base}/sessions/${recent.id}`}>{recent.title}</Link></p>
        ) : <p className="text-sm text-[var(--workspace-muted)]">Synced sessions will appear here once your CLI sends them.</p>}
      </section>
      <SyncSetup workspaceId={id} />
      <section className={teamPanel} aria-labelledby="synced-repositories">
        <h2 id="synced-repositories" className="font-semibold">Repositories with synced sessions</h2>
        {repositories.length > 0 ? (
          <ul className="divide-y divide-[var(--workspace-border)] border-t border-[var(--workspace-border)]">
            {repositories.map(({ key, name }) => (
              <li key={key}>
                <Link href={`${base}/repositories?${new URLSearchParams({ repository: key })}`} className="flex items-center gap-3 py-2.5 text-sm hover:text-[var(--workspace-accent)] focus-visible:outline-2">
                  <span className="min-w-0 flex-1 break-words">{name}</span><span aria-hidden="true" className="text-[var(--workspace-muted)]">↗</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-[var(--workspace-muted)]">Repositories appear after you sync their first session.</p>}
      </section>
    </main>
  );
}
