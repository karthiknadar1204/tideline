"use client";

import { useState } from "react";
import type { BenchmarkBoard } from "../../lib/public-trends";
import styles from "./trends.module.css";

const monthFormat = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });
const costFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 3 });
function numberPercent(value: number) { return `${value.toFixed(1)}%`; }

export function BenchmarkExplorer({ boards }: { boards: BenchmarkBoard[] }) {
  const [dataset, selectDataset] = useState(boards.find(({ name }) => name === "Verified")?.name ?? boards[0].name);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("score");
  const board = boards.find(({ name }) => name === dataset) ?? boards[0];
  const matches = search.trim().toLowerCase();
  const runs = board.runs.filter(({ name, model, agent }) => `${name} ${model} ${agent}`.toLowerCase().includes(matches));
  runs.sort((a, b) => {
    if (sort === "cost") return ((a.cost ?? Infinity) - (b.cost ?? Infinity)) || b.resolved - a.resolved;
    if (sort === "recent") return b.date.localeCompare(a.date) || b.resolved - a.resolved;
    return b.resolved - a.resolved || b.date.localeCompare(a.date);
  });
  const months = new Map<string, number>();
  for (const { date } of board.runs) {
    const month = date.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + 1);
  }
  const recent = [...months].sort(([a], [b]) => b.localeCompare(a)).slice(0, 6).reverse();
  const mostRuns = Math.max(...recent.map(([, count]) => count));

  return (
    <>
      <div className={styles.form}>
        <label>Dataset<select value={dataset} onChange={(event) => selectDataset(event.target.value)}>
          {boards.map(({ name }) => <option key={name}>{name}</option>)}
        </select></label>
        <label>Search submissions<input type="search" placeholder="Model or agent" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>Sort by<select value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="score">Highest resolution rate</option><option value="recent">Most recent</option><option value="cost">Lowest cost</option>
        </select></label>
      </div>
      <div className={styles.results}>
        <section className={styles.panel} aria-labelledby="submissions-title">
          <div className={styles.panelHeader}><h3 id="submissions-title">Submissions</h3><span aria-live="polite">{runs.length} results</span></div>
          <div className={styles.tableRegion} role="region" aria-label="Benchmark results" tabIndex={0}>
            <table>
              <thead><tr><th scope="col">Run</th><th scope="col">Resolved</th><th scope="col">Cost per issue</th><th scope="col">Date</th></tr></thead>
              <tbody>{runs.map(({ name, model, agent, date, resolved, cost }, index) => (
                <tr key={`${name}-${date}-${index}`}>
                  <th scope="row">{name}{(agent || model && model !== name) && <small>{[model !== name ? model : "", agent].filter(Boolean).join(" · ")}</small>}</th>
                  <td>{numberPercent(resolved)}</td><td>{cost !== null ? costFormat.format(cost) : "Unavailable"}</td><td><time dateTime={date}>{date}</time></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {!runs.length && <p className={styles.empty}>No submissions match your search.</p>}
        </section>
        <section className={styles.panel} aria-labelledby="timeline-title">
          <div className={styles.panelHeader}><h3 id="timeline-title">Recent activity</h3></div>
          <ul className={styles.months} aria-label="Submissions per month">
            {recent.map(([month, count]) => (
              <li key={month}>
                <span>{monthFormat.format(new Date(`${month}-01T00:00:00Z`))}</span><span>{count}</span>
                <div className={styles.track} aria-hidden="true"><div style={{ width: `${count / mostRuns * 100}%` }} /></div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
