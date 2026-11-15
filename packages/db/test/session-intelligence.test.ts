import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sessionIntelligenceQuery, sessionIntelligenceResponse } from "@tideline/contracts/session-intelligence";
import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { agentSessions, workspaces } from "../src/schema";
import { readSessionIntelligence } from "../src/session-intelligence";

const databaseUrl = process.env.TIDELINE_INTELLIGENCE_TEST_DATABASE_URL;

test("session intelligence reports distinct affected sessions, ready evidence, and workspace scope", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  const sql = postgres(databaseUrl);
  const db = drizzle(sql);
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const userId = `fixture-${randomUUID()}`;
  const otherUser = `fixture-${randomUUID()}`;
  const repository = { key: "a".repeat(64), name: "platform" };
  const filters = sessionIntelligenceQuery.parse({ days: "7", through: "2026-11-14" });

  try {
    await db.transaction(async (fixture) => {
      await fixture.insert(workspaces).values([
        { id: workspaceId, ownerId: userId, name: "Intelligence test", kind: "team" },
        { id: otherWorkspaceId, ownerId: otherUser, name: "Other workspace", kind: "team" },
      ]);
      function session({ id = randomUUID(), day, source = "codex", failures = 0, pending = false, deleted = false,
        tenant = workspaceId, prompt = "> This still isn't working.", answer = "I reviewed the checks." }: {
        id?: string; day: string; source?: "codex" | "claude-code"; failures?: number; pending?: boolean; deleted?: boolean;
        tenant?: string; prompt?: string; answer?: string;
      }): typeof agentSessions.$inferInsert {
        const timestamp = `${day}T12:00:00.000Z`;
        const tools = Array.from({ length: failures }, (_, index) => ({
          name: "compile", mcpServer: "ci", line: 2 + index, index: 0, status: "failed" as const,
        }));
        return {
          id, workspaceId: tenant, source, sourceSessionId: randomUUID(), startedAt: timestamp, title: `Fixture conversation ${day}`,
          messages: [
            { role: "user", line: 1, text: prompt, timestamp },
            { role: "assistant", line: 4_000_000_000, text: answer, timestamp },
            { role: "user", line: 4_000_000_001, text: "You broke the pending attempt.", timestamp },
          ],
          readyMessageCount: pending ? 0 : 2,
          readyActivity: { tools, skills: [], children: [], throughLine: 4_000_000_000, truncated: false },
          readyCapture: {
            throughLine: 4_000_000_000, truncated: false, files: [], setup: {},
            tools: tools.map(({ line, index }) => ({ line, index, input: null, output: "HTTP/2 429. Private fixture output.", truncated: false })),
          },
          readyAnalytics: { throughLine: 4_000_000_000, repository, models: [], tokenCoverage: "unavailable" },
          deletedAt: deleted ? new Date(timestamp) : null,
        };
      }
      const recent = session({ day: "2026-11-13", failures: 2, prompt: "This still isn't working.", answer: "I was wrong about setup." });
      const earlier = session({ day: "2026-11-04", source: "claude-code", failures: 1 });
      await fixture.insert(agentSessions).values([
        recent, earlier,
        session({ day: "2026-11-14", failures: 3, tenant: otherWorkspaceId }),
        session({ day: "2026-11-14", failures: 3, deleted: true }),
        session({ day: "2026-11-14", failures: 3, pending: true }),
      ]);
      const result = sessionIntelligenceResponse.parse(await readSessionIntelligence(fixture, { workspaceId, userId }, filters));
      assert.equal(result.current.sessions, 1);
      assert.equal(result.prior.sessions, 1);
      assert.deepEqual(result.repositories, [repository]);
      const failure = result.patterns.find(({ label }) => label === "ci / compile");
      assert.ok(failure);
      assert.deepEqual([failure.currentSessions, failure.priorSessions, failure.currentEvents, failure.priorEvents], [1, 1, 2, 1]);
      assert.deepEqual(failure.examples.map(({ id, anchor }) => ({ id, anchor })), [
        { id: recent.id, anchor: "tool-2-0" }, { id: earlier.id, anchor: "tool-2-0" },
      ]);
      assert.equal(result.patterns.find(({ label }) => label === "Rate limit")?.currentEvents, 2);
      assert.equal(result.patterns.find(({ kind }) => kind === "reported-frustration")?.priorEvents, 0);
      assert.equal(result.patterns.find(({ kind }) => kind === "reported-frustration")?.currentEvents, 1);
      assert.equal(result.patterns.find(({ kind }) => kind === "agent-correction")?.examples[0].anchor, "message-4000000000");
      assert.doesNotMatch(JSON.stringify(result), /Private fixture output/u);
      assert.equal(await readSessionIntelligence(fixture, { workspaceId, userId: otherUser }, filters), undefined);
      const selected = sessionIntelligenceResponse.parse(await readSessionIntelligence(fixture, { workspaceId, userId }, {
        ...filters, source: "claude-code", repository: repository.key,
      }));
      assert.equal(selected.current.sessions, 0);
      fixture.rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
  } finally {
    await sql.end();
  }
});
