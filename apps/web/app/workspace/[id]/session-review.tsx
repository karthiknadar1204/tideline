import type { SessionDetail } from "@tideline/contracts";

type Review = NonNullable<SessionDetail["review"]>;

const findingLabels: Record<Review["findings"][number]["rule"], { title: string; description: string }> = {
  "possible-credential": {
    title: "Possible credential",
    description: "The log contains a pattern that can indicate a credential.",
  },
  "force-push": {
    title: "Force push",
    description: "This command can overwrite remote Git history.",
  },
  "hard-reset": {
    title: "Hard reset",
    description: "This command can discard tracked work in the checkout.",
  },
  "git-clean": {
    title: "Forced Git cleanup",
    description: "This command can remove untracked files.",
  },
  "recursive-delete": {
    title: "Recursive forced deletion",
    description: "This command can remove a directory and its contents without prompting.",
  },
  "remote-shell": {
    title: "Downloaded script piped to a shell",
    description: "This command sends downloaded content directly to a shell.",
  },
};

export function SessionReview({ review }: { review: SessionDetail["review"] }) {
  return (
    <div className="mt-10 space-y-8">
      {review?.truncated && (
        <p className="text-sm opacity-75">Tideline reached the review limit for this session. Some entries may be missing.</p>
      )}
      <section className="space-y-3" aria-labelledby="session-commits">
        <h2 id="session-commits" className="text-xl font-semibold">Git commits</h2>
        {review?.commits.length ? (
          <ul className="divide-y divide-current/15 rounded-lg border border-current/15">
            {review.commits.map(({ sha, url, line }) => (
              <li key={sha} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
                {url ? (
                  <a
                    href={url}
                    rel="noreferrer"
                    aria-label={`Open commit ${sha}`}
                    title={sha}
                    className="font-mono underline underline-offset-4"
                  >
                    {sha.slice(0, 12)}
                  </a>
                ) : (
                  <code className="min-w-0 break-all">{sha}</code>
                )}
                <span className="shrink-0 opacity-75">Log line {line}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm opacity-75">{review ? "No commits verified for this session." : "Commit information is unavailable for this session."}</p>
        )}
      </section>
      <section className="space-y-3" aria-labelledby="session-safety">
        <h2 id="session-safety" className="text-xl font-semibold">Safety findings</h2>
        {review && <p className="text-sm opacity-75">Tideline checks for specific patterns in the session log. Findings are advisory.</p>}
        {review?.findings.length ? (
          <ul className="divide-y divide-current/15 rounded-lg border border-current/15">
            {review.findings.map(({ rule, line }) => {
              const { title, description } = findingLabels[rule];
              return (
                <li key={`${rule}:${line}`} className="flex flex-wrap justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <div className="space-y-1">
                    <p className="font-medium">{title}</p>
                    <p className="opacity-75">{description}</p>
                  </div>
                  <span className="shrink-0 opacity-75">Log line {line}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm opacity-75">{review ? "No safety findings in the scanned records." : "Safety analysis is unavailable for this session."}</p>
        )}
      </section>
    </div>
  );
}
