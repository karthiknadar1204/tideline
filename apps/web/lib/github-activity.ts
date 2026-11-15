import { githubActivityResponse, type GitHubActivityQuery } from "@tideline/contracts";
import type { readReportFilters } from "./reports";
import { fetchWorkspaceResource } from "./workspace";

export async function readGitHubActivity(workspaceId: string, filters: ReturnType<typeof readReportFilters>, kind?: GitHubActivityQuery["kind"]) {
  const query = new URLSearchParams({ to: filters.through });
  if (filters.repository) query.set("repository", filters.repository);
  if (kind) query.set("kind", kind);
  if (filters.days !== "all") {
    const first = new Date(filters.through);
    first.setUTCDate(first.getUTCDate() + 1 - filters.days);
    query.set("from", first.toISOString().slice(0, 10));
  }
  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/github-activity?${query}`);
  if (!response?.ok) throw new Error("Could not load GitHub activity.");
  return githubActivityResponse.parse(await response.json());
}
