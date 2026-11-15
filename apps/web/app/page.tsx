import { Show } from "@clerk/nextjs";
import { sessionSourceLabel } from "@tideline/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { cliInstallCommand } from "../lib/cli-install";
import { CopyTerminalCommand } from "./copy-terminal-command";
import styles from "./landing.module.css";

export const metadata: Metadata = {
  title: "Tideline | See what your coding agents did",
  description: "Review coding agent conversations, tool calls, and estimated costs in one workspace. Choose which repositories sync from your computer.",
};

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
          <Link href="/trends" className={styles.navLink}>Trends</Link>
          <Link href="/docs" className={styles.navLink}>Docs</Link>
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
            <div className={styles.heroSetup}>
              <CopyTerminalCommand command={cliInstallCommand()} label="Copy install command" />
              <Link className={styles.textLink} href="/docs/get-started">Setup guide <span aria-hidden="true">→</span></Link>
            </div>
          </div>
          <SessionPreview />
        </section>

        <section id="get-started" aria-labelledby="setup-title" className={styles.setup}>
          <div className={styles.setupIntro}>
            <h2 id="setup-title">Get your first session into Tideline.</h2>
            <p>Use the CLI on macOS or Linux with Node.js 22.13+ or 24.</p>
          </div>
          <ol className={styles.steps}>
            <li>
              <h3>1. Run the command</h3>
              <p>Copy the command above and paste it into your terminal. Tideline installs and opens the repository picker.</p>
            </li>
            <li>
              <h3>2. Choose what to sync</h3>
              <p>Pick repositories with saved coding sessions. Review your choices and decide whether to bring in older conversations.</p>
            </li>
            <li>
              <h3>3. Open your workspace</h3>
              <p>Approve in your browser. The terminal gives you a link to your sessions.</p>
              <Suspense>
                <Show when="signed-out"><Link className={styles.textLink} href="/sign-up">Create an account <span aria-hidden="true">↗</span></Link></Show>
                <Show when="signed-in"><Link className={styles.textLink} href="/workspace">Set up your workspace <span aria-hidden="true">↗</span></Link></Show>
              </Suspense>
            </li>
          </ol>
        </section>
      </main>

      <footer className={`${styles.shell} ${styles.footer}`}>
        <span>Tideline</span>
        <div className={styles.nav}>
          <Link className={styles.textLink} href="/docs">Documentation</Link>
          <Link className={styles.textLink} href="/docs/data-and-privacy">Data and privacy</Link>
        </div>
      </footer>
    </div>
  );
}
