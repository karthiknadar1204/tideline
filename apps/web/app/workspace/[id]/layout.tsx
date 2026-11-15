import { UserButton } from "@clerk/nextjs";
import type { Metadata } from "next";
import { listAccessibleWorkspaces, readWorkspaceAccess, searchWorkspaceSessions } from "../../../lib/workspace";
import { WorkspaceNav } from "./workspace-nav";
import styles from "./workspace-shell.module.css";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function WorkspaceLayout({ children, params }: LayoutProps<"/workspace/[id]">) {
  const { id } = await params;
  const [workspace, workspaces, sessions] = await Promise.all([
    readWorkspaceAccess(id),
    listAccessibleWorkspaces(),
    searchWorkspaceSessions(id, { page: 1 }),
  ]);
  const recentRepositories = new Map<string, { key: string; name: string }>();
  for (const session of sessions.sessions) {
    const repo = session.analytics?.repository;
    if (repo) recentRepositories.set(repo.key, repo);
  }

  return (
    <div className={`tideline-workspace ${styles.shell}`}>
      <a className={styles.skip} href="#workspace-content">Skip to content</a>
      <WorkspaceNav workspace={workspace} workspaces={workspaces} repositories={[...recentRepositories.values()].slice(0, 6)}>
        <UserButton />
      </WorkspaceNav>
      <div className={styles.content} id="workspace-content" tabIndex={-1}>{children}</div>
    </div>
  );
}
