import type { SessionCapture, SessionDetail } from "@tideline/contracts";
import styles from "../sessions.module.css";

type Evidence = NonNullable<SessionCapture["subagents"]>;
type Transcript = Evidence["transcripts"][number];
type Run = Pick<Transcript, "line" | "name" | "status">;
const time = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });

function SubagentRun({ run, transcript, descendants, provenance }: {
  run: Run;
  transcript?: Transcript;
  descendants: Map<string, Transcript[]>;
  provenance?: string;
}) {
  const { line, name, status = "unknown" } = run;
  const children = transcript && descendants.get(transcript.agentId);
  return (
    <details className={styles.event}>
      <summary className={styles.eventSummary}>
        <span aria-hidden="true" className={styles.eventChevron}>›</span>
        <span className={styles.eventName}>{name ?? "Unnamed subagent"}</span>
        <span className={styles.eventStatus} data-state={status}>{status[0].toUpperCase() + status.slice(1)}</span>
      </summary>
      <div className={styles.captureBody}>
        <p className={styles.captureNote}>Parent call at log line {line}{transcript && provenance}</p>
        {transcript?.messages.length ? <ol className={styles.captureList} aria-label="Subagent conversation">
          {transcript.messages.map(({ line, role, text, timestamp }) => (
            <li key={line}>
              <article className={styles.message} data-role={role}>
                <header className={styles.entryHeader}>
                  <span>{role === "user" ? "Task prompt" : "Subagent"}</span>
                  <time dateTime={timestamp}>{time.format(new Date(timestamp))}</time>
                </header>
                <p className={styles.promptText}>{text}</p>
              </article>
            </li>
          ))}
        </ol> : <p className={styles.captureNote}>No conversation was captured for this run.</p>}
        {transcript?.truncated && <p className={styles.captureNote}>This conversation reached the capture limit.</p>}
        {!!children?.length && <ul className={`${styles.captureList} ${styles.subagentChildren}`} aria-label="Child subagents">
          {children.map((child) => <li key={child.agentId}>
            <SubagentRun run={child} transcript={child} descendants={descendants} provenance={provenance} />
          </li>)}
        </ul>}
      </div>
    </details>
  );
}

export function SessionSubagents({ session, capture }: { session: SessionDetail; capture: SessionCapture | null }) {
  const children = session.activity?.children ?? [];
  const recorded = capture?.subagents;
  const supportsCapture = session.source === "codex" || session.source === "claude-code";
  const transcripts = new Map<string, Transcript>();
  const descendants = new Map<string, Transcript[]>();
  for (const child of recorded?.transcripts ?? []) {
    if (child.parentAgentId) {
      const group = descendants.get(child.parentAgentId) ?? [];
      group.push(child);
      descendants.set(child.parentAgentId, group);
    } else transcripts.set(`${child.line}:${child.index}`, child);
  }
  const provenance = recorded?.source === "codex-rollout" ? " · Codex child rollout" : " · Claude Code subagent log";
  return (
    <section className={styles.captureSection} aria-label="Subagents">
      <h2>{children.length ? "Subagents" : "No recorded subagent runs"}</h2>
      {supportsCapture && !recorded && <p className={styles.captureNote}>
        To capture redacted subagent conversations on sync, run <code>tideline sync setup --session-details --subagent-transcripts</code>.
      </p>}
      {children.length > 0 && !supportsCapture && <p className={styles.captureNote}>
        Conversation capture is available for Codex and Claude Code.
      </p>}
      {(recorded?.truncated || session.activity?.truncated) && <p className={styles.captureNote}>Some subagent records were omitted or reached a capture limit.</p>}
      {children.length > 0 && <ul className={styles.captureList}>
        {children.map((run) => {
          const key = `${run.line}:${run.index}`;
          return <li key={key}>
            <SubagentRun run={run} transcript={transcripts.get(key)} descendants={descendants} provenance={provenance} />
          </li>;
        })}
      </ul>}
    </section>
  );
}
