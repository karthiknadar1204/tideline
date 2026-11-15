import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { saveReportRequest } from "@tideline/contracts";
import type { SessionDetail } from "@tideline/contracts";

const cliBundle = process.env.TIDELINE_TEST_CLI_BUNDLE;
const entry = cliBundle ? resolve(cliBundle) : fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("MCP reads one workspace and saves a private report over stdio", {
  skip: process.platform === "win32" || (!process.versions.bun && !cliBundle),
  timeout: 30_000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-mcp-")));
  const syncHome = join(root, "cli");
  await mkdir(syncHome, { mode: 0o700 });
  const workspace = { id: randomUUID(), name: "Private fixture workspace" };
  const workspacePath = `/v1/cli/workspaces/${workspace.id}`;
  const reportId = randomUUID();
  const token = `tdcli_${"0".repeat(64)}`;
  const startedAt = "2026-11-14T12:00:00.000Z";
  const longText = "X🔍".repeat(6_200);
  const session = {
    id: randomUUID(), sourceSessionId: randomUUID(), title: "Investigate race", source: "codex", startedAt, messageCount: 2,
    activityCounts: null, analytics: null, activity: null, review: null,
    messages: [
      { role: "user", line: 4, text: "Investigate race", timestamp: startedAt },
      { role: "assistant", line: 8, text: longText, timestamp: startedAt },
    ],
  } satisfies SessionDetail;
  const { activity, review, sourceSessionId, messages, ...summary } = session;
  const written: unknown[] = [];
  const searches: URLSearchParams[] = [];
  let revoked = false;
  const coverage = { collectors: 1, reportedAt: startedAt, partial: false, known: 2, ready: 1, pending: 0 };
  const api = createServer(async (request, response) => {
    if (revoked || request.headers.authorization !== `Bearer ${token}`) return void response.writeHead(401).end();
    const url = new URL(request.url ?? "", "http://local");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === `${workspacePath}/session-search`) {
      searches.push(url.searchParams);
      return void response.end(JSON.stringify({ sessions: [summary], page: 2, total: 27, repositories: [], models: [] }));
    }
    if (url.pathname === `${workspacePath}/sessions/${session.id}`) return void response.end(JSON.stringify(session));
    if (url.pathname === `${workspacePath}/sync-coverage`) return void response.end(JSON.stringify(coverage));
    if (url.pathname === `${workspacePath}/saved-reports` && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      const input = saveReportRequest.parse(body);
      written.push(body);
      response.writeHead(201).end(JSON.stringify({
        id: reportId, title: input.title, visibility: input.visibility, sessionIds: input.sessionIds, createdAt: startedAt, isAuthor: true,
      }));
      return;
    }
    response.writeHead(404).end();
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const connectTransport = () => new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp", "--workspace", workspace.id],
    cwd: root,
    env: { TIDELINE_API_URL: origin, TIDELINE_SYNC_HOME: syncHome, TIDELINE_WEB_URL: "https://dashboard.example.test", NODE_NO_WARNINGS: "1" },
  });
  const client = new Client({ name: "tideline-test", version: "1.0.0" }, { supportedProtocolVersions: ["2025-11-25"] });
  const modernClient = new Client({ name: "tideline-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const protocolErrors: Error[] = [];
  client.onerror = (error) => protocolErrors.push(error);

  try {
    const database = join(syncHome, "cli-account.sqlite");
    await writeFile(database, "", { mode: 0o600 });
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO account VALUES (1, ?)").run(JSON.stringify({
      apiOrigin: origin, token, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      account: { userId: "user_fixture", workspace }, selectedWorkspaceId: randomUUID(),
    }));
    db.close();

    await client.connect(connectTransport());
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), ["get_session", "save_report", "search_sessions", "sync_coverage"]);
    assert.ok(tools.find(({ name }) => name === "search_sessions")?.inputSchema.properties?.query);
    assert.equal(tools.find(({ name }) => name === "save_report")?.annotations?.readOnlyHint, false);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, { timeout: 5_000 });
    const rejected = await call("search_sessions", { workspaceId: randomUUID() });
    assert.equal(rejected.isError, true);
    assert.equal(searches.length, 0);

    const search = await call("search_sessions", { query: "slow & broken", source: "codex", page: 2 });
    assert.equal(search.isError, undefined);
    assert.deepEqual(search.structuredContent?.sessions, [summary]);
    assert.equal(search.structuredContent?.total, 27);
    assert.deepEqual(Object.fromEntries(searches[0]), { query: "slow & broken", source: "codex", page: "2" });
    assert.deepEqual((await call("sync_coverage", {})).structuredContent, coverage);

    const first = await call("get_session", { sessionId: session.id, textOffset: 32_000 });
    assert.equal(first.isError, undefined);
    const firstIndex = first.structuredContent?.next;
    assert.deepEqual(firstIndex, { offset: 1, textOffset: 12_000 });
    assert.deepEqual(first.structuredContent?.messages, [{ ...messages[1], text: "X🔍".repeat(6_000), offset: 1, textOffset: 0 }]);
    const second = await call("get_session", { sessionId: session.id, offset: 1, textOffset: 12_000 });
    assert.deepEqual(second.structuredContent?.messages, [{ ...messages[1], text: "X🔍".repeat(200), offset: 1, textOffset: 12_000 }]);
    assert.equal(second.structuredContent?.next, null);

    const saved = await call("save_report", { title: "Finding", markdown: "The test is missing a lock.", sessionIds: [session.id] });
    assert.equal(saved.isError, undefined);
    assert.deepEqual(written, [{ title: "Finding", markdown: "The test is missing a lock.", visibility: "private", sessionIds: [session.id] }]);
    assert.equal(saved.structuredContent?.url, `https://dashboard.example.test/workspace/${workspace.id}/reports/saved/${reportId}`);

    await modernClient.connect(connectTransport());
    const modern = await modernClient.callTool({ name: "search_sessions", arguments: {} }, { timeout: 5_000 });
    assert.equal(modern.isError, undefined);
    assert.deepEqual(modern.structuredContent?.sessions, [summary]);

    revoked = true;
    const denied = await call("get_session", { sessionId: session.id });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /tideline login/);
    assert.doesNotMatch(JSON.stringify(denied.content), /tdcli_/);
    assert.deepEqual(protocolErrors, []);
  } finally {
    await Promise.all([client.close(), modernClient.close()]);
    await new Promise<void>((done) => api.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
