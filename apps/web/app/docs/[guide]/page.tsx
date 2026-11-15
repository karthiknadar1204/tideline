import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { docsGuides } from "../guides";
import styles from "../docs.module.css";

export const dynamicParams = false;

export function generateStaticParams() {
  return docsGuides.map(({ slug }) => ({ guide: slug }));
}

export async function generateMetadata({ params }: PageProps<"/docs/[guide]">): Promise<Metadata> {
  const { guide } = await params;
  const page = docsGuides.find(({ slug }) => slug === guide);
  if (!page) notFound();
  return { title: `${page.title} | Tideline Docs`, description: page.description };
}

export default async function GuidePage({ params }: PageProps<"/docs/[guide]">) {
  const { guide } = await params;
  const page = docsGuides.find(({ slug }) => slug === guide);
  if (!page) notFound();

  const { title, description, sections, Content } = page;
  return (
    <div className={styles.guideGrid}>
      <nav className={styles.guideNav} aria-label="Documentation guides">
        <ul>
          {docsGuides.map(({ slug, title: label }) => (
            <li key={slug}><Link href={`/docs/${slug}`} aria-current={slug === guide ? "page" : undefined}>{label}</Link></li>
          ))}
        </ul>
      </nav>
      <main className={styles.article} id="docs-content" tabIndex={-1}>
        <header className={styles.intro}>
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
        <nav className={styles.onPage} aria-label="On this page">
          <p>On this page</p>
          <ul>
            {sections.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}
          </ul>
        </nav>
        <Content />
      </main>
    </div>
  );
}
