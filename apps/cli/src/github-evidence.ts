import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { githubCommitEvidence, githubEvidenceTargets, githubSha } from "@tideline/contracts/github-evidence";
import type { GitHubCommitEvidence } from "@tideline/contracts/github-evidence";
import { z } from "zod";
import { redactConversationText } from "./session-safety";

const execute = promisify(execFile);
const details = { id: z.int().positive(), name: z.string(), status: z.string(), conclusion: z.string().nullable() };
const pullsResponse = z.array(z.object({
  number: z.int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  merged_at: z.iso.datetime().nullable().optional(),
  head: z.object({ sha: githubSha }).optional(),
  merge_commit_sha: githubSha.nullable().optional(),
}));
const runsResponse = z.object({
  total_count: z.int().nonnegative(),
  workflow_runs: z.array(z.object({
    ...details, name: z.string().nullable(), head_sha: githubSha, run_attempt: z.int().positive(),
    pull_requests: z.array(z.object({
      number: z.int().positive(),
      base: z.object({ repo: z.object({ url: z.string().optional() }).nullish() }).nullish(),
    })).nullish(),
  })),
});
const jobsResponse = z.object({
  total_count: z.int().nonnegative(),
  jobs: z.array(z.object(details)),
});

async function getGitHub<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
  try {
    const { stdout } = await execute("gh", ["api", "--hostname", "github.com", path], {
      env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeout: 8_000, signal, maxBuffer: 1_048_576,
    });
    return schema.safeParse(JSON.parse(stdout)).data;
  } catch {
    return undefined;
  }
}

function label(value: string, fallback: string) {
  return Array.from(redactConversationText(value).replace(/[\p{Cc}\p{Cf}\uD800-\uDFFF]/gu, " ").trim()).slice(0, 120).join("") || fallback;
}

function result({ conclusion, status }: { conclusion: string | null; status: string }) {
  return /^[a-z][a-z_]{0,31}$/u.test(conclusion || status) ? conclusion || status : "unknown";
}

async function readCommit(repository: string, sha: string, signal?: AbortSignal): Promise<GitHubCommitEvidence> {
  const path = `repos/${repository}`;
  const runsFor = (head: string) => getGitHub(`${path}/actions/runs?head_sha=${head}&per_page=12`, runsResponse, signal);
  const [pulls, direct] = await Promise.all([
    getGitHub(`${path}/commits/${sha}/pulls?per_page=20`, pullsResponse, signal),
    runsFor(sha),
  ]);

  const alternate = [...new Set((pulls ?? []).flatMap((pull) => [pull.head?.sha, pull.merge_commit_sha])
    .filter((head): head is string => Boolean(head && head !== sha)))];
  const related = await Promise.all(alternate.slice(0, 3).map(runsFor));
  const numbers = new Set(pulls?.map(({ number }) => number));
  const allowedPull = (run: z.infer<typeof runsResponse>["workflow_runs"][number]) => run.pull_requests?.some(({ number, base }) =>
    numbers.has(number) && base?.repo?.url?.toLowerCase() === `https://api.github.com/repos/${repository}`);
  const seen = new Set<number>();
  const runs = [...(direct?.workflow_runs.filter((run) => run.head_sha === sha) ?? []),
    ...related.flatMap((response) => response?.workflow_runs.filter(allowedPull) ?? [])]
    .filter(({ id }) => !seen.has(id) && Boolean(seen.add(id)));
  async function readWorkflow(run: (typeof runs)[number]): Promise<NonNullable<GitHubCommitEvidence["workflows"]>[number]> {
    const jobs = await getGitHub(`${path}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=40`, jobsResponse, signal);
    return {
      id: String(run.id), attempt: run.run_attempt, name: label(run.name ?? "", `Workflow run ${run.id}`),
      status: result(run), match: run.head_sha === sha ? "commit" : "pull-request",
      ...(jobs && { jobs: jobs.jobs.slice(0, 40).map((job) => ({
        id: String(job.id), name: label(job.name, `Job ${job.id}`), status: result(job),
      })), jobsPartial: jobs.total_count > jobs.jobs.length }),
    };
  }

  const workflows: NonNullable<GitHubCommitEvidence["workflows"]> = [];
  const selectedRuns = runs.slice(0, 12);
  for (let index = 0; index < selectedRuns.length && !signal?.aborted; index += 4) {
    workflows.push(...await Promise.all(selectedRuns.slice(index, index + 4).map(readWorkflow)));
  }
  return githubCommitEvidence.parse({
    sha,
    ...(pulls && { pulls: pulls.slice(0, 20).map((pull) => ({
      number: pull.number, title: label(pull.title, `Pull request #${pull.number}`), state: pull.merged_at ? "merged" : pull.state,
    })) }),
    ...((direct || workflows.length) && { workflows }),
    partial: !pulls || pulls.length === 20 || !direct || direct.total_count > direct.workflow_runs.length ||
      alternate.length > 3 || related.some((entry) => !entry || entry.total_count > entry.workflow_runs.length) ||
      runs.length > workflows.length || workflows.some((workflow) => !workflow.jobs || workflow.jobsPartial),
  });
}

type EvidenceRequest = { action: "targets"; repository: string } | {
  action: "upload"; evidence: { repository: string; commits: GitHubCommitEvidence[] };
};

export async function syncGitHubEvidence(
  repository: string,
  request: (request: EvidenceRequest) => Promise<unknown>,
  signal?: AbortSignal,
) {
  const normalized = repository.toLowerCase();
  const targets = githubEvidenceTargets.parse(await request({ action: "targets", repository: normalized }));
  let received = 0;
  for (const sha of targets) {
    if (signal?.aborted) break;
    const evidence = await readCommit(normalized, sha, signal);
    if (signal?.aborted) break;
    const receipt = z.object({ received: z.int().nonnegative() }).parse(await request({
      action: "upload", evidence: { repository: normalized, commits: [evidence] },
    }));
    received += receipt.received;
  }
  return received;
}
