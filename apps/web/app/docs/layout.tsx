import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./docs.module.css";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`tideline-workspace ${styles.site}`}>
      <div className={styles.shell}>
        <a className={styles.skip} href="#docs-content">Skip to content</a>
        <header className={styles.header}>
          <div className={styles.brand}>
            <Link href="/">Tideline</Link>
            <span aria-hidden="true">/</span>
            <Link href="/docs">Docs</Link>
          </div>
          <Link className={styles.workspace} href="/workspaces">Open workspace <span aria-hidden="true">→</span></Link>
        </header>
        {children}
      </div>
    </div>
  );
}
