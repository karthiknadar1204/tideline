"use client";

import { useState } from "react";
import type { BenchmarkBoard, BenchmarkRun } from "../../lib/public-trends";
import { formatCost, formatDecimal, formatDuration, formatPercent, plotScale, reportNumber, type Scale } from "./metrics";
import styles from "./trends.module.css";

const axes = {
  cost: { label: "Cost per task", format: formatCost },
  duration: { label: "Average duration per trial", format: formatDuration },
};
type Axis = keyof typeof axes;
type Point = BenchmarkRun & { metric: number };
const modelLimit = 12;

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

function Plot({ points, frontier, axis, scale, showLine, modelLabels, effortLabels }: {
  points: Point[];
  frontier: Point[];
  axis: Axis;
  scale: Scale;
  showLine: boolean;
  modelLabels: boolean;
  effortLabels: boolean;
}) {
  const [selection, select] = useState("");
  if (points.length === 0) return <p className={styles.empty}>No results with a reported {axis === "cost" ? "cost" : "duration"} match these filters.</p>;

  const selected = (selection && points.find(({ id }) => id === selection)) || points[0];
  const { position: xPosition, ticks: xTicks } = plotScale(points.map(({ metric }) => metric), scale);
  const ids = new Set(frontier.map(({ id }) => id));
  const yTicks = [0, 25, 50, 75, 100];
  const labels = new Map<string, { x: number; y: number; text: string }>();
  if (modelLabels || effortLabels) {
    for (const point of [selected, ...frontier, ...points]) {
      const x = xPosition(point.metric);
      if ([...labels.values()].some((label) => Math.abs(label.x - x) < 23 && Math.abs(label.y - point.resolved) < 7)) continue;
      const label = [modelLabels && point.model, effortLabels && (point.effort ?? "Unreported effort")].filter(Boolean).join(" · ");
      labels.set(point.id, { x, y: point.resolved, text: label });
    }
  }

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
          {xTicks.map((value, index) => (
            <span key={index} className={styles.chartTick} style={{ left: `${index * 25}%` }} aria-hidden="true">{axes[axis].format(value)}</span>
          ))}
          {showLine && <svg className={styles.plotLines} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={frontier.map(({ metric, resolved }) => `${xPosition(metric)},${100 - resolved}`).join(" ")}
              fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>}
          {points.map((point) => (
            <button key={point.id} type="button" tabIndex={-1} className={styles.marker}
              style={{ left: `${xPosition(point.metric)}%`, bottom: `${point.resolved}%` }}
              aria-label={`${point.name}, ${formatPercent(point.resolved)} resolved, ${axes[axis].format(point.metric)}`}
              title={point.name} aria-pressed={selected.id === point.id} data-frontier={ids.has(point.id)}
              onClick={() => select(point.id)}>
              {labels.has(point.id) && <span className={styles.pointLabel} aria-hidden="true" data-left={xPosition(point.metric) > 65}>
                {labels.get(point.id)?.text}
              </span>}
            </button>
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
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [effort, selectEffort] = useState("");
  const [sort, setSort] = useState("score");
  const [axis, setAxis] = useState<Axis>("cost");
  const [scale, setScale] = useState<Scale>("linear");
  const [view, setView] = useState<"plot" | "table">("plot");
  const [frontierOnly, setFrontierOnly] = useState(false);
  const [showLine, setShowLine] = useState(true);
  const [modelLabels, setModelLabels] = useState(false);
  const [effortLabels, setEffortLabels] = useState(false);
  const board = boards.find(({ name }) => name === dataset) ?? boards[0];
  const models = [...new Set(board.runs.map((run) => run.model))].sort();
  const efforts = [...new Set(board.runs.flatMap((run) => run.effort ? [run.effort] : []))].sort();
  const matches = search.trim().toLowerCase();
  const runs = board.runs.filter((run) => (!selectedModels.length || selectedModels.includes(run.model)) &&
    (!effort || (run.effort ?? "unreported") === effort) && `${run.name} ${run.model} ${run.agent}`.toLowerCase().includes(matches));

  const points = runs.flatMap((run): Point[] => {
    const metric = run[axis];
    return metric !== null ? [{ ...run, metric }] : [];
  });
  const frontier = paretoFrontier(points);
  const ids = new Set(frontier.map(({ id }) => id));
  const pointCandidates = frontierOnly ? frontier : points;
  const visiblePoints = scale === "log" ? pointCandidates.filter(({ metric }) => metric > 0) : pointCandidates;
  const visibleFrontier = scale === "log" ? frontier.filter(({ metric }) => metric > 0) : frontier;
  const excludedZeros = pointCandidates.length - visiblePoints.length;
  const visibleRuns = (frontierOnly ? runs.filter(({ id }) => ids.has(id)) : runs).sort((first, second) => {
    if (sort === "cost") return ((first.cost ?? Infinity) - (second.cost ?? Infinity)) || second.resolved - first.resolved;
    if (sort === "recent") return second.date.localeCompare(first.date) || second.resolved - first.resolved;
    return second.resolved - first.resolved || second.date.localeCompare(first.date);
  });

  function changeDataset(name: string) {
    selectDataset(name);
    setSelectedModels([]);
    selectEffort("");
    setAxis("cost");
  }

  return (
    <>
      <div className={styles.form}>
        <label>Dataset<select value={dataset} onChange={(event) => changeDataset(event.target.value)}>
          {boards.map(({ name }) => <option key={name}>{name}</option>)}
        </select></label>
        <label>Models<select value="" disabled={selectedModels.length >= modelLimit || selectedModels.length === models.length}
          onChange={(event) => {
            const name = event.target.value;
            if (!name) return;
            setSelectedModels((selected) => selected.length >= modelLimit || selected.includes(name) ? selected : [...selected, name]);
          }}>
          <option value="">{selectedModels.length ? `Add a model (${selectedModels.length}/${modelLimit})` : "All models"}</option>
          {models.filter((name) => !selectedModels.includes(name)).map((name) => <option key={name}>{name}</option>)}
        </select></label>
        <label>Reasoning effort<select value={effort} onChange={(event) => selectEffort(event.target.value)}>
          <option value="">All effort levels</option>
          {efforts.map((name) => <option key={name}>{name}</option>)}
          {board.runs.some((run) => run.effort === null) && <option value="unreported">Unreported</option>}
        </select></label>
        <label>Search<input type="search" placeholder="Model or agent" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      {selectedModels.length > 0 && (
        <ul className={styles.modelSelection} aria-label="Selected models">
          {selectedModels.map((name) => <li key={name}>
            <button type="button" aria-label={`Remove ${name}`} onClick={() => setSelectedModels((selected) => selected.filter((model) => model !== name))}>
              {name} <span aria-hidden="true">×</span>
            </button>
          </li>)}
          <li><button type="button" onClick={() => setSelectedModels([])}>Clear models</button></li>
        </ul>
      )}
      <section className={styles.panel} aria-labelledby="submissions-title">
        <div className={styles.panelHeader}>
          <div><h3 id="submissions-title">Benchmark submissions</h3><p aria-live="polite">{visibleRuns.length} {visibleRuns.length === 1 ? "result" : "results"}{view === "plot" && ` · ${visiblePoints.length} plotted`}</p></div>
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
          {view === "plot" && (
            <label className={styles.compactField}>Scale<select value={scale} onChange={(event) => setScale(event.target.value === "log" ? "log" : "linear")}>
              <option value="linear">Linear</option><option value="log">Logarithmic</option>
            </select></label>
          )}
          <label className={styles.check}><input type="checkbox" checked={frontierOnly} onChange={(event) => setFrontierOnly(event.target.checked)} /> Frontier only</label>
          {view === "plot" && <>
            <label className={styles.check}><input type="checkbox" checked={showLine} onChange={(event) => setShowLine(event.target.checked)} /> Pareto line</label>
            <label className={styles.check}><input type="checkbox" checked={modelLabels} onChange={(event) => setModelLabels(event.target.checked)} /> Model labels</label>
            <label className={styles.check}><input type="checkbox" checked={effortLabels} onChange={(event) => setEffortLabels(event.target.checked)} /> Effort labels</label>
          </>}
          {view === "table" && <label className={styles.compactField}>Sort by<select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="score">Highest resolution rate</option><option value="recent">Most recent</option><option value="cost">Lowest cost</option>
          </select></label>}
        </div>
        {view === "plot" ? <Plot key={dataset} points={visiblePoints} frontier={visibleFrontier} axis={axis}
          scale={scale} showLine={showLine} modelLabels={modelLabels} effortLabels={effortLabels} />
          : visibleRuns.length ? <BenchmarkTable runs={visibleRuns} frontier={ids} />
            : <p className={styles.empty}>No submissions match these filters.</p>}
      </section>
      <p className={styles.source}>
        The frontier marks the best {axis === "cost" ? "cost" : "time"} and resolution trade-offs among the filtered submissions.
        {" "}<a href={board.source.href}>{board.source.name} ↗</a>
      </p>
      {view === "plot" && excludedZeros > 0 && <p className={styles.source}>The logarithmic plot leaves out {excludedZeros} {excludedZeros === 1 ? "zero value" : "zero values"}. Switch to Linear or Table to see them.</p>}
    </>
  );
}
