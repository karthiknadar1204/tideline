"use client";

import { useState } from "react";
import type { publicAgentRuns } from "../../lib/public-trends";
import { formatCount, formatDecimal, formatDuration, formatMonth, reportNumber } from "./metrics";
import styles from "./trends.module.css";

type RunRow = (typeof publicAgentRuns)[number];
const measures = {
  sessions: { name: "Sessions", format: formatCount },
  averageSeconds: { name: "Average duration", format: formatDuration },
  p95Seconds: { name: "p95 duration", format: formatDuration },
  p99Seconds: { name: "p99 duration", format: formatDuration },
  averageCalls: { name: "Average calls per session", format: formatDecimal },
  p95Calls: { name: "p95 calls per session", format: formatCount },
  p99Calls: { name: "p99 calls per session", format: formatCount },
  toolCalls: { name: "Total tool calls", format: formatCount },
};
const headlineMeasures = ["sessions", "averageSeconds", "p95Seconds", "p99Seconds", "averageCalls"] as const;
type Measure = keyof typeof measures;

function isMeasure(input: string): input is Measure {
  return Object.hasOwn(measures, input);
}

export function AgentRuns({ rows }: { rows: RunRow[] }) {
  const [cohort, selectCohort] = useState("all");
  const [metric, selectMetric] = useState<Measure>("sessions");
  const measure = measures[metric];
  const overall = rows.find((row) => row.cohort === cohort && row.month === null);
  const monthly = rows.filter((row) => row.cohort === cohort && row.month !== null);
  const peak = Math.max(1, ...monthly.map((row) => row[metric] ?? 0));

  return (
    <>
      <div className={styles.form}>
        <label>Agent<select aria-label="Agent" value={cohort} onChange={(event) => selectCohort(event.target.value)}>
          <option value="all">All agents</option><option value="claude">Claude Code</option><option value="codex">Codex</option>
        </select></label>
        <label>Monthly metric<select value={metric} onChange={(event) => {
          if (isMeasure(event.target.value)) selectMetric(event.target.value);
        }}>
          {Object.entries(measures).map(([key, { name }]) => <option key={key} value={key}>{name}</option>)}
        </select></label>
      </div>
      {overall && (
        <dl className={styles.metrics} aria-label="Full sample">
          {headlineMeasures.map((key) => (
            <div className={styles.panel} key={key}><dt>{measures[key].name}</dt><dd>{reportNumber(overall[key], measures[key].format)}</dd></div>
          ))}
        </dl>
      )}
      <section className={styles.panel} aria-labelledby="agent-timeline">
        <div className={styles.panelHeader}><h3 id="agent-timeline">{measure.name} by month</h3></div>
        <ol className={styles.months} aria-label={`${measure.name} by month`}>
          {monthly.map((row) => row.month && (
            <li key={row.month}>
              <span>{formatMonth(row.month)}</span><span>{reportNumber(row[metric], measure.format)}</span>
              <div className={styles.track} aria-hidden="true">
                <div style={{ width: `${100 * (row[metric] ?? 0) / peak}%` }} />
              </div>
            </li>
          ))}
        </ol>
        <details className={styles.expandTable}>
          <summary>View monthly data</summary>
          <div className={styles.tableRegion} role="region" aria-label="Monthly agent statistics" tabIndex={0}>
            <table>
              <thead><tr><th scope="col">Month</th><th scope="col">Sessions</th><th scope="col">Timed sessions</th>
                <th scope="col">Average duration</th><th scope="col">p95 duration</th><th scope="col">p99 duration</th><th scope="col">Total tool calls</th>
                <th scope="col">Average calls per session</th><th scope="col">p95 calls per session</th><th scope="col">p99 calls per session</th></tr></thead>
              <tbody>{monthly.map((row) => row.month && (
                <tr key={row.month}><th scope="row">{formatMonth(row.month)}</th><td>{formatCount(row.sessions)}</td>
                  <td>{formatCount(row.timedSessions)}</td><td>{reportNumber(row.averageSeconds, formatDuration)}</td>
                  <td>{reportNumber(row.p95Seconds, formatDuration)}</td><td>{reportNumber(row.p99Seconds, formatDuration)}</td>
                  <td>{formatCount(row.toolCalls)}</td><td>{formatDecimal(row.averageCalls)}</td>
                  <td>{reportNumber(row.p95Calls, formatCount)}</td><td>{reportNumber(row.p99Calls, formatCount)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      </section>
      <p className={styles.source}>
        Each session is counted in the UTC month of its first recorded event. Duration is the time from its first to last event
        and can include idle time or resumed work. Calls per session include sessions with zero calls.
        {" "}p95 and p99 require at least 20 and 100 observations, respectively.
      </p>
    </>
  );
}
