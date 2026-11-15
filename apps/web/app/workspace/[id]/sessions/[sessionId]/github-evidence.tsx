import { githubCommitRepository, sessionGitHubEvidence } from "@tideline/contracts/github-evidence";
import type { SessionGitHubEvidence } from "@tideline/contracts/github-evidence";
import type { SessionDetail } from "@tideline/contracts";
import { fetchWorkspaceResource } from "../../../../../lib/workspace";

const external = "underline underline-offset-4 hover:no-underline focus-visible:outline-2";
const label = (state: string) => state.replaceAll("_", " ");

export async function SessionGitHubEvidence({ workspaceId, sessionId, review }: {
  workspaceId: string;
  sessionId: string;
  review: SessionDetail["review"];
}) {
  const commits = review?.commits.flatMap((commit) => {
    const repository = githubCommitRepository(commit);
    return repository ? [{ ...commit, repository }] : [];
  }) ?? [];
  if (!commits.length) return null;

  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/github-evidence`);
  const evidence = sessionGitHubEvidence.safeParse(response?.ok ? await response.json() : null);
  const byCommit = new Map(evidence.data?.map((value) => [`${value.repository}/${value.sha}`, value]));
  return (
    <section className="space-y-3" aria-labelledby="session-github-evidence">
      <h2 id="session-github-evidence" className="text-xl font-semibold">Pull requests and CI</h2>
      {commits.map(({ repository, sha, line }) => {
        const linked = byCommit.get(`${repository}/${sha}`);
        const origin = `https://github.com/${repository}`;
        return (
          <div key={`${repository}/${sha}`} className="space-y-4 rounded-lg border border-current/15 p-4 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <a href={`${origin}/commit/${sha}`} rel="noreferrer" className={external}>
                {repository} <code>{sha.slice(0, 12)}</code>
              </a>
              <span className="text-xs opacity-75">Log line {line}</span>
            </div>
            {linked ? <Relationships origin={origin} evidence={linked} /> : (
              <p className="opacity-75">Sync GitHub activity for this repository to look up pull requests and CI jobs for the commit.</p>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Relationships({ origin, evidence }: { origin: string; evidence: SessionGitHubEvidence[number] }) {
  return (
    <div className="space-y-4">
      {evidence.partial && <p className="opacity-75">GitHub evidence is incomplete. Another sync can fill in missing results.</p>}
      <div className="space-y-2">
        <h3 className="font-semibold">Pull requests</h3>
        {evidence.pulls?.length ? (
          <ul className="space-y-2">
            {evidence.pulls.map((pr) => (
              <li key={pr.number} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                <a href={`${origin}/pull/${pr.number}`} rel="noreferrer" className={external}>#{pr.number} {pr.title}</a>
                <span className="opacity-75">{label(pr.state)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="opacity-75">{evidence.pulls ? "GitHub returned no pull requests for this commit." : "Pull request data is unavailable."}</p>}
      </div>
      <div className="space-y-2">
        <h3 className="font-semibold">CI workflow runs</h3>
        {evidence.workflows?.length ? (
          <ul className="space-y-3">
            {evidence.workflows.map((workflow) => (
              <li key={workflow.id} className="space-y-2 border-t border-current/15 pt-2">
                <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                  <a href={`${origin}/actions/runs/${workflow.id}/attempts/${workflow.attempt}`} rel="noreferrer" className={external}>{workflow.name}</a>
                  <span className="opacity-75">{label(workflow.status)} · {workflow.match === "commit" ? "Commit" : "Pull request"}</span>
                </div>
                {workflow.jobs?.length ? (
                  <ul className="space-y-1 pl-3">
                    {workflow.jobs.map((job) => (
                      <li key={job.id} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                        <a href={`${origin}/actions/runs/${workflow.id}/job/${job.id}`} rel="noreferrer" className={external}>{job.name}</a>
                        <span className="opacity-75">{label(job.status)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="pl-3 opacity-75">{workflow.jobs ? "GitHub returned no jobs for this attempt." : "Job details are unavailable."}</p>}
                {workflow.jobsPartial && <p className="pl-3 opacity-75">Showing the first {workflow.jobs?.length} jobs.</p>}
              </li>
            ))}
          </ul>
        ) : <p className="opacity-75">{evidence.workflows ? "GitHub returned no workflow runs for this commit." : "Workflow data is unavailable."}</p>}
      </div>
    </div>
  );
}
