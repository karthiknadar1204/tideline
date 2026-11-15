import type { Metadata } from "next";
import Link from "next/link";
import { benchmarkSource, readBenchmarkBoards } from "../../lib/public-trends";
import landing from "../landing.module.css";
import { BenchmarkExplorer } from "./benchmark-explorer";
import styles from "./trends.module.css";

export const metadata: Metadata = {
  title: "Coding agent trends | Tideline",
  description: "Compare public SWE-bench results and see how developers report using coding agents.",
};

const surveySource = "https://survey.stackoverflow.co/2026/ai";
const surveyMetrics = [
  { value: "66%", label: "reported using AI for coding assistance or agents" },
  { value: "63%", label: "reported using general-purpose AI chatbots" },
  { value: "31%", label: "of daily AI users reported using it at least four hours a day" },
];

export default async function TrendsPage() {
  const boards = await readBenchmarkBoards().catch(() => []);
  return (
    <div className={landing.landing}>
      <header className={`${landing.shell} ${landing.header}`}>
        <Link href="/" className={landing.brand}><span className={landing.brandMark} aria-hidden="true" />Tideline</Link>
        <nav className={landing.nav} aria-label="Main navigation">
          <Link href="/trends" className={landing.navLink} aria-current="page">Trends</Link>
          <Link href="/docs" className={landing.navLink}>Docs</Link>
          <Link href="/workspaces" className={landing.navButton}>Workspaces</Link>
        </nav>
      </header>
      <main className={`${landing.shell} ${styles.content}`}>
        <div className={styles.intro}>
          <h1>Coding agent trends</h1>
          <p>Explore benchmark results and see how developers report using AI in their work.</p>
        </div>
        <nav className={styles.sections} aria-label="Trends sections">
          <a href="#benchmarks">Benchmarks</a><a href="#developer-usage">Developer usage</a>
        </nav>
        <section id="benchmarks" className={styles.section} aria-labelledby="benchmarks-title">
          <div className={styles.sectionHeader}>
            <div><h2 id="benchmarks-title">SWE-bench results</h2><p>See how agents resolve real GitHub issues across benchmark datasets.</p></div>
            <a href={benchmarkSource}>SWE-bench leaderboard ↗</a>
          </div>
          {boards.length ? <BenchmarkExplorer boards={boards} /> : <p className={styles.empty}>Benchmark results are temporarily unavailable.</p>}
        </section>
        <section id="developer-usage" className={styles.section} aria-labelledby="usage-title">
          <div className={styles.sectionHeader}>
            <div><h2 id="usage-title">Developer usage</h2><p>Responses reported in the 2026 Stack Overflow Developer Survey.</p></div>
            <a href={surveySource}>Read the survey ↗</a>
          </div>
          <dl className={styles.metrics}>
            {surveyMetrics.map(({ value, label }) => <div className={styles.panel} key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        </section>
      </main>
    </div>
  );
}
