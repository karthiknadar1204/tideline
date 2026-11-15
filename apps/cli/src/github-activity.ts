import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { githubActivityReceipt, githubActivityUpload } from "@tideline/contracts";
import { z } from "zod";
import { syncGitHubEvidence } from "./github-evidence";
import { openCliAccount } from "./cli-account";
import { postToTideline, readJson } from "./login";
import { createRepositoryGit, readOrigin } from "./repository";
import { redactConversationText } from "./session-safety";
import { createApprovedScope } from "./sync-projects";
import type { openSyncStorage, SyncConfig } from "./sync-storage";

const execute = promisify(execFile);
const pullRequests = z.array(z.object({ number: z.int().positive(), title: z.string(), mergedAt: z.iso.datetime() })).max(100);
const workflowRuns = z.array(z.object({
  databaseId: z.int().positive(), name: z.string(), createdAt: z.iso.datetime(),
  status: z.string(), conclusion: z.string(),
})).max(100);

async function github(args: string[], repository: string, signal?: AbortSignal) {
  try {
    const { stdout } = await execute("gh", [...args, "--repo", `github.com/${repository}`, "--limit", "100"], {
      env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeout: 25_000, signal, maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("Could not read GitHub activity. Install gh, sign in with gh auth login, and check repository access.");
  }
}

function title(value: string, fallback: string) {
  return redactConversationText(value).replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 240) || fallback;
}

export async function readGitHubRepository(project: string) {
  const origin = await readOrigin(createRepositoryGit(project));
  return origin?.host === "github.com" ? githubActivityUpload.shape.repository.safeParse(origin.path).data : undefined;
}

async function readActivity(repository: string, signal?: AbortSignal) {
  const [merges, runs] = await Promise.all([
    github(["pr", "list", "--state", "merged", "--json", "number,title,mergedAt"], repository, signal),
    github(["run", "list", "--json", "databaseId,name,createdAt,status,conclusion"], repository, signal),
  ]);
  return githubActivityUpload.parse({
    repository,
    events: [
      ...pullRequests.parse(merges).map(({ number, title: text, mergedAt }) => ({
        kind: "merge", id: number, title: title(text, `Pull request #${number}`), at: mergedAt, status: "merged",
      })),
      ...workflowRuns.parse(runs).map(({ databaseId, name, createdAt, status, conclusion }) => ({
        kind: "ci", id: databaseId, title: title(name, `Workflow run ${databaseId}`), at: createdAt, status: conclusion || status,
      })),
    ],
  });
}

export async function syncGitHub({ project, workspace }: { project: string; workspace?: string }) {
  const repository = await readGitHubRepository(project);
  if (!repository) throw new Error("Choose a checkout with a github.com origin.");
  const account = await openCliAccount({ workspace });
  const upload = await readActivity(repository);
  const result = await account.post(`/v1/cli/workspaces/${account.workspaceId}/github-activity`, upload, githubActivityReceipt);
  const linked = await syncGitHubEvidence(repository, (body) =>
    account.post(`/v1/cli/workspaces/${account.workspaceId}/github-evidence`, body, z.unknown()));
  console.log(`Synced ${result.received} GitHub events and checked ${linked} commits in ${repository}.`);
}

const refreshMs = 15 * 60_000;
const retryMs = 60_000;

export function createGitHubActivitySync(config: SyncConfig, storage: Awaited<ReturnType<typeof openSyncStorage>>) {
  const selected = config.projects.filter((project) => Boolean(project.githubRepository));
  const nextAttempt = new Map<string, number>();

  return async (accessToken: string, signal: AbortSignal, scanAll = false) => {
    for (const project of selected) {
      const repository = project.githubRepository;
      const now = Date.now();
      if (signal.aborted) return;
      if (!repository || now < (nextAttempt.get(project.directory) ?? 0)) continue;
      const prior = storage.githubCollection(config.account, repository);
      if (!scanAll && prior && now - prior.checkedAt < refreshMs) continue;
      nextAttempt.set(project.directory, now + retryMs);
      const scope = createApprovedScope([project]);
      const verified = await scope.projectScope(project.directory);
      if (!verified || await readGitHubRepository(verified) !== repository || signal.aborted) continue;
      try {
        const upload = await readActivity(repository, signal);
        if (signal.aborted || await readGitHubRepository(verified) !== repository) continue;
        const body = JSON.stringify({ workspaceId: config.workspaceId, ...upload,
          events: upload.events.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)) });
        const fingerprint = createHash("sha256").update(body).digest("hex");
        if (fingerprint !== prior?.fingerprint) {
          const response = await postToTideline({ apiOrigin: config.apiOrigin, path: "/v1/cli/sync/github-activity", accessToken, body, signal });
          if (!response?.ok || !githubActivityReceipt.safeParse(await readJson(response)).success) {
            throw new Error("Upload failed.");
          }
        }
        await syncGitHubEvidence(repository, async (body) => {
          if (await readGitHubRepository(verified) !== repository || signal.aborted) throw new Error("GitHub origin changed.");
          const response = await postToTideline({
            apiOrigin: config.apiOrigin, path: `/v1/cli/sync/workspaces/${config.workspaceId}/github-evidence`,
            accessToken, body: JSON.stringify(body), signal,
          });
          if (!response?.ok) throw new Error("Could not sync GitHub commit evidence.");
          return readJson(response);
        }, signal);
        storage.markGitHubCollection(config.account, repository, fingerprint, Date.now());
      } catch {
        if (!signal.aborted) console.warn("GitHub activity could not sync. Check gh auth status or repository access and try again.");
      }
      if (!scanAll) return;
    }
  };
}
