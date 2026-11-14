import type { SessionSummary } from "@tideline/contracts";

type Analytics = NonNullable<SessionSummary["analytics"]>;
type ModelUsage = Analytics["models"][number];

type Metric = { value: null; complete: false } | { value: number; complete: boolean };
export type Usage = { tokens: Metric; cost: Metric };
export type UsageRow = {
  key: string | null;
  name: string;
  sessionCount: number;
  usage: Usage;
};

const counts = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 8,
});

export function formatCount(count: number) {
  return counts.format(count);
}

export function formatCost(amount: number) {
  return amount > 0 && amount < 0.00000001 ? "<$0.00000001" : dollars.format(amount);
}

function combineMetrics(metrics: Metric[]): Metric {
  let value: number | null = null;
  let complete = metrics.length > 0;
  for (const metric of metrics) {
    if (metric.value !== null) value = (value ?? 0) + metric.value;
    complete = complete && metric.complete;
  }
  return toMetric(value, complete);
}

function toMetric(value: number | null, complete: boolean): Metric {
  return value === null ? { value: null, complete: false } : { value, complete };
}

function combineUsage(entries: Usage[]): Usage {
  return {
    tokens: combineMetrics(entries.map((entry) => entry.tokens)),
    cost: combineMetrics(entries.map((entry) => entry.cost)),
  };
}

export function summarizeModel(model: ModelUsage, coverage: Analytics["tokenCoverage"]): Usage {
  const tokens = model.tokens;
  const tokenCount = tokens === null ? null :
    tokens.input + tokens.cachedInput + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheWriteUnknown + tokens.output;
  return {
    tokens: toMetric(tokenCount, coverage === "reported"),
    cost: toMetric(model.estimatedCostUsd, coverage === "reported"),
  };
}

export function summarizeSession(analytics: SessionSummary["analytics"]): Usage {
  return combineUsage(analytics?.models.map((model) => summarizeModel(model, analytics.tokenCoverage)) ?? []);
}

type Group = { name: string; entries: Usage[] };

function addGroup(groups: Map<string | null, Group>, key: string | null, name: string, usage: Usage) {
  const group = groups.get(key);
  if (group) {
    group.entries.push(usage);
  } else {
    groups.set(key, { name, entries: [usage] });
  }
}

function usageRows(groups: Map<string | null, Group>): UsageRow[] {
  return Array.from(groups, ([key, { name, entries }]) => ({
    key, name, sessionCount: entries.length, usage: combineUsage(entries),
  })).sort((first, second) => Number(first.key === null) - Number(second.key === null) ||
    second.sessionCount - first.sessionCount || first.name.localeCompare(second.name, "en-US"));
}

export function summarizeWorkspace(sessions: SessionSummary[]) {
  const repositories = new Map<string | null, Group>();
  const models = new Map<string | null, Group>();
  const entries = sessions.map((session) => {
    const analytics = session.analytics;
    const usage = summarizeSession(analytics);
    addGroup(repositories, analytics?.repository?.key ?? null, analytics?.repository?.name ?? "Unknown repository", usage);

    if (analytics?.models.length) {
      for (const model of analytics.models) {
        addGroup(models, model.model, model.model ?? "Unknown model", summarizeModel(model, analytics.tokenCoverage));
      }
    } else {
      addGroup(models, null, "Unknown model", usage);
    }

    return usage;
  });
  return {
    total: combineUsage(entries),
    repositories: usageRows(repositories),
    models: usageRows(models),
  };
}
