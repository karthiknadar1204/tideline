"use client";

import type { WorkspaceAccess } from "@tideline/contracts";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import styles from "./workspace-shell.module.css";

type RepositoryLink = { key: string; name: string };

export function WorkspaceNav({ workspace, workspaces, repositories, children }: {
  workspace: WorkspaceAccess;
  workspaces: WorkspaceAccess[];
  repositories: RepositoryLink[];
  children: ReactNode;
}) {
  const base = `/workspace/${workspace.id}`;
  const pathname = usePathname();
  const currentRepo = useSearchParams().get("repository");
  const sessionsActive = pathname === base || pathname.startsWith(`${base}/sessions/`);
  const settingsActive = pathname.startsWith(`${base}/settings`) || pathname === `${base}/members`;
  const links = [
    { href: `${base}/dashboard`, label: "Dashboard", active: pathname === `${base}/dashboard` },
    { href: base, label: "Sessions", active: sessionsActive },
    { href: `${base}/repositories`, label: "Repositories", active: pathname === `${base}/repositories` && !currentRepo },
    { href: `${base}/skills`, label: "Skills", active: pathname === `${base}/skills` },
    { href: `${base}/mcp`, label: "MCP", active: pathname === `${base}/mcp` },
    { href: `${base}/reports`, label: "Reports", active: pathname.startsWith(`${base}/reports`) },
  ];

  return (
    <aside className={styles.rail}>
      <div className={styles.top}>
        <Link href={`${base}/dashboard`} className={styles.brand} aria-label="Tideline dashboard">
          <span aria-hidden="true" className={styles.mark} />
          Tideline
        </Link>
        <div className={styles.user}>{children}</div>
      </div>

      <details className={styles.switcher} key={workspace.id}>
        <summary aria-label="Switch workspace" title={workspace.name}>
          <span className={styles.workspaceAvatar} aria-hidden="true">{workspace.name.trim().slice(0, 1).toLocaleUpperCase()}</span>
          <span className={styles.workspaceName}>{workspace.name}</span>
          <span className={styles.caret} aria-hidden="true" />
        </summary>
        <div className={styles.menu}>
          {workspaces.map((item) => (
            <Link key={item.id} href={`/workspace/${item.id}/dashboard`} aria-current={item.id === workspace.id ? "true" : undefined}
              onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}>
              {item.name}
            </Link>
          ))}
          <Link href="/workspaces">Manage workspaces</Link>
        </div>
      </details>

      <nav className={styles.primary} aria-label="Workspace sections">
        {links.map(({ href, label, active }) => (
          <Link key={href} className={styles.navLink} href={href} aria-current={active ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>

      {repositories.length > 0 && (
        <nav aria-label="Recent repositories" className={styles.repositories}>
          <p>Recent repositories</p>
          {repositories.map(({ key, name }) => (
            <Link key={key} className={styles.navLink} href={`${base}/repositories?${new URLSearchParams({ repository: key })}`}
              aria-current={pathname === `${base}/repositories` && currentRepo === key ? "page" : undefined} title={name}>
              {name}
            </Link>
          ))}
        </nav>
      )}

      <nav className={styles.utilities} aria-label="Workspace management">
        <Link className={styles.navLink} href={`${base}/settings/uploads`} aria-current={pathname === `${base}/settings/uploads` ? "page" : undefined}>Sync setup</Link>
        <Link className={styles.navLink} href={`${base}/settings`} aria-current={settingsActive && pathname !== `${base}/settings/uploads` ? "page" : undefined}>Settings</Link>
      </nav>
    </aside>
  );
}
