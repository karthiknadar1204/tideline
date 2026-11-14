import { UserButton } from "@clerk/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import { readWorkspaceAccess } from "../../../lib/workspace";
import { WorkspaceNav } from "./workspace-nav";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function WorkspaceLayout({ children, params }: LayoutProps<"/workspace/[id]">) {
  const { id } = await params;
  const workspace = await readWorkspaceAccess(id);

  return (
    <div className="tideline-workspace min-h-dvh bg-[var(--workspace-bg)] text-[var(--workspace-text)]">
      <div className="mx-auto w-full max-w-7xl px-4 pb-14 sm:px-8 lg:px-12">
        <header className="flex min-h-16 items-center gap-3 border-b border-[var(--workspace-border)] sm:gap-4">
          <Link className="font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4" href="/">Tideline</Link>
          <span aria-hidden="true" className="text-[var(--workspace-muted)]">/</span>
          <Link
            href={`/workspace/${id}`}
            className="min-w-0 truncate text-sm font-medium text-[var(--workspace-muted)] hover:text-[var(--workspace-accent)] focus-visible:outline-2 focus-visible:outline-offset-4"
            title={workspace.name}
          >
            {workspace.name}
          </Link>
          <div className="ml-auto flex shrink-0 items-center gap-3 sm:gap-5">
            <Link
              className="text-sm font-medium text-[var(--workspace-accent)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
              href="/workspaces"
            >
              Workspaces
            </Link>
            <UserButton />
          </div>
        </header>
        <WorkspaceNav workspaceId={id} showMembers={workspace.kind === "team"} />
        {children}
      </div>
    </div>
  );
}
