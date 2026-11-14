"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function WorkspaceNav({ workspaceId }: { workspaceId: string }) {
  const base = `/workspace/${workspaceId}`;
  const pathname = usePathname();
  const current = pathname.startsWith(`${base}/sessions/`) ? base : pathname;
  const links = [
    { href: base, label: "Sessions" },
    { href: `${base}/reports`, label: "Reports" },
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <nav aria-label="Workspace sections" className="flex gap-5 border-b border-[var(--workspace-border)] sm:gap-7">
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
