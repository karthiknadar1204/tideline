import Link from "next/link";

export function ReportNavigation({ workspaceId, active }: { workspaceId: string; active: "usage" | "trends" | "intelligence" | "weekly" | "saved" | "github" }) {
  const base = `/workspace/${encodeURIComponent(workspaceId)}/reports`;
  const links = [
    { id: "usage", href: base, label: "Usage reports" },
    { id: "trends", href: `${base}/trends`, label: "Trends" },
    { id: "intelligence", href: `${base}/intelligence`, label: "Session intelligence" },
    { id: "weekly", href: `${base}/weekly`, label: "Weekly" },
    { id: "saved", href: `${base}/saved`, label: "Saved reports" },
    { id: "github", href: `${base}/github`, label: "GitHub" },
  ];
  return (
    <nav aria-label="Report sections" className="flex flex-wrap gap-x-5 border-b border-[var(--workspace-border)]">
      {links.map(({ id, href, label }) => (
        <Link key={id} href={href} aria-current={id === active ? "page" : undefined}
          className="-mb-px border-b-2 border-transparent px-0.5 py-2.5 text-sm font-medium text-[var(--workspace-muted)] hover:text-[var(--workspace-text)] aria-[current=page]:border-[var(--workspace-accent)] aria-[current=page]:text-[var(--workspace-accent)]">
          {label}
        </Link>
      ))}
    </nav>
  );
}
