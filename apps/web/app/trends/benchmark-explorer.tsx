"use client";

import { useState } from "react";
import type { BenchmarkBoard, BenchmarkRun } from "../../lib/public-trends";
import { formatCost, formatDecimal, formatDuration, formatPercent, reportNumber } from "./metrics";
import styles from "./trends.module.css";

const axes = {
  cost: { label: "Cost per task", format: formatCost },
  duration: { label: "Average duration per trial", format: formatDuration },
};
type Axis = keyof typeof axes;
type Point = BenchmarkRun & { metric: number };

export function paretoFrontier(points: Point[]) {
  const order = [...points].sort((first, second) => first.metric - second.metric || second.resolved - first.resolved);
  let best = -1;
  let bestMetric = -1;
  return order.filter(({ metric, resolved }) => {
    if (resolved < best || (resolved === best && metric !== bestMetric)) return false;
    best = resolved;
    bestMetric = metric;
    return true;
  });
}

function Plot({ points, frontier, axis }: { points: Point[]; frontier: Point[]; axis: Axis }) {
  const [selection, select] = useState("");
  if (points.length === 0) return <p className={styles.empty}>No results with a reported {axis === "cost" ? "cost" : "duration"} match these filters.</p>;

  const selected = (selection && points.find(({ id }) => id === selection)) || points[0];
  const maximum = Math.max(...points.map(({ metric }) => metric)) || 1;
  const xPosition = (value: number) => 100 * value / maximum;
  const ids = new Set(frontier.map(({ id }) => id));
  const xTicks = [0, 0.25, 0.5, 0.75, 1];
  const yTicks = [0, 25, 50, 75, 100];

  return (
    <>
      <div className={styles.chart}>
        <span className={styles.chartYLabel}>Resolved</span>
        <div className={styles.plot} role="group" aria-label={`Resolution rate versus ${axes[axis].label.toLowerCase()}`}>
          {yTicks.map((value) => (
            <div key={value} className={styles.plotRow} style={{ bottom: `${value}%` }} aria-hidden="true">
              <span>{value}%</span>
            </div>
          ))}
          {xTicks.map((value) => (
            <span key={value} className={styles.chartTick} style={{ left: `${value * 100}%` }} aria-hidden="true">{axes[axis].format(value * maximum)}</span>
          ))}
          <svg className={styles.plotLines} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={frontier.map(({ metric, resolved }) => `${xPosition(metric)},${100 - resolved}`).join(" ")}
              fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
          {points.map((point) => (
            <button key={point.id} type="button" tabIndex={-1} className={styles.marker}
              style={{ left: `${xPosition(point.metric)}%`, bottom: `${point.resolved}%` }}
              aria-label={`${point.name}, ${formatPercent(point.resolved)} resolved, ${axes[axis].format(point.metric)}`}
              title={point.name} aria-pressed={selected.id === point.id} data-frontier={ids.has(point.id)}
              onClick={() => select(point.id)} />
          ))}
        </div>
        <span className={styles.chartXLabel}>{axes[axis].label}</span>
      </div>
      <div className={styles.chartInspector}>
        <label className={styles.compactField}>Inspect a submission
          <select value={selected.id} onChange={(event) => select(event.target.value)}>
            {points.map((point) => (
              <option key={point.id} value={point.id}>{point.name} · {point.effort ?? "Effort unreported"} · {point.date}</option>
            ))}
          </select>
        </label>
        <p aria-live="polite">{formatPercent(selected.resolved)} resolved · {axes[axis].format(selected.metric)}{ids.has(selected.id) && " · Pareto frontier"}</p>
      </div>
    </>
  );
}

