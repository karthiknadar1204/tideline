import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { publicAgentRuns, publicLanguageUsage, publicModelUsage, publicTraceSample, readBenchmarkBoards, traceLabSource } from "../../lib/public-trends";
import landing from "../landing.module.css";
import { AgentRuns } from "./agent-runs";
import { BenchmarkExplorer } from "./benchmark-explorer";
import { DeveloperUsage } from "./developer-usage";
import styles from "./trends.module.css";

export const metadata: Metadata = {
  title: "Coding agent trends | Tideline",
  description: "Compare public benchmark results, recorded agent runs, and developer usage.",
};

const views = [
  { id: "benchmarks", label: "Benchmarks", href: "/trends" },
  { id: "agent-runs", label: "Agent runs", href: "/trends?view=agent-runs" },
  { id: "dev-usage", label: "Dev usage", href: "/trends?view=dev-usage" },
];

const dates = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  .formatRange(new Date(publicTraceSample.from), new Date(publicTraceSample.through));

function TraceLabCitation() {
  return (
    <p className={styles.source}>
      Derived from <a href={traceLabSource.release}>{traceLabSource.name} v0.0.2 ↗</a> · {dates} · {publicTraceSample.contributors} contributors.
      {" "}<a href={traceLabSource.license}>CC BY 4.0</a>
    </p>
  );
}

async function PublicBenchmarks() {
  const { boards, missingSweBench } = await readBenchmarkBoards();
  return (
    <>
      <BenchmarkExplorer boards={boards} />
      {missingSweBench && <p className={styles.source}>SWE-bench results are temporarily unavailable.</p>}
    </>
  );
}

function Survey() {
  return (
    <section className={styles.survey} aria-labelledby="survey-heading">
      <div className={styles.sectionHeader}>
        <div><h3 id="survey-heading">What developers report</h3><p>Responses to the 2026 Stack Overflow Developer Survey.</p></div>
        <a href="https://survey.stackoverflow.co/2026/ai/data/ai-select">View survey results ↗</a>
      </div>
      <dl className={styles.metrics}>
        <div className={styles.panel}><dt>Used a coding assistant or coding agent at work</dt><dd>65.9%</dd></div>
        <div className={styles.panel}><dt>Used general-purpose AI chat tools at work</dt><dd>62.5%</dd></div>
        <div className={styles.panel}><dt>Used AI agents or automated workflows at work</dt><dd>26.2%</dd></div>
      </dl>
      <p className={styles.source}>17,464 respondents answered this question and could select more than one option.</p>
    </section>
  );
}

export default async function TrendsPage({ searchParams }: PageProps<"/trends">) {
  const { view } = await searchParams;
  const active = views.find(({ id }) => id === view)?.id ?? "benchmarks";
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
          <p>Compare benchmark performance and explore how people use coding agents.</p>
        </div>
        <nav className={styles.sections} aria-label="Trends sections">
          {views.map(({ id, href, label }) => <Link key={id} href={href} aria-current={active === id ? "page" : undefined}>{label}</Link>)}
        </nav>
        {active === "benchmarks" && (
          <section className={styles.section} aria-labelledby="benchmarks-title">
            <div className={styles.sectionHeader}><div><h2 id="benchmarks-title">Benchmark results</h2>
              <p>Compare how agents score on the same task set and what each attempt costs.</p></div></div>
            <Suspense fallback={<p className={styles.empty} role="status">Loading benchmark results…</p>}><PublicBenchmarks /></Suspense>
          </section>
        )}
        {active === "agent-runs" && (
          <section className={styles.section} aria-labelledby="agent-runs-title">
            <div className={styles.sectionHeader}><div><h2 id="agent-runs-title">Agent runs</h2>
              <p>Session counts, elapsed time, and tool calls from a public sample of Claude Code and Codex activity.</p></div></div>
            <TraceLabCitation />
            <AgentRuns rows={publicAgentRuns} />
          </section>
        )}
        {active === "dev-usage" && (
          <section className={styles.section} aria-labelledby="usage-title">
            <div className={styles.sectionHeader}><div><h2 id="usage-title">Developer usage</h2>
              <p>Compare tool errors and language patterns across models in public coding-agent traces.</p></div></div>
            <DeveloperUsage models={publicModelUsage} language={publicLanguageUsage} traceCitation={<TraceLabCitation />} />
            <Survey />
          </section>
        )}
      </main>
    </div>
  );
}
