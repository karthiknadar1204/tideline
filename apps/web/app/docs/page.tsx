import type { Metadata } from "next";
import Link from "next/link";
import { docsGuides } from "./guides";
import styles from "./docs.module.css";

export const metadata: Metadata = {
  title: "Documentation | Tideline",
  description: "Set up the Tideline CLI, sync coding agent sessions, and learn how to use your workspace.",
};

export default function DocsIndex() {
  return (
    <main className={styles.index} id="docs-content" tabIndex={-1}>
      <header className={styles.intro}>
        <h1>Tideline documentation</h1>
        <p>Sync coding sessions from your computer, read them in your workspace, and see what your agents did.</p>
      </header>
      <ul className={styles.cards} aria-label="Guides">
        {docsGuides.map(({ slug, title, description }) => (
          <li key={slug}>
            <Link href={`/docs/${slug}`} className={styles.card}>
              <h2>{title}</h2>
              <p>{description}</p>
              <span aria-hidden="true">→</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
