"use client";

import { useState, type ReactNode } from "react";
import type { publicLanguageUsage, publicModelUsage } from "../../lib/public-trends";
import { formatCount, formatDecimal, formatPercent, reportNumber } from "./metrics";
import styles from "./trends.module.css";

type ModelRow = (typeof publicModelUsage)[number];
type LanguageRow = (typeof publicLanguageUsage.models)[number];
type Minimum = typeof publicLanguageUsage.minimum;
type Signal = "errors" | "swearing" | "apology";
type Rate = "prompts" | "tokens" | "relative";

const signals = {
  errors: {
    label: "Tool errors",
    title: "Recorded tool errors by model",
    relative: "Share of known outcomes",
    normalize(count: number, row: ModelRow, rate: Rate) {
      const denominator = {
        prompts: row.recordedPrompts,
        tokens: row.recordedOutputTokens,
        relative: row.knownToolOutcomes,
      }[rate];
      return row.knownToolOutcomes && denominator > 0 ? count / denominator : null;
    },
  },
  swearing: {
    label: "User swearing",
    title: "Prompts matching a swearing term",
    relative: null,
    matches: (row: LanguageRow) => row.promptsWithSwearing,
  },
  apology: {
    label: "Model apology",
    title: "Replies matching an apology phrase",
    relative: "Per 1,000 replies",
    matches: (row: LanguageRow) => row.repliesWithApology,
  },
};

const agents: Record<string, string> = { claude: "Claude Code", codex: "Codex", "Claude Code 2": "Claude Code" };

function isSignal(input: string): input is Signal {
  return Object.hasOwn(signals, input);
}

function isRate(input: string): input is Rate {
  return input === "prompts" || input === "tokens" || input === "relative";
}

export function DeveloperUsage({ models, language, traceCitation }: {
  models: ModelRow[];
  language: { models: LanguageRow[]; minimum: Minimum };
  traceCitation: ReactNode;
}) {
  const [cohort, selectCohort] = useState("");
  const [search, setSearch] = useState("");
  const [rate, setRate] = useState<Rate>("prompts");
  const [signal, setSignal] = useState<Signal>("errors");
  const matches = search.trim().toLowerCase();
  const errorSignal = signal === "errors";
  const options = {
    prompts: "Per 1,000 prompts",
    tokens: errorSignal ? "Per 10M output tokens" : "Per 10M estimated output tokens",
    relative: signals[signal].relative,
  };
  const rateLabel = options[rate] ?? options.prompts;
  const percent = errorSignal && rate === "relative";
  const scale = rate === "tokens" ? 10_000_000 : percent ? 100 : 1_000;

  const cohorts = [...new Set((errorSignal ? models : language.models).map((row) => row.cohort))].sort();
  const errorRows = errorSignal ? models.map((row) => ({
    cohort: row.cohort,
    model: row.model,
    count: row.toolErrors,
    rate: signals.errors.normalize(row.toolErrors, row, rate),
    sample: [
      `${formatCount(row.knownToolOutcomes)} of ${formatCount(row.toolCalls)}`,
      formatCount(row.recordedPrompts),
      formatCount(row.recordedOutputTokens),
    ],
  })) : [];
  const languageRows = signal === "errors" ? [] : language.models.map((row) => {
    const count = signals[signal].matches(row);
    const denominator = { prompts: row.prompts, tokens: row.visibleOutputTokens, relative: row.replies }[rate];
    return {
      cohort: row.cohort,
      model: row.model,
      count,
      rate: denominator > 0 ? count / denominator : null,
      sample: [row.sessions, row.prompts, row.replies, row.visibleOutputTokens].map(formatCount),
    };
  });
  const rows = [...errorRows, ...languageRows].filter((row) =>
    (!cohort || row.cohort === cohort) && row.model.toLowerCase().includes(matches));
  const allMatches = languageRows.reduce((total, row) => total + row.count, 0);
  const peak = Math.max(1, ...rows.map((row) => (row.rate ?? 0) * scale));
  const columns = errorSignal
    ? ["Recorded errors", "Known outcomes", "Recorded prompts", "Recorded output tokens"]
    : ["Matches", "Sessions", "Matched prompts", "Assistant replies", "Estimated output tokens"];

  return (
    <>
      <div className={styles.form}>
        <label>Signal<select value={signal} onChange={(event) => {
          const next = event.target.value;
          if (!isSignal(next)) return;
          if ((next === "errors") !== errorSignal) selectCohort("");
          if (rate === "relative" && next !== signal) setRate("prompts");
          setSignal(next);
        }}>
          {Object.entries(signals).map(([key, { label }]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Agent<select aria-label="Agent" value={cohort} onChange={(event) => selectCohort(event.target.value)}>
          <option value="">All agents</option>
          {cohorts.map((name) => <option key={name} value={name}>{agents[name] ?? name}</option>)}
        </select></label>
        <label>Normalize by<select value={rate} onChange={(event) => {
          if (isRate(event.target.value)) setRate(event.target.value);
        }}>
          {Object.entries(options).map(([key, label]) => label && <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Search models<input type="search" placeholder="Model name" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      <section className={styles.panel} aria-labelledby="dev-usage-models">
        <div className={styles.panelHeader}><div><h3 id="dev-usage-models">{signals[signal].title}</h3>
          <p aria-live="polite">{rows.length} {rows.length === 1 ? "model" : "models"}</p></div></div>
        {rows.length ? (
          <div className={styles.tableRegion} role="region" aria-label="Model usage results" tabIndex={0}>
            <table>
              <thead><tr><th scope="col">Model</th><th scope="col">{rateLabel}</th>
                {columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
              <tbody>{rows.map((row) => {
                const value = row.rate === null ? null : row.rate * scale;
                return (
                  <tr key={`${row.cohort}:${row.model}`}>
                    <th scope="row">{row.model}<small>{agents[row.cohort] ?? row.cohort}</small></th>
                    <td className={styles.rateCell}>
                      {reportNumber(value, percent ? formatPercent : formatDecimal)}
                      {value !== null && <div className={styles.track} aria-hidden="true"><div style={{ width: `${100 * value / peak}%` }} /></div>}
                    </td>
                    <td>{formatCount(row.count)}</td>
                    {row.sample.map((item, index) => <td key={columns[index + 1]}>{item}</td>)}
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        ) : <p className={styles.empty}>No models match these filters.</p>}
      </section>
      {errorSignal ? <>
        {traceCitation}
        <p className={styles.source}>
          A recorded error is a tool result marked as an error. Missing outcomes can lower the recorded rate. The release covers a contributor sample with different workloads and tool logging across agents.
        </p>
      </> : <>
        <p className={styles.source}>
          Derived from the November 2026 <a href="https://zenodo.org/records/24104601">CHAIN dataset</a> by Varriale et al.
          {" "}<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
          {" "}The study covers coding-agent logs published in public GitHub repositories.
        </p>
        <p className={styles.source}>
          {signal === "swearing" ? "Counts prompts containing a term from a small English word list." : "Counts assistant replies containing an explicit English apology phrase."}
          {" "}The sample uses exchanges with one named model and omits code blocks, quoted lines, and child-agent messages from phrase matching.
          {" "}Each row has at least {language.minimum.sessions} sessions, {language.minimum.prompts} prompts, and {language.minimum.replies} replies.
          {" "}Output tokens are estimates for the sampled assistant replies.
          {" "}The full sample for this signal contains {formatCount(allMatches)} matches. Small counts can make rates volatile.
        </p>
      </>}
    </>
  );
}