function BenchmarkTable({ runs, frontier }: { runs: BenchmarkRun[]; frontier: Set<string> }) {
  const hasDuration = runs.some(({ duration }) => duration !== null);
  const hasCalls = runs.some(({ apiCalls }) => apiCalls !== null);
  return (
    <div className={styles.tableRegion} role="region" aria-label="Benchmark results" tabIndex={0}>
      <table>
        <thead><tr><th scope="col">Submission</th><th scope="col">Resolved</th><th scope="col">Cost per task</th>
          {hasDuration && <th scope="col">Average duration</th>}{hasCalls && <th scope="col">API calls per issue</th>}
          <th scope="col">Date</th></tr></thead>
        <tbody>{runs.map(({ id, name, model, agent, effort, date, resolved, cost, duration, apiCalls }) => (
          <tr key={id}>
            <th scope="row">{name}
              <small>{[model !== name && !name.startsWith(model + " ·") ? model : "", !name.endsWith(" · " + agent) ? agent : "", effort ?? "Effort unreported"].filter(Boolean).join(" · ")}</small>
              {frontier.has(id) && <small className={styles.frontierLabel}>Pareto frontier</small>}
            </th>
            <td>{formatPercent(resolved)}</td><td>{reportNumber(cost, formatCost)}</td>
            {hasDuration && <td>{reportNumber(duration, formatDuration)}</td>}{hasCalls && <td>{reportNumber(apiCalls, formatDecimal)}</td>}
            <td><time dateTime={date}>{date}</time></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function BenchmarkExplorer({ boards }: { boards: BenchmarkBoard[] }) {
  const [dataset, selectDataset] = useState(boards.find(({ name }) => name === "SWE-bench Verified")?.name ?? boards[0].name);
  const [search, setSearch] = useState("");
  const [model, selectModel] = useState("");
  const [effort, selectEffort] = useState("");
  const [sort, setSort] = useState("score");
  const [axis, setAxis] = useState<Axis>("cost");
  const [view, setView] = useState<"plot" | "table">("plot");
  const [frontierOnly, setFrontierOnly] = useState(false);
  const board = boards.find(({ name }) => name === dataset) ?? boards[0];
  const models = [...new Set(board.runs.map((run) => run.model))].sort();
  const efforts = [...new Set(board.runs.flatMap((run) => run.effort ? [run.effort] : []))].sort();
  const matches = search.trim().toLowerCase();
  const runs = board.runs.filter((run) => (!model || run.model === model) &&
    (!effort || (run.effort ?? "unreported") === effort) && `${run.name} ${run.model} ${run.agent}`.toLowerCase().includes(matches));

  const points = runs.flatMap((run): Point[] => {
    const metric = run[axis];
    return metric !== null ? [{ ...run, metric }] : [];
  });
  const frontier = paretoFrontier(points);
  const ids = new Set(frontier.map(({ id }) => id));
  const visibleRuns = (frontierOnly ? runs.filter(({ id }) => ids.has(id)) : runs).sort((first, second) => {
    if (sort === "cost") return ((first.cost ?? Infinity) - (second.cost ?? Infinity)) || second.resolved - first.resolved;
    if (sort === "recent") return second.date.localeCompare(first.date) || second.resolved - first.resolved;
    return second.resolved - first.resolved || second.date.localeCompare(first.date);
  });

  function changeDataset(name: string) {
    selectDataset(name);
    selectModel("");
    selectEffort("");
    setAxis("cost");
  }

  return (
    <>
      <div className={styles.form}>
        <label>Dataset<select value={dataset} onChange={(event) => changeDataset(event.target.value)}>
          {boards.map(({ name }) => <option key={name}>{name}</option>)}
        </select></label>
        <label>Model<select aria-label="Model" value={model} onChange={(event) => selectModel(event.target.value)}>
          <option value="">All models</option>
          {models.map((name) => <option key={name}>{name}</option>)}
        </select></label>
        <label>Reasoning effort<select value={effort} onChange={(event) => selectEffort(event.target.value)}>
          <option value="">All effort levels</option>
          {efforts.map((name) => <option key={name}>{name}</option>)}
          {board.runs.some((run) => run.effort === null) && <option value="unreported">Unreported</option>}
        </select></label>
        <label>Search<input type="search" placeholder="Model or agent" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      <section className={styles.panel} aria-labelledby="submissions-title">
        <div className={styles.panelHeader}>
          <div><h3 id="submissions-title">Benchmark submissions</h3><p aria-live="polite">{visibleRuns.length} {visibleRuns.length === 1 ? "result" : "results"}{view === "plot" && ` · ${frontierOnly ? frontier.length : points.length} plotted`}</p></div>
          <div className={styles.segments} aria-label="Results view">
            <button type="button" aria-pressed={view === "plot"} onClick={() => setView("plot")}>Plot</button>
            <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>Table</button>
          </div>
        </div>
        <div className={styles.controls}>
          <label className={styles.compactField}>Compare by <select value={axis} onChange={(event) => setAxis(event.target.value === "duration" ? "duration" : "cost")}>
            <option value="cost">Cost</option>
            <option value="duration" disabled={!board.runs.some(({ duration }) => duration !== null)}>Duration</option>
          </select></label>
          <label className={styles.check}><input type="checkbox" checked={frontierOnly} onChange={(event) => setFrontierOnly(event.target.checked)} /> Frontier only</label>
          {view === "table" && <label className={styles.compactField}>Sort by<select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="score">Highest resolution rate</option><option value="recent">Most recent</option><option value="cost">Lowest cost</option>
          </select></label>}
        </div>
        {view === "plot" ? <Plot key={dataset} points={frontierOnly ? frontier : points} frontier={frontier} axis={axis} />
          : visibleRuns.length ? <BenchmarkTable runs={visibleRuns} frontier={ids} />
            : <p className={styles.empty}>No submissions match these filters.</p>}
      </section>
      <p className={styles.source}>
        The frontier marks the best {axis === "cost" ? "cost" : "time"} and resolution trade-offs among the filtered submissions.
        {" "}<a href={board.source.href}>{board.source.name} ↗</a>
      </p>
    </>
  );
}
