import { modelId, modelTokens } from "@tideline/contracts";
import type { ModelTokens, SessionAnalytics } from "@tideline/contracts";

export function readModelId(value: unknown) {
  return modelId.safeParse(value).data ?? null;
}

export function zeroTokens(): ModelTokens {
  return { input: 0, cachedInput: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, output: 0 };
}

export function combineTokens(
  left: ModelTokens,
  right: ModelTokens,
  operation: (left: number, right: number) => number,
): ModelTokens {
  return {
    input: operation(left.input, right.input),
    cachedInput: operation(left.cachedInput, right.cachedInput),
    cacheWrite5m: operation(left.cacheWrite5m, right.cacheWrite5m),
    cacheWrite1h: operation(left.cacheWrite1h, right.cacheWrite1h),
    cacheWriteUnknown: operation(left.cacheWriteUnknown, right.cacheWriteUnknown),
    output: operation(left.output, right.output),
  };
}

export function createModelUsage() {
  const totals = new Map<string | null, ModelTokens | null>();
  let incomplete = false;

  function add(model: string | null, tokens: ModelTokens | null) {
    if (!tokens) {
      if (model !== null && !totals.has(model) && totals.size < 511) totals.set(model, null);
      return;
    }
    const bucket = totals.has(model) || totals.size < 511 ? model : null;
    const current = totals.get(bucket) ?? zeroTokens();
    const sum = modelTokens.safeParse(combineTokens(current, tokens, (a, b) => a + b));
    if (!sum.success) {
      incomplete = true;
      return;
    }
    totals.set(bucket, sum.data);
  }

  function snapshot(throughLine: number): SessionAnalytics {
    const models = [...totals].map(([model, tokens]) => ({ model, tokens }));
    const measured = models.filter(({ tokens }) => tokens !== null).length;
    return {
      throughLine,
      repository: null,
      models,
      tokenCoverage: measured === 0 ? "unavailable" : incomplete || measured < models.length ? "partial" : "reported",
    };
  }

  return { add, markIncomplete: () => { incomplete = true; }, snapshot };
}
