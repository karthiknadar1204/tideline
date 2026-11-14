import type { SessionDetail, SessionSummary } from "@tideline/contracts";
import { formatCount } from "../../../lib/usage";

type Activity = NonNullable<SessionDetail["activity"]>;
type ActivityItem = Activity["tools"][number] | Activity["skills"][number] | Activity["children"][number];

const categories = [
  { key: "tools", label: "Tool calls", empty: "No tool calls recorded." },
  { key: "skills", label: "Skills", empty: "No skills recorded." },
  { key: "children", label: "Child agent runs", empty: "No child agent runs recorded." },
] as const;

const statusLabels: Record<ActivityItem["status"], string> = {
  called: "Called",
  returned: "Returned",
  failed: "Failed",
  requested: "Requested",
  invoked: "Invoked",
  started: "Started",
  running: "Running",
  completed: "Completed",
  stopped: "Stopped",
  unknown: "Unknown",
};

export function WorkspaceActivity({ sessions }: { sessions: SessionSummary[] }) {
  const collected = sessions.flatMap(({ activityCounts }) => activityCounts ? [activityCounts] : []);
  const truncated = collected.some((activity) => activity.truncated);

  return (
    <section className="mt-10 space-y-4" aria-labelledby="workspace-activity">
      <h2 id="workspace-activity" className="text-xl font-semibold">Session activity</h2>
      {collected.length ? (
        <>
          <dl className="grid gap-3 sm:grid-cols-3">
            {categories.map(({ key, label }) => (
              <div key={key} className="space-y-2 rounded-lg border border-current/15 p-4">
                <dt className="text-sm opacity-75">{label}</dt>
                <dd className="text-2xl font-semibold tabular-nums">
                  {formatCount(collected.reduce((total, activity) => total + activity[key], 0))}
                </dd>
              </div>
            ))}
          </dl>
          {collected.length < sessions.length && (
            <p className="text-sm opacity-75">
              Activity is available for {formatCount(collected.length)} of {formatCount(sessions.length)} sessions.
            </p>
          )}
          {truncated && <p className="text-sm opacity-75">Totals show the activity collected within the session limits.</p>}
        </>
      ) : (
        <p className="text-sm opacity-75">Activity appears after sessions sync with an updated Tideline CLI.</p>
      )}
    </section>
  );
}

export function SessionActivity({ activity }: { activity: SessionDetail["activity"] }) {
  return (
    <section className="mt-10 space-y-4" aria-labelledby="session-activity">
      <h2 id="session-activity" className="text-xl font-semibold">Session activity</h2>
      {activity ? (
        <>
          {activity.truncated && <p className="text-sm opacity-75">Tideline reached the activity limit for this session.</p>}
          <div className="space-y-5">
            {categories.map(({ key, label, empty }) => (
              <section key={key} className="space-y-2" aria-labelledby={`session-activity-${key}`}>
                <h3 id={`session-activity-${key}`} className="font-semibold">{label}</h3>
                {activity[key].length ? (
                  <ul className="divide-y divide-current/15 rounded-lg border border-current/15">
                    {activity[key].map((item) => (
                      <li key={`${item.line}:${item.index}`} className="flex items-start justify-between gap-4 px-4 py-2.5 text-sm">
                        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{item.name ?? "Unnamed child agent"}</span>
                        <span className="shrink-0 text-right opacity-75">{statusLabels[item.status]}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm opacity-75">{empty}</p>
                )}
              </section>
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm opacity-75">Activity is unavailable for this session.</p>
      )}
    </section>
  );
}
