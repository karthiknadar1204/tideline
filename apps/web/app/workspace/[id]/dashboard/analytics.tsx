import Link from "next/link";
import type { CSSProperties } from "react";
import { formatCost, formatCount } from "../../../../lib/usage";
import type { UsageRow } from "../../../../lib/usage";
import { analyticsHref, analyticsMetrics, analyticsSessionsHref, formatAnalyticsMetric, timelineMetric } from "../../../../lib/workspace-analytics";
import type { AnalyticsFilters, AnalyticsMetric, buildWorkspaceAnalytics } from "../../../../lib/workspace-analytics";
import styles from "./analytics.module.css";

type Report = ReturnType<typeof buildWorkspaceAnalytics>;
const dayLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const monthLabel = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });
const compactCost = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });

function chartLabel(metric: AnalyticsMetric, value: number) {
  if (metric !== "cost") return formatAnalyticsMetric(metric, value);
  return value > 0 && value < 0.0001 ? "<$0.0001" : compactCost.format(value);
}

function periodLabel(period: string) {
  return period.length === 10 ? dayLabel.format(new Date(period)) : monthLabel.format(new Date(`${period}-01`));
}

export function AnalyticsSeries({ path, workspaceId, metric, filters, report }: {
  path: string;
  workspaceId: string;
  metric: AnalyticsMetric;
  filters: AnalyticsFilters;
  report: Report;
}) {
  const points = report.timeline.map((entry) => ({ period: entry.period, ...timelineMetric(entry, metric) }));
  const max = points.reduce((peak, point) => Math.max(peak, point.value ?? 0), 0);
  const maxHeight = max || 1;
  const visibleLabels = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const currentMetric = report.metrics.find(({ id }) => id === metric);
  const hasData = currentMetric && currentMetric.value !== null && report.sessions.length > 0;
  const seriesTitle = `${analyticsMetrics[metric]} by ${report.granularity}`;

  return (
    <section className={styles.series} aria-labelledby="analytics-series">
      <nav aria-label="Chart metric" className={styles.metrics}>
        {report.metrics.map(({ id, value, complete }) => (
          <Link key={id} href={analyticsHref(path, filters, { metric: id })} scroll={false}
            aria-current={metric === id ? "true" : undefined} className={styles.metric}>
            <span>{analyticsMetrics[id]}</span>
            <strong title={value === null ? undefined : formatAnalyticsMetric(id, value)}>{value === null ? "—" : chartLabel(id, value)}</strong>
            {value !== null && !complete && <small>Partial</small>}
          </Link>
        ))}
      </nav>
      <div className={styles.plotPanel}>
        <div className={styles.sectionHeading}>
          <h2 id="analytics-series">{seriesTitle}</h2>
          <Link href={analyticsSessionsHref(workspaceId, filters, report.firstDay)}>View sessions <span aria-hidden>→</span></Link>
        </div>
        {hasData ? (
          <>
            <div className={styles.plot}>
              <div className={styles.axis} aria-hidden>
                {max > 0 && <span>{chartLabel(metric, max)}</span>}
                <span>{chartLabel(metric, 0)}</span>
              </div>
              <div className={styles.track} style={{ "--points": points.length } as CSSProperties}>
                {points.map(({ period, value, complete }, index) => {
                  const label = periodLabel(period);
                  const amount = value === null ? "Unavailable" : `${formatAnalyticsMetric(metric, value)}${complete ? "" : " recorded"}`;
                  return (
                    <Link key={period} className={styles.point} data-age={index < points.length / 3 ? "start" : index > points.length * 2 / 3 ? "end" : "middle"}
                      href={analyticsSessionsHref(workspaceId, filters, report.firstDay, { period })}
                      aria-label={`${label}, ${amount}. Open sessions.`}>
                      <span className={styles.bar} data-coverage={value === null ? "unavailable" : complete ? "complete" : "partial"}
                        style={{ "--height": `${100 * (value ?? 0) / maxHeight}%` } as CSSProperties} aria-hidden />
                      <span className={styles.tooltip} aria-hidden><strong>{label}</strong> {amount}</span>
                    </Link>
                  );
                })}
              </div>
              <div className={styles.periods} aria-hidden>
                {visibleLabels.map((index) => <time key={points[index].period}>{periodLabel(points[index].period)}</time>)}
              </div>
            </div>
            {currentMetric && !currentMetric.complete && <p className={styles.coverage}>Some sessions did not report this metric. The chart shows recorded values.</p>}
          </>
        ) : (
          <div className={styles.missing}>
            <p>{report.sessions.length ? "This metric was unavailable for the selected sessions." : "No sessions during this period."}</p>
            {!report.sessions.length && <Link href={analyticsHref(path, { ...filters, days: "all" }, { metric })}>Show all time</Link>}
          </div>
        )}
      </div>
    </section>
  );
}

export function UsageTable({ title, rows, hrefFor, more }: {
  title: string;
  rows: UsageRow[];
  hrefFor: (row: UsageRow) => string | undefined;
  more?: string;
}) {
  return (
    <section aria-label={title} className={styles.tablePanel}>
      <div className={styles.sectionHeading}>
        <h2>{title}</h2>
        {more && <Link href={more}>View all <span aria-hidden>→</span></Link>}
      </div>
      {rows.length ? (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead><tr><th scope="col">Name</th><th scope="col">Sessions</th><th scope="col">Tokens</th><th scope="col">Est. cost</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const href = hrefFor(row);
                const { tokens, cost } = row.usage;
                return (
                  <tr key={row.key ?? row.name}>
                    <th scope="row">{href ? <Link href={href}>{row.name}</Link> : row.name}</th>
                    <td>{formatCount(row.sessionCount)}</td>
                    <td>{tokens.value === null ? "—" : formatCount(tokens.value)}{tokens.value !== null && !tokens.complete && <small>Partial</small>}</td>
                    <td>{cost.value === null ? "—" : formatCost(cost.value)}{cost.value !== null && !cost.complete && <small>Partial</small>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className={styles.emptyTable}>No data in this period.</p>}
    </section>
  );
}
