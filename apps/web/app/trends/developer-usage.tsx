"use client";

import { useState } from "react";
import type { publicModelUsage } from "../../lib/public-trends";
import { formatCount, formatDecimal, formatPercent, reportNumber } from "./metrics";
import styles from "./trends.module.css";

type ModelRow = (typeof publicModelUsage)[number];
const rates = {
  prompts: { label: "Per 1,000 prompts", denominator: "recordedPrompts", scale: 1_000 },
  tokens: { label: "Per 10M output tokens", denominator: "recordedOutputTokens", scale: 10_000_000 },
  calls: { label: "Share of known outcomes", denominator: "knownToolOutcomes", scale: 100 },
} satisfies Record<string, { label: string; denominator: keyof ModelRow; scale: number }>;
type Rate = keyof typeof rates;

function isRate(input: string): input is Rate {
  return Object.hasOwn(rates, input);
}

export function DeveloperUsage({ models }: { models: ModelRow[] }) {
  const [cohort, selectCohort] = useState("");
  const [search, setSearch] = useState("");
  const [rate, setRate] = useState<Rate>("prompts");
  const [signal, setSignal] = useState("errors");
  const matches = search.trim().toLowerCase();
  const config = rates[rate];
  const rows = models.filter((model) => (!cohort || model.cohort === cohort) && model.model.toLowerCase().includes(matches));
  const textUnavailable = signal !== "errors";

  function errorRate(row: ModelRow) {
    return row.knownToolOutcomes && row[config.denominator] > 0 ? config.scale * row.toolErrors / row[config.denominator] : null;
  }
  const values = rows.map((row) => ({ row, value: errorRate(row) }));
  const peak = Math.max(1, ...values.map(({ value }) => value ?? 0));

  return (
    <>
      <div className={styles.form}>
        <label>Signal<select value={signal} onChange={(event) => setSignal(event.target.value)}>
          <option value="errors">Tool errors</option><option value="swearing">User swearing</option><option value="apology">Model apology</option>
        </select></label>
        <label>Agent<select aria-label="Agent" value={cohort} onChange={(event) => selectCohort(event.target.value)}>
          <option value="">All agents</option><option value="claude">Claude Code</option><option value="codex">Codex</option>
        </select></label>
        <label>Normalize by<select value={rate} onChange={(event) => {
          if (isRate(event.target.value)) setRate(event.target.value);
        }} disabled={textUnavailable}>
          {Object.entries(rates).map(([key, { label }]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Search models<input type="search" placeholder="Model name" value={search} onChange={(event) => setSearch(event.target.value)} disabled={textUnavailable} /></label>
      </div>
      <section className={styles.panel} aria-labelledby="dev-usage-models">
        <div className={styles.panelHeader}><div><h3 id="dev-usage-models">
          {signal === "errors" ? "Recorded tool errors by model" : signal === "swearing" ? "User swearing" : "Model apology"}
        </h3>{!textUnavailable && <p aria-live="polite">{rows.length} {rows.length === 1 ? "model" : "models"}</p>}</div></div>
        {textUnavailable ? <p className={styles.empty}>Unavailable. The public TraceLab release leaves out message text.</p>
          : rows.length ? (
            <div className={styles.tableRegion} role="region" aria-label="Model usage results" tabIndex={0}>
              <table>
                <thead><tr><th scope="col">Model</th><th scope="col" aria-label={`Tool errors ${config.label.toLowerCase()}`}>{config.label}</th>
                  <th scope="col">Recorded errors</th><th scope="col">Known outcomes</th>
                  <th scope="col">Recorded prompts</th><th scope="col">Recorded output tokens</th></tr></thead>
                <tbody>{values.map(({ row, value }) => (
                  <tr key={`${row.cohort}:${row.model}`}>
                    <th scope="row">{row.model}<small>{row.cohort === "claude" ? "Claude Code" : "Codex"}</small></th>
                    <td className={styles.rateCell}>
                      {reportNumber(value, rate === "calls" ? formatPercent : formatDecimal)}
                      {value !== null && <div className={styles.track} aria-hidden="true"><div style={{ width: `${100 * value / peak}%` }} /></div>}
                    </td>
                    <td>{formatCount(row.toolErrors)}</td><td>{formatCount(row.knownToolOutcomes)} of {formatCount(row.toolCalls)}</td>
                    <td>{formatCount(row.recordedPrompts)}</td><td>{formatCount(row.recordedOutputTokens)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className={styles.empty}>No models match these filters.</p>}
      </section>
      {!textUnavailable && <p className={styles.source}>
        A recorded error is a tool result marked as an error. Missing outcomes can lower the recorded rate. The release covers a contributor sample with different workloads and tool logging across agents.
      </p>}
    </>
  );
}
