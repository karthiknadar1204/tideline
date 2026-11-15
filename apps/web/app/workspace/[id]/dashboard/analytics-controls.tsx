"use client";

import { sessionSource, sessionSourceLabel } from "@tideline/contracts";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import { reportPeriods } from "../../../../lib/reports";
import { analyticsHref } from "../../../../lib/workspace-analytics";
import type { AnalyticsFilters, AnalyticsMetric, RepositoryView } from "../../../../lib/workspace-analytics";
import styles from "./analytics.module.css";

export function AnalyticsControls({ path, filters, metric, today, view, showSource = true }: {
  path: string;
  filters: AnalyticsFilters;
  metric?: AnalyticsMetric;
  today: string;
  view?: RepositoryView;
  showSource?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selection, setSelection] = useState(filters);

  function navigate(next: AnalyticsFilters) {
    setSelection(next);
    startTransition(() => router.push(analyticsHref(path, next, { metric, view }), { scroll: false }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate(selection);
  }

  return (
    <form className={styles.controls} aria-label="Analytics filters" aria-busy={pending} action={path} onSubmit={submit}>
      {filters.repository && <input type="hidden" name="repository" value={filters.repository} />}
      {metric && <input type="hidden" name="metric" value={metric} />}
      {view && <input type="hidden" name="view" value={view} />}
      <label>
        <span className="sr-only">Time period</span>
        <select name="days" aria-label="Time period" value={selection.days} onChange={(event) => {
          const days = reportPeriods.find((period) => String(period) === event.target.value);
          if (days) navigate({ ...selection, days });
        }}>
          {reportPeriods.map((period) => <option key={period} value={period}>{period === "all" ? "All time" : `Last ${period} days`}</option>)}
        </select>
      </label>
      {showSource && (
        <label>
          <span className="sr-only">Agent</span>
          <select name="source" aria-label="Agent" value={selection.source ?? ""} onChange={(event) => {
            navigate({ ...selection, source: sessionSource.safeParse(event.target.value).data });
          }}>
            <option value="">All agents</option>
            {sessionSource.options.map((source) => <option key={source} value={source}>{sessionSourceLabel[source]}</option>)}
          </select>
        </label>
      )}
      <label className={styles.date}>
        <span>Through</span>
        <input type="date" name="through" aria-label="Through date" value={selection.through} max={today} min="0001-01-01"
          onChange={(event) => {
            if (event.target.validity.valid) navigate({ ...selection, through: event.target.value || today });
          }} />
      </label>
      <noscript><button type="submit">Apply</button></noscript>
    </form>
  );
}
