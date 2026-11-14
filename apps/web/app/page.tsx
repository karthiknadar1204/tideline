import { Show } from "@clerk/nextjs";
import { sessionSourceLabel } from "@tideline/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import styles from "./landing.module.css";

export const metadata: Metadata = {
  title: "Tideline | See what your coding agents did",
  description: "Review coding agent conversations, tool calls, and estimated costs in one workspace. Choose which repositories sync from your computer.",
};

const setupGuide = "https://github.com/karthiknadar1204/tideline#run-locally";
const sampleSession = {
  repository: "signal-web",
  agent: sessionSourceLabel.codex,
  title: "Fix checkout retries",
  usage: [
    { label: "Tokens", value: "38.4K" },
    { label: "Estimated cost", value: "$0.12" },
    { label: "Tool calls", value: "9" },
  ],
  messages: [
    { speaker: "You", text: "Can we retry failed payments safely?" },
    { speaker: "Codex", text: "I added an idempotency key and tested duplicate requests." },
  ],
};

function SessionPreview() {
  return (
    <div className={styles.preview}>
      <div className={styles.photo} aria-hidden="true" />
      <figure className={styles.session}>
        <figcaption className={styles.sessionBar}>
          <span className={styles.windowDots} aria-hidden="true"><i /><i /><i /></span>
          Sample session
        </figcaption>
        <div className={styles.sessionContent}>
          <p className={styles.sessionContext}>{sampleSession.repository}<span aria-hidden="true">/</span>{sampleSession.agent}</p>
          <h2 className={styles.sessionTitle}>{sampleSession.title}</h2>
          <dl className={styles.stats}>
            {sampleSession.usage.map(({ label, value }) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
          <ol className={styles.messages}>
            {sampleSession.messages.map(({ speaker, text }) => (
              <li key={speaker}><strong>{speaker}</strong><p>{text}</p></li>
            ))}
          </ol>
        </div>
      </figure>
    </div>
  );
}

export default function Home() {
  return (
    <div className={styles.landing}>
      <header className={`${styles.shell} ${styles.header}`}>
        <Link href="/" className={styles.brand}><span className={styles.brandMark} aria-hidden="true" />Tideline</Link>
        <nav aria-label="Main navigation" className={styles.nav}>
          <a href="#get-started" className={styles.navLink}>Setup</a>
          <Suspense>
            <Show when="signed-out"><Link className={styles.navButton} href="/sign-in">Sign in</Link></Show>
            <Show when="signed-in"><Link className={styles.navButton} href="/workspaces">Open workspace</Link></Show>
          </Suspense>
        </nav>
      </header>

      <main className={styles.shell}>
        <section className={styles.hero} aria-labelledby="landing-title">
          <div className={styles.heroText}>
            <h1 className={styles.heroTitle} id="landing-title">See what your <em>coding agents</em> did.</h1>
            <p className={styles.lead}>Read conversations, inspect tool calls, and track estimated costs across Codex, Claude Code, Cursor, and OpenCode.</p>
            <a className={styles.primaryButton} href="#get-started">Get started <span aria-hidden="true">↘</span></a>
          </div>
          <SessionPreview />
        </section>

        <section id="get-started" aria-labelledby="setup-title" className={styles.setup}>
          <div className={styles.setupIntro}>
            <h2 id="setup-title">Get your first session into Tideline.</h2>
            <p>Set up from the Tideline checkout on macOS or Linux.</p>
          </div>
          <ol className={styles.steps}>
            <li>
              <h3>1. Prepare the CLI</h3>
              <p>Follow the local setup guide to start Tideline and build the CLI. You&apos;ll need Bun, Node.js, and access to the checkout.</p>
              <a className={styles.textLink} href={setupGuide}>Local setup guide <span aria-hidden="true">↗</span></a>
            </li>
            <li>
              <h3>2. Open your workspace</h3>
              <p>Sign in and copy the CLI setup command from the Sessions page in your new workspace.</p>
              <Suspense>
                <Show when="signed-out"><Link className={styles.textLink} href="/sign-up">Create an account <span aria-hidden="true">↗</span></Link></Show>
                <Show when="signed-in"><Link className={styles.textLink} href="/workspace">Set up your workspace <span aria-hidden="true">↗</span></Link></Show>
              </Suspense>
            </li>
            <li>
              <h3>3. Choose what to sync</h3>
              <p>Run the command, review the repositories you selected, and approve in your browser. Open the workspace link from the CLI to see your sessions.</p>
            </li>
          </ol>
        </section>
      </main>

      <footer className={`${styles.shell} ${styles.footer}`}>
        <span>Tideline</span>
        <a className={styles.textLink} href="https://github.com/karthiknadar1204/tideline">GitHub <span aria-hidden="true">↗</span></a>
      </footer>
    </div>
  );
}
