import Link from "next/link";
import { readGitHubActivity } from "../../../../lib/github-activity";
import { reportFilterParams } from "../../../../lib/reports";
import type { AnalyticsFilters } from "../../../../lib/workspace-analytics";
import styles from "./analytics.module.css";

export async function GitHubSummary({ workspaceId, filters }: { workspaceId: string; filters: AnalyticsFilters }) {
  const { counts } = await readGitHubActivity(workspaceId, filters);
  const base = `/workspace/${workspaceId}/reports/github`;

  return (
    <section className={`${styles.tablePanel} space-y-3 p-4`} aria-labelledby="github-overview">
      <h2 id="github-overview" className="font-semibold">GitHub activity</h2>
      {counts.merge > 0 || counts.ci > 0 ? (
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          {([["merge", "Merged PRs"], ["ci", "CI runs"]] as const).map(([kind, label]) => {
            const query = new URLSearchParams(reportFilterParams({ ...filters, source: undefined }));
            query.set("kind", kind);
            return (
              <Link key={kind} href={`${base}?${query}`} className="hover:underline">
                {label} <strong className="tabular-nums">{counts[kind].toLocaleString("en-US")}</strong>
              </Link>
            );
          })}
        </div>
      ) : <Link href={base} className="text-sm underline">View GitHub activity and sync instructions</Link>}
    </section>
  );
}
