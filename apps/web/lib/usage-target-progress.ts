import type { SessionSummary, UsageGoal, WorkspaceUsageTargets } from "@tideline/contracts";
import { combineUsage, summarizeSession } from "./usage";
import type { Usage } from "./usage";

type Period = { start: Date; end: Date };
type Progress<Status extends string> = Period & {
  value: number | null;
  complete: boolean;
  target: number;
  status: Status;
};
type BudgetStatus = "under" | "near" | "reached" | "over" | "partial" | "unavailable";
type GoalStatus = "met" | "progress" | "exceeded" | "within" | "partial" | "unavailable";

function utcPeriod(period: UsageGoal["period"], now: Date): Period {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (period === "week") {
    start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return { start, end };
  }
  start.setUTCDate(1);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

function usageInPeriod(sessions: SessionSummary[], { start, end }: Period, scope: UsageGoal["scope"], now: Date): Usage {
  const startsAt = start.getTime();
  const endsAt = end.getTime();
  const asOf = now.getTime();
  const entries = sessions.filter(({ source, startedAt }) => {
    const timestamp = Date.parse(startedAt);
    return (scope === "all" || scope === source) && timestamp >= startsAt && timestamp < endsAt && timestamp <= asOf;
  }).map(({ analytics }) => summarizeSession(analytics));

  if (entries.length) return combineUsage(entries);
  const zero = { value: 0, complete: true };
  return { cost: zero, tokens: zero };
}

const nanoDollarsPerCent = 10_000_000;

function spendInNanoDollars(value: number) {
  return Math.round(value * (100 * nanoDollarsPerCent));
}

function budgetStatus({ value, complete }: Usage["cost"], cents: number): BudgetStatus {
  if (value === null) return "unavailable";
  const spent = spendInNanoDollars(value);
  const limit = cents * nanoDollarsPerCent;
  const difference = spent - limit;
  if (difference > 0) return "over";
  if (difference === 0) return "reached";
  if (!complete) return "partial";
  return spent >= cents * (nanoDollarsPerCent / 5 * 4) ? "near" : "under";
}

function goalStatus({ value, complete }: Usage["tokens"], goal: UsageGoal): GoalStatus {
  if (value === null) return "unavailable";
  const difference = goal.metric === "cost"
    ? spendInNanoDollars(value) - goal.target * nanoDollarsPerCent
    : value - goal.target;
  if (goal.direction === "at-least" && difference >= 0) return "met";
  if (goal.direction === "at-most" && difference > 0) return "exceeded";
  if (!complete) return "partial";
  return goal.direction === "at-least" ? "progress" : "within";
}

export function calculateUsageTargets(sessions: SessionSummary[], targets: WorkspaceUsageTargets, now = new Date()) {
  const { monthlyBudgetCents, goal } = targets;
  let budget: Progress<BudgetStatus> | null = null;
  let goalProgress: Progress<GoalStatus> | null = null;

  if (monthlyBudgetCents !== null) {
    const period = utcPeriod("month", now);
    const cost = usageInPeriod(sessions, period, "all", now).cost;
    budget = { ...period, ...cost, target: monthlyBudgetCents / 100, status: budgetStatus(cost, monthlyBudgetCents) };
  }
  if (goal) {
    const period = utcPeriod(goal.period, now);
    const usage = usageInPeriod(sessions, period, goal.scope, now);
    const metric = goal.metric === "cost" ? usage.cost : usage.tokens;
    goalProgress = {
      ...period,
      ...metric,
      target: goal.metric === "cost" ? goal.target / 100 : goal.target,
      status: goalStatus(metric, goal),
    };
  }
  return { budget, goal: goalProgress };
}
