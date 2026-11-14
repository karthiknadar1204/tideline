import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary, WorkspaceUsageTargets } from "@tideline/contracts";
import { calculateUsageTargets } from "../lib/usage-target-progress";

const now = new Date("2026-11-14T12:00:00Z");
const targets: WorkspaceUsageTargets = {
  monthlyBudgetCents: 100,
  goal: { scope: "claude-code", period: "week", direction: "at-least", metric: "tokens", target: 80 },
};

function session(source: SessionSummary["source"], startedAt: string, tokens: number, cost: number | null): SessionSummary {
  return {
    id: crypto.randomUUID(), title: "Fixture", messageCount: 1, source, startedAt, activityCounts: null,
    analytics: {
      tokenCoverage: "reported", repository: null,
      models: [{
        model: "fixture-model", estimatedCostUsd: cost,
        tokens: { input: tokens, output: 0, cachedInput: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 },
      }],
    },
  };
}

test("budget and goal use UTC periods, include both agents and filter the goal by agent", () => {
  const sessions = [
    session("codex", "2026-10-31T23:59:59.999Z", 100, 10),
    session("codex", "2026-11-01T00:00:00Z", 100, 0.5),
    session("claude-code", "2026-11-08T23:59:59Z", 100, 0.1),
    session("claude-code", "2026-11-09T00:00:00Z", 80, 0.2),
    session("codex", "2026-11-13T09:00:00Z", 100, 0.2),
    session("claude-code", "2026-11-14T12:00:01Z", 100, 10),
    session("claude-code", "2026-11-16T00:00:00Z", 100, 0),
    session("codex", "2026-12-01T00:00:00Z", 100, 10),
  ];
  const result = calculateUsageTargets(sessions, targets, now);
  assert.equal(result.budget?.value, 1);
  assert.equal(result.budget?.status, "reached");
  assert.equal(result.goal?.value, 80);
  assert.equal(result.goal?.status, "met");
  assert.equal(result.goal?.start.toISOString(), "2026-11-09T00:00:00.000Z");
  assert.equal(result.goal?.end.toISOString(), "2026-11-16T00:00:00.000Z");
});

test("missing usage stays unknown and a known subtotal can still establish an outcome", () => {
  const unpriced = session("claude-code", "2026-11-10T00:00:00Z", 80, null);
  const old = { ...unpriced, id: crypto.randomUUID(), analytics: null };
  const baseline = calculateUsageTargets([unpriced, old], targets, now);
  assert.equal(baseline.budget?.value, null);
  assert.equal(baseline.budget?.status, "unavailable");
  assert.equal(baseline.goal?.status, "met");
  assert.equal(baseline.goal?.complete, false);

  const priced = session("codex", "2026-11-10T00:00:00Z", 0, 0.8);
  assert.equal(calculateUsageTargets([priced, old], targets, now).budget?.status, "partial");
  assert.equal(calculateUsageTargets([priced], targets, now).budget?.status, "near");
  assert.equal(calculateUsageTargets([{ ...priced, analytics: session("codex", priced.startedAt, 0, 1.01).analytics }, old], targets, now).budget?.status, "over");
  assert.deepEqual(calculateUsageTargets([], targets, now).budget?.value, 0);
});

test("fractional cents at exactly eighty percent trigger the budget warning", () => {
  const usage = session("codex", "2026-11-10T00:00:00Z", 100, 0.024);
  const budgetOnly = { monthlyBudgetCents: 3, goal: null };
  assert.equal(calculateUsageTargets([usage], budgetOnly, now).budget?.status, "near");
});

test("a spend ceiling counts the selected agent and keeps an uncertain outcome partial", () => {
  const spendTargets: WorkspaceUsageTargets = {
    monthlyBudgetCents: null,
    goal: { scope: "codex", period: "month", direction: "at-most", metric: "cost", target: 3 },
  };
  const codex = session("codex", "2026-11-10T00:00:00Z", 100, 0.03);
  const claude = session("claude-code", codex.startedAt, 100, 10);
  const missing = { ...codex, id: crypto.randomUUID(), analytics: null };
  const above = session("codex", codex.startedAt, 20, 0.000001);

  assert.equal(calculateUsageTargets([codex, claude], spendTargets, now).goal?.status, "within");
  assert.equal(calculateUsageTargets([codex, missing], spendTargets, now).goal?.status, "partial");
  assert.equal(calculateUsageTargets([codex, above, missing], spendTargets, now).goal?.status, "exceeded");
});
