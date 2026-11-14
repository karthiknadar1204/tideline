"use client";

import { useActionState, useId, useState } from "react";
import { sessionSource, sessionSourceLabel } from "@tideline/contracts";
import type { UsageGoal } from "@tideline/contracts";
import { saveBudget, saveGoal } from "./usage-target-actions";
import type { TargetSaveResult } from "./usage-target-actions";

const initialResult: TargetSaveResult = { kind: "idle" };
const fieldClass = "mt-1 min-h-11 w-full rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-bg)] px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--workspace-accent)] disabled:opacity-60";

function TargetButtons({ kind, configured, pending, result }: {
  kind: "budget" | "goal";
  configured: boolean;
  pending: boolean;
  result: TargetSaveResult;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className="min-h-10 rounded-lg bg-[var(--workspace-button)] px-4 py-2 text-sm font-medium text-[var(--workspace-button-text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)] disabled:opacity-50">
          Save {kind}
        </button>
        {configured && (
          <button type="submit" name="intent" value="clear" formNoValidate disabled={pending} className="min-h-10 rounded-lg px-3 py-2 text-sm font-medium text-[var(--workspace-muted)] hover:bg-[var(--workspace-subtle)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)] disabled:opacity-50">
            Clear {kind}
          </button>
        )}
        {pending && <span role="status" className="text-sm opacity-75">Saving…</span>}
      </div>
      {result.kind === "error" && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{result.message}</p>}
      {result.kind === "saved" && !pending && <p role="status" className="text-sm opacity-75">Saved.</p>}
    </div>
  );
}

export function UsageBudgetForm({ workspaceId, cents }: { workspaceId: string; cents: number | null }) {
  const [amount, setAmount] = useState(cents === null ? "" : (cents / 100).toFixed(2));
  const [result, action, pending] = useActionState(saveBudget.bind(null, workspaceId), initialResult);

  return (
    <form action={action} className="space-y-3">
      <label className="block text-sm font-medium">
        Monthly budget (USD)
        <input name="amount" inputMode="decimal" maxLength={14} required disabled={pending} value={amount} onChange={(event) => setAmount(event.target.value)} className={fieldClass} />
      </label>
      <TargetButtons kind="budget" configured={cents !== null} pending={pending} result={result} />
    </form>
  );
}

export function UsageGoalForm({ workspaceId, goal }: { workspaceId: string; goal: UsageGoal | null }) {
  const fieldId = useId();
  const [metric, setMetric] = useState<string>(goal?.metric ?? "tokens");
  const [amount, setAmount] = useState(goal ? goal.metric === "cost" ? (goal.target / 100).toFixed(2) : String(goal.target) : "");
  const [direction, setDirection] = useState<string>(goal?.direction ?? "at-most");
  const [period, setPeriod] = useState<string>(goal?.period ?? "month");
  const [scope, setScope] = useState<string>(goal?.scope ?? "all");
  const [result, action, pending] = useActionState(saveGoal.bind(null, workspaceId), initialResult);

  return (
    <form action={action} className="space-y-3">
      <fieldset disabled={pending} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${fieldId}-metric`} className="block text-sm font-medium">Metric</label>
          <select id={`${fieldId}-metric`} name="metric" value={metric} onChange={(event) => setMetric(event.target.value)} className={fieldClass}>
            <option value="tokens">Reported tokens</option>
            <option value="cost">Estimated spend (USD)</option>
          </select>
        </div>
        <label className="block text-sm font-medium">
          Target
          <input name="amount" inputMode={metric === "cost" ? "decimal" : "numeric"} maxLength={14} required value={amount} onChange={(event) => setAmount(event.target.value)} className={fieldClass} />
        </label>
        <div>
          <label htmlFor={`${fieldId}-direction`} className="block text-sm font-medium">Direction</label>
          <select id={`${fieldId}-direction`} name="direction" value={direction} onChange={(event) => setDirection(event.target.value)} className={fieldClass}>
            <option value="at-most">At most</option>
            <option value="at-least">At least</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${fieldId}-period`} className="block text-sm font-medium">Period</label>
          <select id={`${fieldId}-period`} name="period" value={period} onChange={(event) => setPeriod(event.target.value)} className={fieldClass}>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${fieldId}-scope`} className="block text-sm font-medium">Agent</label>
          <select id={`${fieldId}-scope`} name="scope" value={scope} onChange={(event) => setScope(event.target.value)} className={fieldClass}>
            <option value="all">All agents</option>
            {sessionSource.options.map((source) => <option key={source} value={source}>{sessionSourceLabel[source]}</option>)}
          </select>
        </div>
      </fieldset>
      <TargetButtons kind="goal" configured={goal !== null} pending={pending} result={result} />
    </form>
  );
}
