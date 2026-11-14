import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";
import { findSessionCommits } from "../src/commit-links";

async function createRepository() {
  const cwd = await mkdtemp(join(tmpdir(), "tideline-commit-links-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "--allow-empty", "-m", "Synthetic commit");
  return { cwd, git, sha: git("rev-parse", "HEAD") };
}

test("commit links use the full verified SHA and omit raw origin credentials", async (context) => {
  const { cwd, git, sha } = await createRepository();
  context.after(() => rm(cwd, { recursive: true, force: true }));
  git("remote", "add", "origin", "https://synthetic-user:synthetic-token@github.com/example/project.git?private=query#hash");
  assert.deepEqual(await findSessionCommits(cwd, [
    { hash: sha.slice(0, 10), line: 11 },
    { hash: sha, line: 12 },
  ]), [{ sha, line: 11, url: `https://github.com/example/project/commit/${sha}` }]);

  git("remote", "set-url", "origin", "git@gitlab.com:example/subgroup/project.git");
  assert.deepEqual(await findSessionCommits(cwd, [{ hash: sha, line: 11 }]), [
    { sha, line: 11, url: `https://gitlab.com/example/subgroup/project/-/commit/${sha}` },
  ]);
});

test("commit evidence ignores symbolic refs, trees, and malformed revisions", async (context) => {
  const { cwd, git, sha } = await createRepository();
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const branch = sha.startsWith("deadbeefcafebabe") ? "cafebabedeadbeef" : "deadbeefcafebabe";
  git("branch", branch);
  git("remote", "add", "origin", "https://github.com.example.invalid/example/project.git");
  const tree = git("rev-parse", "HEAD^{tree}");
  assert.deepEqual(await findSessionCommits(cwd, [
    { hash: branch, line: 1 },
    { hash: "HEAD", line: 2 },
    { hash: "--help", line: 3 },
    { hash: tree, line: 4 },
    { hash: sha, line: 5 },
  ]), [{ sha, line: 5, url: null }]);
});
