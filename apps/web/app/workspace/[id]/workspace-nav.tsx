"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function WorkspaceNav({ workspaceId, showMembers }: { workspaceId: string; showMembers: boolean }) {
  const base = `/workspace/${workspaceId}`;
  const reports = `${base}/reports`;
  const pathname = usePathname();
  const current = pathname.startsWith(`${base}/sessions/`) ? base : pathname.startsWith(`${reports}/`) ? reports : pathname;
  const links = [
    { href: base, label: "Sessions" },
    { href: reports, label: "Reports" },
    ...(showMembers ? [{ href: `${base}/members`, label: "Members" }] : []),
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <nav aria-label="Workspace sections" className="flex flex-wrap gap-x-3 border-b border-[var(--workspace-border)] min-[360px]:gap-x-5 sm:gap-x-7">
      {links.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          aria-current={current === href ? "page" : undefined}
          className="inline-flex min-h-11 items-center border-b-2 border-transparent px-1 text-sm font-medium text-[var(--workspace-muted)] hover:text-[var(--workspace-accent)] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-[var(--workspace-accent)] aria-[current=page]:border-[var(--workspace-accent)] aria-[current=page]:text-[var(--workspace-accent)]"
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
