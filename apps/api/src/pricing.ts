import type { SessionAnalytics, SessionSource, SessionSummary } from "@tideline/contracts";

type Rates = {
  input: number;
  cachedInput: number;
  output: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

const sonnet46 = { input: 3, cachedInput: 0.3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6 };
const opus46 = { input: 5, cachedInput: 0.5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10 };
const haiku45 = { input: 1, cachedInput: 0.1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2 };

// Standard API USD per million tokens. See https://developers.openai.com/api/docs/pricing
// and https://platform.claude.com/docs/en/about-claude/pricing.
const standardRates: Partial<Record<SessionSource, ReadonlyMap<string, Rates>>> = {
  codex: new Map<string, Rates>([
    ["gpt-5.3-codex", { input: 1.75, cachedInput: 0.175, output: 14 }],
    ["gpt-5.4", { input: 2.5, cachedInput: 0.25, output: 15 }],
    ["gpt-5.4-mini", { input: 0.75, cachedInput: 0.075, output: 4.5 }],
    ["gpt-6.1-sol", { input: 2, cachedInput: 0.1, output: 10 }],
    ["gpt-6.1-terra", { input: 1, cachedInput: 0.05, output: 5 }],
    ["gpt-6-luna", { input: 0.1, cachedInput: 0.01, output: 0.5 }],
    ["gpt-6-astra", { input: 10, cachedInput: 1, output: 50 }],
  ]),
  "claude-code": new Map<string, Rates>([
    ["claude-sonnet-4-5", sonnet46],
    ["claude-sonnet-4-5-20250929", sonnet46],
    ["claude-sonnet-4-6", sonnet46],
    ["claude-opus-4-5", opus46],
    ["claude-opus-4-5-20251101", opus46],
    ["claude-opus-4-6", opus46],
    ["claude-opus-4-7", opus46],
    ["claude-opus-4-8", opus46],
    ["claude-opus-5", opus46],
    ["claude-haiku-4-5", haiku45],
    ["claude-haiku-4-5-20251001", haiku45],
    ["claude-sonnet-5", { input: 2, cachedInput: 0.2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4 }],
    ["claude-sonnet-5-5", { input: 2, cachedInput: 0.1, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4 }],
    ["claude-opus-5-5", { input: 4, cachedInput: 0.2, output: 20, cacheWrite5m: 5, cacheWrite1h: 8 }],
  ]),
};

function estimateCost(source: SessionSource, { model, tokens }: SessionAnalytics["models"][number]) {
  const rate = model && standardRates[source]?.get(model);
  if (!rate || !tokens || tokens.cacheWriteUnknown > 0 ||
    (tokens.cacheWrite5m > 0 && rate.cacheWrite5m === undefined) ||
    (tokens.cacheWrite1h > 0 && rate.cacheWrite1h === undefined)) return null;

  return (
    tokens.input * rate.input +
    tokens.cachedInput * rate.cachedInput +
    tokens.output * rate.output +
    tokens.cacheWrite5m * (rate.cacheWrite5m ?? 0) +
    tokens.cacheWrite1h * (rate.cacheWrite1h ?? 0)
  ) / 1_000_000;
}

export function priceSession<T extends { source: SessionSource; analytics: SessionAnalytics | null }>(
  { source, analytics, ...session }: T,
): Omit<T, "source" | "analytics"> & Pick<SessionSummary, "source" | "analytics"> {
  return {
    ...session,
    source,
    analytics: analytics && {
      repository: analytics.repository,
      tokenCoverage: analytics.tokenCoverage,
      models: analytics.models.map((usage) => ({ ...usage, estimatedCostUsd: estimateCost(source, usage) })),
    },
  };
}
