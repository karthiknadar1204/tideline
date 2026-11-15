import assert from "node:assert/strict";
import { test } from "node:test";
import { plotScale } from "../app/trends/metrics";
import chain from "../lib/public-trends-data/chain-2026-11.json";

test("benchmark plot keeps zero on the linear axis and positions powers evenly on the logarithmic axis", () => {
  const linear = plotScale([0, 100], "linear");
  assert.equal(linear.position(0), 0);
  assert.deepEqual(linear.ticks, [0, 25, 50, 75, 100]);

  const log = plotScale([1, 10, 100], "log");
  assert.equal(log.position(1), 0);
  assert.equal(log.position(10), 50);
  assert.equal(log.position(100), 100);
});

test("a single value still gets finite, distinct benchmark chart ticks", () => {
  for (const [values, kind] of [[[0], "linear"], [[100], "log"]] as const) {
    const result = plotScale([...values], kind);
    assert.equal(new Set(result.ticks).size, 5);
    assert.ok(result.ticks.every(Number.isFinite));
    assert.ok(Number.isFinite(result.position(values[0])));
  }
});

test("published language aggregates meet minimum sample sizes and counts stay within their denominators", () => {
  assert.ok(chain.models.some((row) => row.promptsWithSwearing > 0));
  assert.ok(chain.models.some((row) => row.repliesWithApology > 0));
  for (const row of chain.models) {
    assert.ok(row.sessions >= chain.minimum.sessions);
    assert.ok(row.prompts >= chain.minimum.prompts);
    assert.ok(row.replies >= chain.minimum.replies);
    assert.ok(row.promptsWithSwearing <= row.prompts);
    assert.ok(row.repliesWithApology <= row.replies);
    assert.ok(row.visibleOutputTokens > 0);
  }
});
