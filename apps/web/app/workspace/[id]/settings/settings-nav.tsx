"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SettingsNav({ workspaceId, team }: { workspaceId: string; team: boolean }) {
  const base = `/workspace/${workspaceId}`;
  const pathname = usePathname();
  const sections = [
    { href: `${base}/settings`, label: "General" },
    { href: `${base}/settings/uploads`, label: "Uploads" },
    { href: `${base}/settings/usage`, label: "Usage limits" },
    { href: `${base}/settings/integrations`, label: "Integrations" },
    { href: `${base}/reports/saved`, label: "Saved reports" },
    ...(team ? [{ href: `${base}/members`, label: "Members" }] : []),
  ];

  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-x-5 gap-y-1 border-b border-[var(--workspace-border)]">
      {sections.map(({ href, label }) => (
        <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}
          className="inline-flex min-h-10 items-center border-b-2 border-transparent px-1 text-sm font-medium text-[var(--workspace-muted)] outline-offset-2 hover:text-[var(--workspace-text)] focus-visible:rounded-sm focus-visible:outline-2 aria-[current=page]:border-[var(--workspace-accent)] aria-[current=page]:text-[var(--workspace-accent)]">
          {label}
        </Link>
      ))}
    </nav>
  );
}
