import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@tideline/contracts";
import { buildWorkspaceReport, readReportFilters, reportCsv, reportFilterParams } from "../lib/reports";

const now = new Date("2026-11-14T19:30:00Z");
const repository = { key: "a".repeat(64), name: "fixture" };
const otherRepository = { key: "b".repeat(64), name: "other" };

function session(startedAt: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: crypto.randomUUID(), title: "Private session title", source: "codex", startedAt, messageCount: 2,
    activityCounts: { tools: 2, skills: 1, children: 0, truncated: false },
    analytics: {
      tokenCoverage: "reported", repository,
      models: [{
        model: "model", estimatedCostUsd: 0.125,
        tokens: { input: 100, output: 20, cachedInput: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 },
      }],
    },
    ...overrides,
  };
}

test("reports match UTC boundaries and repository/agent filters while daily CSV retains coverage", () => {
  const first = session("2026-11-08T00:00:00.000Z");
  const unpriced = session("2026-11-08T23:59:59.999Z", {
    activityCounts: null,
    analytics: { tokenCoverage: "unavailable", repository, models: [] },
  });
  const last = session("2026-11-14T23:59:59.999Z", {
    activityCounts: { tools: 0, skills: 0, children: 1, truncated: true },
  });
  const filters = readReportFilters({ days: "7", source: "codex", repository: repository.key }, now);
  const report = buildWorkspaceReport([
    session("2026-11-07T23:59:59.999Z"), first, unpriced,
    session("2026-11-08T12:00:00Z", { source: "claude-code" }),
    session("2026-11-09T12:00:00Z", { analytics: { tokenCoverage: "unavailable", repository: otherRepository, models: [] } }),
    last, session("2026-11-15T00:00:00.000Z"),
  ], filters);

  assert.equal(report.firstDay, "2026-11-08");
  assert.equal(report.timeline.length, 7);
  assert.deepEqual(report.sessions.map(({ id }) => id), [first.id, unpriced.id, last.id]);
  assert.deepEqual(report.repositories, [repository, otherRepository]);
  const csv = reportCsv(report).trim().split("\r\n");
  assert.equal(csv[1], "2026-11-08,2,130,partial,0.125,partial,1,2,1,0,false");
  assert.equal(csv[2], "2026-11-09,0,,unavailable,,unavailable,0,,,,");
  assert.equal(csv[7], "2026-11-14,1,130,complete,0.125,complete,1,0,0,1,true");
  assert.doesNotMatch(csv.join(""), /Private session title|fixture|model/);
});

test("all time keeps historical sessions and exports active months only", () => {
  const old = session("2024-07-11T01:02:03Z");
  const recent = session("2026-11-07T13:00:00Z");
  const filter = readReportFilters({ days: "all", through: "2026-11-10" }, now);
  const report = buildWorkspaceReport([recent, old, session("2026-11-11T00:00:00Z")], filter);
  assert.equal(report.firstDay, undefined);
  assert.deepEqual(report.timeline.map(({ period, sessions }) => ({ period, sessions })), [
    { period: "2024-07", sessions: 1 }, { period: "2026-11", sessions: 1 },
  ]);
  assert.match(reportCsv(report), /^month_utc,/);
});

test("report links reproduce historical periods and invalid filters use defaults", () => {
  const filters = readReportFilters({ days: "90", through: "2026-10-02", source: "cursor", repository: repository.key }, now);
  assert.deepEqual(readReportFilters(new URLSearchParams(reportFilterParams(filters)), now), filters);
  const emptyReport = buildWorkspaceReport([], filters);
  assert.equal(emptyReport.firstDay, "2026-07-05");
  assert.equal(emptyReport.timeline.length, 90);

  const params = new URLSearchParams("days=7&days=90&through=2026-02-30&source=unknown&repository=other");
  const invalid = readReportFilters(params, now);
  assert.deepEqual(invalid, readReportFilters({
    days: ["7", "90"], through: "2026-02-30", source: "unknown", repository: "other",
  }, now));
  assert.equal(invalid.days, 30);
  assert.equal(invalid.through, "2026-11-14");
  assert.equal(invalid.source, undefined);
  assert.equal(invalid.repository, undefined);
});
