import { z } from "zod";
import { githubActivityUpload } from "./index";

export const githubRepository = githubActivityUpload.shape.repository.transform((value) => value.toLowerCase());
export const githubSha = z.string().regex(/^[0-9a-f]{40}$/u);
const id = z.union([z.string().regex(/^[1-9]\d{0,19}$/u), z.int().positive()]).transform(String);
const name = z.string().min(1).max(240);
const status = z.string().regex(/^[a-z][a-z_]{0,31}$/u);

export const githubEvidencePull = z.strictObject({
  number: id,
  title: name,
  state: z.enum(["open", "closed", "merged"]),
});
export const githubEvidenceJob = z.strictObject({
  id,
  name,
  status,
});
export const githubEvidenceWorkflow = z.strictObject({
  id,
  attempt: z.int().positive(),
  name,
  status,
  match: z.enum(["commit", "pull-request"]),
  jobs: z.array(githubEvidenceJob).max(40).optional(),
  jobsPartial: z.boolean().optional(),
});
export const githubCommitEvidence = z.strictObject({
  sha: githubSha,
  pulls: z.array(githubEvidencePull).max(20).optional(),
  workflows: z.array(githubEvidenceWorkflow).max(12).optional(),
  partial: z.boolean(),
});
export const githubEvidenceTargets = z.array(githubSha).max(6);
export const githubEvidenceUpload = z.strictObject({
  repository: githubRepository,
  commits: z.array(githubCommitEvidence).max(6),
}).refine(({ commits }) => new Set(commits.map(({ sha }) => sha)).size === commits.length);
export const githubEvidenceAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("targets"), repository: githubRepository }),
  z.strictObject({ action: z.literal("upload"), evidence: githubEvidenceUpload }),
]);
export const sessionGitHubEvidence = z.array(githubCommitEvidence.extend({ repository: githubRepository })).max(30);

export function githubCommitRepository({ url, sha }: { url: string | null; sha: string }) {
  if (!url || !githubSha.safeParse(sha).success) return undefined;
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/commit\/([0-9a-f]{40})$/u.exec(url);
  return match?.[2] === sha ? githubRepository.safeParse(match[1]).data : undefined;
}

export type GitHubCommitEvidence = z.infer<typeof githubCommitEvidence>;
export type SessionGitHubEvidence = z.infer<typeof sessionGitHubEvidence>;
