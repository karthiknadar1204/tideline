import type { SessionSummary, UsageGoal, WorkspaceUsageTargets } from "@tideline/contracts";
import { formatCost, formatCount } from "../../../lib/usage";
import { calculateUsageTargets } from "../../../lib/usage-target-progress";
import { UsageBudgetForm, UsageGoalForm } from "./usage-target-forms";

type Progress = ReturnType<typeof calculateUsageTargets>;
type TargetProgress = NonNullable<Progress["budget"] | Progress["goal"]>;

const statusLabel: Record<TargetProgress["status"], string> = {
  under: "Within budget",
  near: "Near budget",
  reached: "Budget reached",
  over: "Over budget",
  met: "Goal met",
  progress: "In progress",
  exceeded: "Goal exceeded",
  within: "Within target",
  partial: "Partial usage",
  unavailable: "Usage unavailable",
};

const agentLabel: Record<UsageGoal["scope"], string> = { all: "All agents", codex: "Codex", "claude-code": "Claude Code" };
const periodDate = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const progressTrack = "block h-2 w-full appearance-none overflow-hidden rounded-full bg-current/10 [&::-webkit-progress-bar]:bg-transparent [&::-webkit-progress-value]:bg-current [&::-moz-progress-bar]:bg-current";

function ProgressSummary({ name, progress, format }: {
  name: string;
  progress: TargetProgress;
  format: (value: number) => string;
}) {
  const { status, target, value, complete, start, end } = progress;
  const percentage = value === null ? null : Math.floor((value / target) * 100);
  const lastDay = new Date(end.getTime() - 1);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-sm">
        <p className="font-medium">{statusLabel[status]}</p>
        {percentage !== null && <p className="tabular-nums">{formatCount(percentage)}%</p>}
      </div>
      <p className="break-words text-xl font-semibold tabular-nums">{value === null ? "Unavailable" : format(value)} / {format(target)}</p>
      {value !== null && (
        <progress aria-label={name} max={target} value={Math.min(value, target)} className={progressTrack} />
      )}
      <p className="text-sm opacity-75">
        {periodDate.formatRange(start, lastDay)} UTC
        {value !== null && !complete && " · Partial usage"}
      </p>
    </div>
  );
}

export function UsageTargets({ workspaceId, targets, sessions }: {
  workspaceId: string;
  targets: WorkspaceUsageTargets;
  sessions: SessionSummary[];
}) {
  const { budget, goal } = calculateUsageTargets(sessions, targets);

  return (
    <div className="mt-10 space-y-3">
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="usage-budget" className="min-w-0 space-y-4 rounded-lg border border-current/15 p-4">
          <h2 id="usage-budget" className="text-xl font-semibold">Usage budget</h2>
          {budget ? <ProgressSummary name="Monthly budget progress" progress={budget} format={formatCost} /> : (
            <p className="text-sm opacity-75">Set a monthly limit for estimated spend across all agents.</p>
          )}
          <UsageBudgetForm key={targets.monthlyBudgetCents ?? "unset"} workspaceId={workspaceId} cents={targets.monthlyBudgetCents} />
        </section>
        <section aria-labelledby="usage-goal" className="min-w-0 space-y-4 rounded-lg border border-current/15 p-4">
          <h2 id="usage-goal" className="text-xl font-semibold">Usage goal</h2>
          {goal && targets.goal ? (
            <>
              <p className="text-sm opacity-75">{agentLabel[targets.goal.scope]} · {targets.goal.period === "week" ? "Weekly" : "Monthly"} · {targets.goal.direction === "at-most" ? "At most" : "At least"}</p>
              <ProgressSummary name="Usage goal progress" progress={goal} format={targets.goal.metric === "cost" ? formatCost : formatCount} />
            </>
          ) : (
            <p className="text-sm opacity-75">Set a target for reported tokens or estimated spend.</p>
          )}
          <UsageGoalForm key={JSON.stringify(targets.goal)} workspaceId={workspaceId} goal={targets.goal} />
        </section>
      </div>
      <p className="text-sm opacity-75">
        Each session counts toward the UTC period in which it started. Weekly goals start on Monday. Cost estimates are in USD. Budgets and goals are advisory.
      </p>
    </div>
  );
}
