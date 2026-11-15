import { estimateSessionModelCost } from "@tideline/contracts";
import type { WorkspaceSessionDetail } from "@tideline/contracts";
import Link from "next/link";
import { formatCost, formatCount, summarizeSession } from "../../../../../lib/usage";
import styles from "../sessions.module.css";

const seconds = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${formatCount(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${seconds.format(milliseconds / 1_000)} s`;
  const totalSeconds = Math.round(milliseconds / 1_000);
  return `${formatCount(Math.floor(totalSeconds / 60))} min ${totalSeconds % 60} s`;
}

function replyTimes(session: WorkspaceSessionDetail, throughLine: number) {
  const times = new Map<number, { first: number | null; last: number | null }>();
  let promptAt: number | undefined;
  let timing: ReturnType<typeof times.get>;
  for (const message of session.messages) {
    if (message.line > throughLine) break;
    const timestamp = Date.parse(message.timestamp);
    if (message.role === "user") {
      promptAt = timestamp;
      timing = { first: null, last: null };
      times.set(message.line, timing);
    } else if (timing && promptAt !== undefined && timestamp >= promptAt) {
      timing.first ??= timestamp - promptAt;
      timing.last = timestamp - promptAt;
    }
  }
  return times;
}

function TurnMetric({ label, value, note }: { label: string; value: string | null; note?: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs opacity-75">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">
        {value ?? <span className="font-normal opacity-70">Unavailable</span>}
        {value !== null && note && <span className="block text-xs font-normal opacity-70">{note}</span>}
      </dd>
    </div>
  );
}

export function SessionTurns({ session, timelineHref }: { session: WorkspaceSessionDetail; timelineHref: string }) {
  const trace = session.turnTrace;
  const timings = trace && replyTimes(session, trace.throughLine);
  const latestMessageLine = session.messages.at(-1)?.line ?? 0;

  return (
    <section aria-labelledby="turn-breakdown" className="space-y-4">
      <div className="space-y-1">
        <h2 id="turn-breakdown" className="text-xl font-semibold">Turn breakdown</h2>
        {trace && <p className="text-sm opacity-75">Token counts come from agent logs. Cost estimates use standard API rates.</p>}
      </div>
      {trace && timings ? (
        <>
          {trace.omittedTurns > 0 && <p className="text-sm opacity-75">Showing the most recent {formatCount(trace.turns.length)} recorded turns.</p>}
          {trace.throughLine < latestMessageLine && <p className="text-sm opacity-75">Newer messages have no turn data yet.</p>}
          <ol className="space-y-3">
            {trace.turns.map((turn, index) => {
              const { tokens, cost } = summarizeSession({
                repository: null,
                tokenCoverage: turn.tokenCoverage,
                models: turn.models.map((model) => ({ ...model, estimatedCostUsd: estimateSessionModelCost(session.source, model) })),
              });
              const timing = timings.get(turn.promptLine);
              const duration = turn.durationMs ?? timing?.last ?? null;
              const first = turn.timeToFirstTokenMs ?? timing?.first ?? null;
              return (
                <li key={turn.promptLine} className="space-y-3 rounded-lg border border-current/15 p-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h3 className="text-sm font-semibold">
                      <Link href={`${timelineHref}#message-${turn.promptLine}`} prefetch={false} className={styles.textLink}>
                        Turn {formatCount(trace.omittedTurns + index + 1)}
                      </Link>
                    </h3>
                    {!!turn.models.length && (
                      <span className="text-xs opacity-75 [overflow-wrap:anywhere]">
                        {turn.models.map(({ model }) => model ?? "Unknown model").join(", ")}
                      </span>
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                    <TurnMetric label="Tokens" value={tokens.value === null ? null : formatCount(tokens.value)} note={tokens.complete ? undefined : "Partial"} />
                    <TurnMetric label="Est. cost (USD)" value={cost.value === null ? null : formatCost(cost.value)} note={cost.complete ? undefined : "Partial"} />
                    <TurnMetric label="Peak recorded request input" value={turn.peakRequestInput === null ? null : formatCount(turn.peakRequestInput)} />
                    <TurnMetric label="Reported context window" value={turn.contextWindow === null ? null : formatCount(turn.contextWindow)} />
                    <TurnMetric label={turn.timeToFirstTokenMs === null ? "First reply" : "First token"} value={first === null ? null : formatDuration(first)} />
                    <TurnMetric label={turn.durationMs === null ? "Prompt to last reply" : "Turn duration"} value={duration === null ? null : formatDuration(duration)} />
                  </dl>
                </li>
              );
            })}
          </ol>
        </>
      ) : <p className="text-sm opacity-75">Turn data is unavailable for this session.</p>}
    </section>
  );
}
