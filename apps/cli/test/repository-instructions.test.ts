import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_REPOSITORY_CONTEXT_METADATA_BYTES, repositoryInstructionUpload } from "@tideline/contracts";
import { captureRepositoryInstructions } from "../src/repository-instructions";

test("repository snapshot reads safe agent instructions from the checkout and redacts secrets", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tideline-instructions-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  const secret = "ghp_0123456789abcdefghijklmnopqrstuv";
  await Promise.all([
    mkdir(join(cwd, ".claude")),
    mkdir(join(cwd, "nested")),
    mkdir(join(cwd, "ignored")),
    mkdir(join(cwd, "node_modules")),
    writeFile(join(cwd, ".gitignore"), "ignored\n"),
    writeFile(join(cwd, "AGENTS.md"), `Run tests.\nTOKEN=${secret}\n`),
    writeFile(join(root, "private.md"), "OUTSIDE-CHECKOUT"),
  ]);
  await Promise.all([
    symlink(join(root, "private.md"), join(cwd, "CLAUDE.md")),
    writeFile(join(cwd, ".claude", "CLAUDE.md"), "Use the test runner."),
    writeFile(join(cwd, "nested", "AGENTS.override.md"), "Scope changes to this directory."),
    writeFile(join(cwd, "nested", "CLAUDE.local.md"), "x".repeat(20 * 1024)),
    writeFile(join(cwd, "ignored", "AGENTS.md"), "IGNORED-INSTRUCTIONS"),
    writeFile(join(cwd, "node_modules", "AGENTS.md"), "DEPENDENCY-INSTRUCTIONS"),
  ]);
  git("add", "AGENTS.md");
  git("-c", "user.name=Tideline", "-c", "user.email=tideline@example.test", "commit", "--quiet", "-m", "instructions");
  const snapshot = await captureRepositoryInstructions(cwd);
  assert.ok(snapshot);
  assert.equal(snapshot.revision, git("rev-parse", "HEAD"));
  assert.equal(snapshot.partial, true);
  assert.deepEqual(snapshot.documents.map(({ path }) => path), ["AGENTS.md", ".claude/CLAUDE.md", "nested/AGENTS.override.md"]);
  assert.match(snapshot.documents[0].content, /TOKEN=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(snapshot), /OUTSIDE-CHECKOUT|IGNORED-INSTRUCTIONS|DEPENDENCY-INSTRUCTIONS|ghp_/);
  assert.deepEqual(await captureRepositoryInstructions(cwd), snapshot);
});

test("expanded repository context uses a separate opt-in and never sends config or resource contents", async (context) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tideline-context-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  const files = {
    "AGENTS.md": "Standard instructions.",
    ".agents/skills/deploy/SKILL.md": "How to deploy\nTOKEN=ghp_0123456789abcdefghijklmnopqrstuv",
    ".agents/skills/deploy/references/check.sh": "PRIVATE-RESOURCE-CONTENTS",
    ".agents/skills/deploy/references/.env": "PRIVATE-CREDENTIAL-FILE",
    ".agents/skills/deploy/references/huge.txt": "x".repeat(MAX_REPOSITORY_CONTEXT_METADATA_BYTES + 1),
    ".agents/skills/unrelated/helpers.sh": "RESOURCE-WITHOUT-SKILL",
    ".claude/agents/review.md": "Review changed code.",
    ".codex/agents/check.toml": 'name = "check"\ndeveloper_instructions = "Verify the build"\n',
    ".cursor/skills/changelog/SKILL.md": "Summarize changes.",
    ".opencode/agents/verify.md": "Check the release log.",
    ".mcp.json": '{"mcpServers":{"fixture":{"env":{"token":"MCP-PRIVATE-PASSWORD"}}}}',
    ".cursor/mcp.json": '{"mcpServers":{}}',
    "opencode.jsonc": '{"mcp":{}}',
    "src/SKILL.md": "UNRECOGNIZED-SKILL-SCOPE",
    ".gitignore": ".claude/settings.local.json\n",
    ".claude/settings.local.json": "IGNORED-CONFIG",
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = join(directory, relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, text);
  }
  await symlink(join(directory, "AGENTS.md"), join(directory, ".claude/agents/linked.md"));

  const defaultScope = await captureRepositoryInstructions(directory);
  assert.deepEqual(defaultScope?.documents.map(({ path }) => path), ["AGENTS.md"]);
  assert.equal(defaultScope?.context, undefined);
  const selection = { instructions: false, contextKey: "fixture-specific-key" };
  const snapshot = await captureRepositoryInstructions(directory, selection);
  assert.ok(snapshot?.context);
  assert.deepEqual(snapshot.documents, []);
  assert.equal(snapshot.context.partial, true);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /MCP-PRIVATE-PASSWORD|PRIVATE-RESOURCE-CONTENTS|PRIVATE-CREDENTIAL-FILE|IGNORED-CONFIG|UNRECOGNIZED-SKILL-SCOPE|ghp_/);
  assert.doesNotMatch(serialized, /huge\.txt|helpers\.sh|linked\.md|settings\.local\.json/);
  const entries = snapshot.context.entries;
  const config = entries.find((entry) => entry.path === ".mcp.json");
  assert.equal(config?.kind, "config");
  assert(config?.kind === "config");
  assert.equal(config.bytes, Buffer.byteLength(files[".mcp.json"]));
  assert.match(config.fingerprint, /^[0-9a-f]{64}$/);
  const resource = entries.find((entry) => entry.kind === "resource");
  assert.equal(resource?.kind === "resource" && resource.definitionPath, ".agents/skills/deploy/SKILL.md");
  assert.deepEqual(entries.filter(({ kind }) => kind === "agent").map(({ path }) => path), [
    ".claude/agents/review.md", ".codex/agents/check.toml", ".opencode/agents/verify.md",
  ]);
  assert.deepEqual(await captureRepositoryInstructions(directory, selection), snapshot);
  assert.notDeepEqual(await captureRepositoryInstructions(directory, { ...selection, contextKey: "another-local-key" }), snapshot);

  const upload = { workspaceId: crypto.randomUUID(), repository: "a".repeat(64), snapshot, contextOnly: true };
  assert.equal(repositoryInstructionUpload.safeParse(upload).success, true);
  const tampered = { ...upload, snapshot: { ...snapshot, context: { ...snapshot.context,
    entries: [{ ...config, content: "SHOULD NOT BE ACCEPTED" }] } } };
  assert.equal(repositoryInstructionUpload.safeParse(tampered).success, false);
});
