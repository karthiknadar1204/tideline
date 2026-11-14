import { commitLink, MAX_SESSION_COMMITS } from "@tideline/contracts";
import type { SessionReview } from "@tideline/contracts";
import { createRepositoryGit, readOrigin } from "./repository";

const objectPrefix = /^[0-9a-f]{4,64}$/u;
const fullObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export async function findSessionCommits(
  directory: string,
  candidates: ReadonlyArray<{ hash: string; line: number }>,
): Promise<SessionReview["commits"]> {
  const evidence = new Map<string, number>();
  for (const { hash, line } of candidates) {
    const prefix = hash.toLowerCase();
    if (objectPrefix.test(prefix) && Number.isSafeInteger(line) && line > 0 && !evidence.has(prefix)) {
      evidence.set(prefix, line);
    }
    if (evidence.size === MAX_SESSION_COMMITS) break;
  }
  if (!evidence.size) return [];

  const git = createRepositoryGit(directory);
  const [remote, objects] = await Promise.all([
    readOrigin(git),
    git("rev-parse", ...Array.from(evidence.keys(), (prefix) => `--disambiguate=${prefix}`)),
  ]);
  const objectIds = [...new Set(objects?.split("\n").filter((hash) => fullObjectId.test(hash)))];
  const seen = new Set<string>();
  const commits: SessionReview["commits"] = [];

  for (const [prefix, line] of evidence) {
    const matches = objectIds.filter((sha) => sha.startsWith(prefix));
    if (matches.length !== 1) continue;
    const [sha] = matches;
    if (seen.has(sha) || await git("cat-file", "-t", sha) !== "commit") continue;
    seen.add(sha);

    let url = null;
    if (remote?.host === "github.com") url = `https://github.com/${remote.path}/commit/${sha}`;
    if (remote?.host === "gitlab.com") url = `https://gitlab.com/${remote.path}/-/commit/${sha}`;
    const link = commitLink.safeParse({ sha, line, url });
    commits.push(link.success ? link.data : { sha, line, url: null });
  }

  return commits;
}
