import { UserButton } from "@clerk/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import { teamPanel, workspaceRoleLabel } from "../../lib/team-ui";
import { listAccessibleWorkspaces, requestWorkspace } from "../../lib/workspace";
import { CreateTeamForm } from "./create-team-form";

export const metadata: Metadata = {
  title: "Workspaces | Tideline",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function WorkspacesPage() {
  await requestWorkspace("personal", "POST");
  const workspaces = await listAccessibleWorkspaces();

  return (
    <div className="tideline-workspace min-h-dvh bg-[var(--workspace-bg)] text-[var(--workspace-text)]">
      <div className="mx-auto w-full max-w-5xl px-4 pb-14 sm:px-8">
        <header className="flex min-h-16 items-center justify-between gap-3 border-b border-[var(--workspace-border)]">
          <Link className="font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4" href="/">Tideline</Link>
          <UserButton />
        </header>
        <main className="space-y-6 pt-7 sm:pt-9">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Workspaces</h1>
          <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_minmax(16rem,21rem)]">
            <ul aria-label="Your workspaces" className="divide-y divide-[var(--workspace-border)] overflow-hidden rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)]">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <Link href={`/workspace/${workspace.id}/dashboard`} className="flex min-w-0 items-center justify-between gap-3 px-4 py-4 hover:bg-[var(--workspace-subtle)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--workspace-accent)] sm:px-5">
                    <span className="min-w-0 break-all">
                      <span className="block font-medium">{workspace.name}</span>
                      <span className="mt-1 block text-sm text-[var(--workspace-muted)]">{workspace.kind === "personal" ? "Personal" : `Team · ${workspaceRoleLabel[workspace.role]}`}</span>
                    </span>
                    <span className="shrink-0 text-sm font-medium text-[var(--workspace-accent)]" aria-hidden="true">Open</span>
                  </Link>
                </li>
              ))}
            </ul>
            <section className={teamPanel} aria-labelledby="new-team">
              <h2 className="font-semibold" id="new-team">New team workspace</h2>
              <CreateTeamForm />
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
