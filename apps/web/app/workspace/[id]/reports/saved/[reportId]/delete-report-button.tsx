"use client";

import { useActionState, useState } from "react";
import { deleteSavedReport } from "./actions";

const button = "inline-flex min-h-10 items-center rounded-lg border border-[var(--workspace-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--workspace-subtle)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";

export function DeleteReportButton({ workspaceId, reportId }: { workspaceId: string; reportId: string }) {
  const [confirm, setConfirm] = useState(false);
  const [error, action, pending] = useActionState(deleteSavedReport.bind(null, workspaceId, reportId), null);

  return confirm ? (
    <form action={action} className="space-y-2">
      <p className="text-sm text-[var(--workspace-muted)]">Permanently delete this saved report?</p>
      <div className="flex flex-wrap gap-2">
        <button className={button} type="button" disabled={pending} onClick={() => setConfirm(false)}>Cancel</button>
        <button className={`${button} text-red-700 dark:text-red-300`} type="submit" disabled={pending}>{pending ? "Deleting…" : "Confirm deletion"}</button>
      </div>
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
    </form>
  ) : (
    <button className={`${button} text-[var(--workspace-muted)]`} type="button" onClick={() => setConfirm(true)}>Delete report</button>
  );
}
