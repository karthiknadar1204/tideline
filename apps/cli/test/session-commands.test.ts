import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SessionDetail } from "@tideline/contracts";

const exec = promisify(execFile);
const cliBundle = process.env.TIDELINE_TEST_CLI_BUNDLE;
const entry = cliBundle ? resolve(cliBundle) : fileURLToPath(new URL("../src/index.ts", import.meta.url));

function fixture(source: SessionDetail["source"], title: string, repository: string, day: string): SessionDetail {
  const startedAt = `${day}T12:00:00.000Z`;
  return {
    id: randomUUID(), source, sourceSessionId: randomUUID(), startedAt, title, messageCount: 2,
    messages: [{ role: "user", line: 2, text: title, timestamp: startedAt },
      { role: "assistant", line: 3, text: "Check finished.", timestamp: startedAt }],
    analytics: { repository: { name: repository, key: "0".repeat(64) }, tokenCoverage: "unavailable", models: [] },
    activityCounts: null, review: null, activity: null,
  };
}

test("pull, count, and SQL use scoped data and local exports remain readable without signing in", {
  skip: process.platform === "win32" || (!process.versions.bun && !cliBundle),
  timeout: 30_000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-data-")));
  const syncHome = join(root, "cli");
  await mkdir(syncHome, { mode: 0o700 });
  const workspace = { id: randomUUID(), name: "Private fixture workspace" };
  const token = `tdcli_${"0".repeat(64)}`;
  const sessions = [
    fixture("codex", "Fix the parser", "alpha", "2026-11-13"),
    fixture("claude-code", "Fix the index", "alpha", "2026-11-14"),
    fixture("cursor", "Inspect the editor", "beta", "2026-11-14"),
  ];
  const capture = {
    throughLine: 4, truncated: false,
    tools: [{ line: 4, index: 0, input: "npm test", output: "2 checks passed", truncated: false }],
    files: [{ line: 4, index: 0, path: "src/parser.ts", previousPath: null, change: "modified", diff: "-old\n+new", truncated: false }],
    setup: { branch: "fix/parser" },
  };
  const childCapture = {
    throughLine: 4, truncated: false, tools: [], files: [], setup: {},
    subagents: { source: "claude-code-sidecar", truncated: false, transcripts: [{
      line: 4, index: 0, agentId: "fixture-child", throughLine: 1, truncated: false,
      messages: [{ line: 1, role: "assistant", timestamp: "2026-11-14T12:00:00.000Z", text: "Child found an issue" }],
    }] },
  };
  sessions[0].activity = {
    truncated: false, tools: [{ line: 4, index: 0, name: "shell", status: "returned" }],
    skills: [], children: [{ line: 4, index: 0, name: "reviewer", status: "completed" }],
  };
  const reads: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "", "http://local/");
    reads.push(url);
    const route = `/v1/cli/workspaces/${workspace.id}/sessions`;
    if (request.headers.authorization !== `Bearer ${token}`) return void response.writeHead(401).end();
    if (url.pathname === `/v1/cli/workspaces/${workspace.id}/github-activity`) {
      assert.equal(url.searchParams.get("repoName")?.toLowerCase(), "alpha");
      assert.equal(url.searchParams.get("from"), "2026-11-13");
      response.setHeader("Content-Type", "application/json");
      return void response.end(JSON.stringify({ counts: { merge: 0, ci: 1 }, hasMore: false, events: [{
        repository: "team/alpha", event: { kind: "ci", id: "100", title: "Build", status: "success", at: "2026-11-14T13:00:00.000Z" },
      }] }));
    }
    if (url.pathname === route) {
      const rows = sessions.filter((session) => {
        const repo = url.searchParams.get("repo")?.toLowerCase();
        const source = url.searchParams.get("source");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const day = session.startedAt.slice(0, 10);
        return (!repo || repo === session.analytics?.repository?.name) &&
          (!source || source === session.source) && (!from || day >= from) && (!to || day <= to);
      });
      const offset = rows.findIndex((session) => session.id === url.searchParams.get("after")) + 1;
      const items = rows.slice(offset, offset + 1);
      const nextCursor = offset + 1 < rows.length ? items[0].id : null;
      const summaries = items.map(({ id, source, title, startedAt, messageCount, activityCounts, analytics }) =>
        ({ id, source, title, startedAt, messageCount, activityCounts, analytics }));
      response.setHeader("Content-Type", "application/json");
      return void response.end(JSON.stringify({ sessions: summaries, nextCursor }));
    }
    const session = sessions.find(({ id }) => url.pathname === `${route}/${id}`);
    if (!session) return void response.writeHead(404).end();
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(url.searchParams.get("details") === "1" ? {
      ...session, capture: session === sessions[0] ? capture : session === sessions[1] ? childCapture : null,
    } : session));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const cli = (...args: string[]) => exec(process.execPath, [entry, ...args], {
    env: { ...process.env, TIDELINE_API_URL: origin, TIDELINE_SYNC_HOME: syncHome },
    timeout: 10_000,
  });
  const signedOut = (...args: string[]) => exec(process.execPath, [entry, ...args], {
    env: { ...process.env, TIDELINE_API_URL: origin, TIDELINE_SYNC_HOME: join(root, "no-account") },
    timeout: 10_000,
  });

  try {
    const database = join(syncHome, "cli-account.sqlite");
    await writeFile(database, "", { mode: 0o600 });
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO account VALUES (1, ?)").run(JSON.stringify({
      apiOrigin: origin, token, expiresAt: new Date(Date.now() + 60_000).toISOString(), account: { userId: "user_fixture", workspace },
    }));
    db.close();

    const count = await cli("count", "--repo", "ALPHA");
    assert.equal(count.stdout.trim(), "2");
    assert.ok(reads.some((url) => url.searchParams.get("after") === sessions[0].id));
    assert.ok(reads.every((url) => url.pathname.endsWith("/sessions")), "Count without text only downloads summaries.");

    const destination = join(root, "pulled");
    const pulled = JSON.parse((await cli("pull", "--repo", "ALPHA", "--out", destination, "--json")).stdout);
    assert.deepEqual(pulled, { directory: destination, sessions: 2 });
    assert.equal((await stat(destination)).mode & 0o077, 0);
    const files = await readdir(join(destination, "sessions"));
    assert.deepEqual(files.sort(), sessions.slice(0, 2).map(({ id }) => `${id}.jsonl`).sort());
    const path = join(destination, "sessions", `${sessions[0].id}.jsonl`);
    assert.equal((await stat(path)).mode & 0o077, 0);
    const records = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.slice(1), sessions[0].messages);

    const aliases = join(root, "pull-alias");
    await symlink(destination, aliases);
    await assert.rejects(cli("pull", "--out", aliases), /destination already exists/);
    await assert.rejects(cli("count", "--workspace", randomUUID()), /unavailable to this account/);
    const localReads = reads.length;
    const local = await signedOut("count", "FIX", "--in", destination, "--field", "user", "--unit", "session",
      "--ignore-case", "--from", "2026-11-14", "--to", "2026-11-14", "--json");
    assert.deepEqual(JSON.parse(local.stdout), {
      count: 1, unit: "session", matchedSessions: 1, scannedSessions: 1,
      pattern: "FIX", field: "user", ignoreCase: true,
    });

    const query = await signedOut("sql",
      "WITH user_text AS (SELECT * FROM messages WHERE role='user') SELECT source, text FROM user_text JOIN sessions ON sessions.id=session_id ORDER BY source; -- done",
      "--in", destination);
    assert.deepEqual(query.stdout.trimEnd().split("\n").map((line) => JSON.parse(line)), [
      { source: "claude-code", text: "Fix the index" }, { source: "codex", text: "Fix the parser" },
    ]);
    const output = join(root, "query.csv");
    await signedOut("sql", "SELECT '=formula' AS text", "--in", destination, "--out", output);
    assert.equal(await readFile(output, "utf8"), '"text"\n"\'=formula"\n');
    assert.equal((await stat(output)).mode & 0o077, 0);
    await assert.rejects(signedOut("sql", "SELECT 4", "--in", destination, "--out", output), /output already exists/);
    assert.equal(await readFile(output, "utf8"), '"text"\n"\'=formula"\n');
    const literals = await signedOut("sql", "SELECT 1 AS total, 'pragma_query_only' AS literal, 'zeroblob' AS name", "--in", destination);
    assert.deepEqual(JSON.parse(literals.stdout), { total: 1, literal: "pragma_query_only", name: "zeroblob" });

    const forbidden = join(root, "forbidden.sqlite").replaceAll("'", "''");
    for (const sql of [
      "PRAGMA query_only=OFF",
      'SELECT * FROM "pragma_query_only"',
      `ATTACH DATABASE '${forbidden}' AS outside`,
      "SELECT 1; DROP TABLE sessions",
      "SELECT 1; -- comment\nDROP TABLE sessions",
      "WITH x AS (SELECT 1) DELETE FROM sessions RETURNING id",
      `SELECT load_extension('${forbidden}')`,
      `SELECT readfile('${forbidden}')`,
      "SELECT zeroblob(1000000000)",
    ]) {
      await assert.rejects(signedOut("sql", sql, "--in", destination), /local SQL|read-only|one SQL statement|SQLite/);
    }
    await assert.rejects(stat(join(root, "forbidden.sqlite")), { code: "ENOENT" });
    await assert.rejects(signedOut("sql", "WITH RECURSIVE forever(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM forever) SELECT max(n) FROM forever", "--in", destination), /ran out of time/);
    await assert.rejects(signedOut("sql", 'SELECT * FROM "SENSITIVE-FIXTURE-NAME"', "--in", destination), (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? "", /SQLite could not parse/);
      assert.doesNotMatch(error.stderr ?? "", /SENSITIVE-FIXTURE-NAME/);
      return true;
    });
    assert.equal(reads.length, localReads, "Local count and SQL never send a request.");
    const live = await cli("sql", "SELECT count(*) AS total FROM sessions", "--repo", "alpha", "--source", "claude-code");
    assert.deepEqual(JSON.parse(live.stdout), { total: 1 });
    const details = join(root, "details");
    await cli("pull", "--details", "--pattern", "\\d+ checks passed", "--out", details);
    const recorded = JSON.parse((await readFile(join(details, "calls.jsonl"), "utf8")).trim());
    assert.equal(recorded.output, "2 checks passed");
    assert.deepEqual(await readdir(join(details, "sessions")), [`${sessions[0].id}.jsonl`]);
    const callCount = await cli("count", "--pattern", "\\d+ checks", "--field", "tool-output", "--unit", "call");
    assert.equal(callCount.stdout.trim(), "1");
    const localFiles = await signedOut("sql", "SELECT path, diff FROM file_changes", "--in", details);
    assert.deepEqual(JSON.parse(localFiles.stdout), { path: "src/parser.ts", diff: "-old\n+new" });
    const liveSetup = await cli("sql", "SELECT value FROM session_setup WHERE key='branch'", "--details");
    assert.deepEqual(JSON.parse(liveSetup.stdout), { value: "fix/parser" });
    await cli("pull", "--source", "codex");
    const afterPull = reads.length;
    const last = await cli("count", "--pattern", "^Fix", "--unit", "prompt");
    assert.equal(last.stdout.trim(), "1");
    assert.equal(reads.length, afterPull, "Regex count uses the latest default pull without reaching the API.");
    const explicitLive = await cli("count", "--pattern", "^Fix", "--unit", "prompt", "--live");
    assert.equal(explicitLive.stdout.trim(), "2");
    const children = join(root, "children");
    await cli("pull", "--details", "--pattern", "Child found", "--out", children);
    const childMessages = await signedOut("sql", "SELECT agent_id, text FROM agent_messages", "--in", children);
    assert.deepEqual(JSON.parse(childMessages.stdout), { agent_id: "fixture-child", text: "Child found an issue" });
    const github = join(root, "github");
    await cli("pull", "--github", "--repo", "ALPHA", "--from", "2026-11-13", "--out", github);
    assert.equal((await stat(join(github, "github_activity.jsonl"))).mode & 0o077, 0);
    const githubSql = "SELECT repository, CAST(id AS INTEGER) AS id FROM github_activity";
    const expected = { repository: "team/alpha", id: 100 };
    assert.deepEqual(JSON.parse((await signedOut("sql", githubSql, "--in", github)).stdout), expected);
    assert.deepEqual(JSON.parse((await cli("sql", githubSql, "--github", "--repo", "alpha", "--from", "2026-11-13")).stdout), expected);
    assert.ok(reads.every((url) => !url.searchParams.has("query")), "The data API never receives SQL.");
  } finally {
    server.close();
    server.closeAllConnections();
    await rm(root, { recursive: true, force: true });
  }
});
