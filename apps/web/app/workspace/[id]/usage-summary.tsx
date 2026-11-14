import type { SessionSummary } from "@tideline/contracts";
import { formatCost, formatCount, summarizeModel, summarizeSession, summarizeWorkspace } from "../../../lib/usage";
import type { Usage, UsageRow } from "../../../lib/usage";

function MetricValue({ metric, format }: { metric: Usage["tokens"]; format: (value: number) => string }) {
  if (metric.value === null) return <span className="text-sm opacity-70">Unavailable</span>;

  return (
    <span>
      <span className="tabular-nums">{format(metric.value)}</span>
      {!metric.complete && <span className="block text-xs font-normal opacity-70">Partial</span>}
    </span>
  );
}

function BreakdownTable({
  heading,
  headingId,
  label,
  rows,
  showSessionCount = true,
}: {
  heading: string;
  headingId: string;
  label: string;
  rows: UsageRow[];
  showSessionCount?: boolean;
}) {
  return (
    <section className="min-w-0 space-y-3" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-lg font-semibold">{heading}</h3>
      <div className="overflow-x-auto rounded-lg border border-current/15">
        <table className="w-full border-collapse text-sm">
          <thead className="border-b border-current/15 bg-current/5">
            <tr>
              <th scope="col" className="px-3 py-3 text-left font-medium">{label}</th>
              {showSessionCount && <th scope="col" className="px-3 py-3 text-right font-medium">Sessions</th>}
              <th scope="col" className="px-3 py-3 text-right font-medium">Tokens</th>
              <th scope="col" className="px-3 py-3 text-right font-medium">Est. cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-current/15">
            {rows.map((row) => (
              <tr key={row.key === null ? "unknown" : `known:${row.key}`}>
                <th scope="row" className="px-3 py-3 text-left font-medium [overflow-wrap:anywhere]">
                  {row.name}
                </th>
                {showSessionCount && <td className="px-3 py-3 text-right tabular-nums">{formatCount(row.sessionCount)}</td>}
                <td className="px-3 py-3 text-right"><MetricValue metric={row.usage.tokens} format={formatCount} /></td>
                <td className="px-3 py-3 text-right"><MetricValue metric={row.usage.cost} format={formatCost} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UsageCards({ label, value, usage }: { label: string; value: string; usage: Usage }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      <div className="min-w-0 space-y-2 rounded-lg border border-current/15 p-4">
        <dt className="text-sm opacity-75">{label}</dt>
        <dd className="text-2xl font-semibold tabular-nums [overflow-wrap:anywhere]">{value}</dd>
      </div>
      <div className="space-y-2 rounded-lg border border-current/15 p-4">
        <dt className="text-sm opacity-75">Reported tokens</dt>
        <dd className="text-2xl font-semibold"><MetricValue metric={usage.tokens} format={formatCount} /></dd>
      </div>
      <div className="space-y-2 rounded-lg border border-current/15 p-4">
        <dt className="text-sm opacity-75">Estimated cost (USD)</dt>
        <dd className="text-2xl font-semibold"><MetricValue metric={usage.cost} format={formatCost} /></dd>
      </div>
    </dl>
  );
}

export function WorkspaceUsage({ sessions }: { sessions: SessionSummary[] }) {
  const usage = summarizeWorkspace(sessions);
  return (
    <section className="mt-10 space-y-4" aria-labelledby="usage-overview">
      <h2 id="usage-overview" className="text-xl font-semibold">Usage overview</h2>
      <UsageCards label="Sessions" value={formatCount(sessions.length)} usage={usage.total} />
      {sessions.length > 0 && (
        <>
          <p className="text-sm opacity-75">Cost estimates use standard API token rates. Partial totals include the usage Tideline can count or price.</p>
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <BreakdownTable heading="Repositories" headingId="repositories" label="Repository" rows={usage.repositories} />
            <BreakdownTable heading="Models" headingId="models" label="Model" rows={usage.models} />
          </div>
        </>
      )}
    </section>
  );
}

export function SessionUsage({ analytics }: { analytics: SessionSummary["analytics"] }) {
  const repository = analytics?.repository?.name ?? "Unknown repository";
  const models = analytics?.models.map((model) => ({
    key: model.model,
    name: model.model ?? "Unknown model",
    sessionCount: 1,
    usage: summarizeModel(model, analytics.tokenCoverage),
  })) ?? [];

  return (
    <section className="mt-8 space-y-4" aria-labelledby="session-usage">
      <h2 id="session-usage" className="text-xl font-semibold">Session usage</h2>
      <UsageCards label="Repository" value={repository} usage={summarizeSession(analytics)} />
      {models.length ? (
        <BreakdownTable heading="Models" headingId="session-models" label="Model" rows={models} showSessionCount={false} />
      ) : (
        <p className="text-sm opacity-75">Model data is unavailable for this session.</p>
      )}
    </section>
  );
}
