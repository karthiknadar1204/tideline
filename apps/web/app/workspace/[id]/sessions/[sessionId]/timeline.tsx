import type { SessionDetail } from "@tideline/contracts";
import { ReportMarkdown } from "../../reports/saved/[reportId]/report-markdown";
import styles from "../sessions.module.css";
import type { ReaderEntry, ReaderPrompt } from "./reader";

type Activity = NonNullable<SessionDetail["activity"]>;
type ActivityRecord =
  | ({ kind: "tool" } & Activity["tools"][number])
  | ({ kind: "skill" } & Activity["skills"][number])
  | ({ kind: "child" } & Activity["children"][number]);

const activityLabels = { tool: "Tool", skill: "Skill", child: "Subagent" } as const;
const statusLabels: Record<ActivityRecord["status"], string> = {
  called: "Called",
  returned: "Returned",
  failed: "Failed",
  requested: "Requested",
  invoked: "Invoked",
  started: "Started",
  running: "Running",
  completed: "Completed",
  stopped: "Stopped",
  unknown: "Unknown",
};
const timestamp = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });

function RecordedActivity({ activity }: { activity: ActivityRecord }) {
  const label = activityLabels[activity.kind];
  return (
    <details className={styles.event}>
      <summary className={styles.eventSummary}>
        <span className={styles.eventChevron} aria-hidden="true">›</span>
        <span className={styles.eventKind}>{label}</span>
        <span className={styles.eventName}>{activity.name ?? "Unnamed subagent"}</span>
        <span className={styles.eventStatus} data-state={activity.status}>{statusLabels[activity.status]}</span>
      </summary>
      <div className={styles.rowDetails}>
        <span>Log line {activity.line}</span>
        <span>Last recorded status {statusLabels[activity.status].toLowerCase()}</span>
      </div>
    </details>
  );
}

export function buildSessionTimeline(session: SessionDetail, agent: string) {
  const activity: ActivityRecord[] = [
    ...session.activity?.tools.map((tool) => ({ ...tool, kind: "tool" as const })) ?? [],
    ...session.activity?.skills.map((skill) => ({ ...skill, kind: "skill" as const })) ?? [],
    ...session.activity?.children.map((child) => ({ ...child, kind: "child" as const })) ?? [],
  ];

  const prompts: ReaderPrompt[] = [];
  const messages = session.messages.map((message) => {
    const user = message.role === "user";
    const key = `message-${message.line}`;
    if (user) prompts.push({ key, preview: message.text.replace(/\s+/g, " ").slice(0, 100) });
    return {
      key,
      kind: "message" as const,
      line: message.line,
      index: user ? -1 : Number.MAX_SAFE_INTEGER,
      content: (
        <article className={styles.message} data-role={message.role}>
          <header className={styles.entryHeader}>
            <span>{user ? "User" : agent}</span>
            <time dateTime={message.timestamp}>{timestamp.format(new Date(message.timestamp))}</time>
          </header>
          {user ? <p className={styles.promptText}>{message.text}</p> : <ReportMarkdown markdown={message.text} />}
        </article>
      ),
    };
  });

  const entries: ReaderEntry[] = [
    ...messages,
    ...activity.map((record) => ({
      key: `${record.kind}-${record.line}-${record.index}`,
      kind: "activity" as const,
      line: record.line,
      index: record.index,
      content: <RecordedActivity activity={record} />,
    })),
  ].sort((left, right) => left.line - right.line || left.index - right.index)
    .map(({ key, kind, content }) => ({ key, kind, content }));

  const activityNote = session.activity?.truncated ? "Some activities are missing because this session reached the recording limit."
    : !session.activity ? "Activity details are unavailable for this session."
    : undefined;

  return { entries, prompts, activityNote };
}
