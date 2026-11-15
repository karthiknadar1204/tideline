import { syncCoverageResponse } from "@tideline/contracts";
import { teamPanel } from "../../../../lib/team-ui";
import { fetchWorkspaceResource } from "../../../../lib/workspace";

export async function SyncCoverage({ workspaceId }: { workspaceId: string }) {
  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/sync-coverage`, { allowNotFound: true });
  const parsed = syncCoverageResponse.safeParse(response?.ok ? await response.json() : null);
  const report = parsed.data;

  return (
    <section aria-labelledby="sync-coverage" className={teamPanel}>
      <h2 id="sync-coverage" className="font-semibold">Sync coverage</h2>
      {report?.collectors ? (
        <>
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            {([["Discovered sessions", report.known], ["Ready", report.ready], ["Processing", report.pending],
              ["Missing from workspace", report.known - report.ready - report.pending]] as const).map(([label, value]) => (
              <div key={label}><dt className="text-[var(--workspace-muted)]">{label}</dt><dd className="font-medium tabular-nums">{value.toLocaleString("en-US")}</dd></div>
            ))}
          </dl>
          <p className="text-sm text-[var(--workspace-muted)]">
            {report.partial ? "Some approved sessions could not be counted. " : ""}
            {report.collectors.toLocaleString("en-US")} {report.collectors === 1 ? "collector" : "collectors"}
            {report.reportedAt && <> · Last checked <time dateTime={report.reportedAt}>{report.reportedAt.slice(0, 16).replace("T", " ")} UTC</time></>}
          </p>
        </>
      ) : <p className="text-sm text-[var(--workspace-muted)]">Coverage is unknown until a collector sends its first inventory.</p>}
    </section>
  );
}
