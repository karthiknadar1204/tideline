import Link from "next/link";
import { repositorySyncResponse } from "@tideline/contracts";
import { teamLink, teamPanel } from "../../../../../lib/team-ui";
import { fetchWorkspaceResource, hasWorkspaceCliApproval, searchWorkspaceSessions } from "../../../../../lib/workspace";
import { CopyTerminalCommand } from "../../../../copy-terminal-command";
import { RefreshSessions } from "../../refresh-sessions";
import { SyncSetup } from "../../sync-setup";

const stateLabels = { enabled: "Enabled", paused: "Paused", unreported: "Unreported" };

export default async function WorkspaceUploadsSettings({ params, searchParams }: PageProps<"/workspace/[id]/settings/uploads">) {
  const [{ id }, { q }] = await Promise.all([params, searchParams]);
  const query = typeof q === "string" ? q.trim().replaceAll("\0", "").slice(0, 100) : "";
  const [{ sessions }, approved, response] = await Promise.all([
    searchWorkspaceSessions(id, { page: 1 }),
    hasWorkspaceCliApproval(id),
    fetchWorkspaceResource(`${encodeURIComponent(id)}/repository-sync?${new URLSearchParams({ q: query })}`, { allowNotFound: true }),
  ]);
  const repositories = response?.ok ? repositorySyncResponse.parse(await response.json()) : [];
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
        <h2 id="synced-repositories" className="font-semibold">Repository uploads</h2>
        <p className="text-sm text-[var(--workspace-muted)]">Run the picker on the computer where you want to change the selection.</p>
        <CopyTerminalCommand command="tideline upload" label="Copy repository picker command" />
        <form className="flex flex-wrap items-center gap-2" action={`${base}/settings/uploads`}>
          <label className="sr-only" htmlFor="upload-repo-search">Find a repository</label>
          <input type="search" id="upload-repo-search" name="q" maxLength={100} defaultValue={query} placeholder="Find a repository"
            className="min-w-0 flex-1 rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-panel)] px-3 py-2 text-sm" />
          <button type="submit" className="rounded-lg border border-[var(--workspace-border)] px-3 py-2 text-sm font-medium">Find</button>
        </form>
        {repositories.length > 0 ? (
          <div className="min-w-0 overflow-x-auto rounded-lg border border-[var(--workspace-border)]">
            <table className="min-w-full divide-y divide-[var(--workspace-border)] text-left text-sm">
              <thead className="bg-[var(--workspace-subtle)] text-[var(--workspace-muted)]"><tr>
                <th className="p-3" scope="col">Repository</th><th className="p-3" scope="col">Synced sessions</th><th className="p-3" scope="col">Auto-upload</th>
              </tr></thead>
              <tbody className="divide-y divide-[var(--workspace-border)]">
                {repositories.map(({ key, name, sessions: count, state }) => (
                  <tr key={key}>
                    <th className="break-all p-3 font-medium" scope="row">{count ? <Link className={teamLink} href={`${base}/repositories?${new URLSearchParams({ repository: key, days: "all" })}`}>{name}</Link> : name}</th>
                    <td className="p-3 tabular-nums">{count.toLocaleString("en-US")}</td>
                    <td className="p-3"><span className={state === "enabled" ? "font-medium text-[var(--workspace-accent)]" : "text-[var(--workspace-muted)]"}>{stateLabels[state]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-[var(--workspace-muted)]">{query ? "No repositories match this search." : "Repositories appear once a collector reports them or syncs their first session."}</p>}
        {repositories.length === 100 && <p className="text-sm text-[var(--workspace-muted)]">Showing the first 100 repositories. Use search to find more.</p>}
      </section>
    </main>
  );
}
