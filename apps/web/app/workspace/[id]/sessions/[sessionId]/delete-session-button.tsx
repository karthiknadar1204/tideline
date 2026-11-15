"use client";

import type { WorkspaceSessionSearchQuery } from "@tideline/contracts";
import { useActionState, useState } from "react";
import { deleteSession } from "./delete-session-action";

const button = "inline-flex min-h-9 items-center rounded-lg border border-[var(--workspace-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--workspace-subtle)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";

export function DeleteSessionButton({ workspaceId, sessionId, filters }: {
  workspaceId: string;
  sessionId: string;
  filters: WorkspaceSessionSearchQuery;
}) {
  const [confirm, setConfirm] = useState(false);
  const [error, action, pending] = useActionState(deleteSession.bind(null, workspaceId, sessionId, filters), null);

  return confirm ? (
    <form action={action} className="space-y-2">
      <p className="text-sm text-[var(--workspace-muted)]">Permanently delete this session from Tideline? This also revokes its share link.</p>
      <div className="flex flex-wrap gap-2">
        <button className={button} type="button" disabled={pending} onClick={() => setConfirm(false)}>Cancel</button>
        <button className={`${button} text-red-700 dark:text-red-300`} type="submit" disabled={pending}>{pending ? "Deleting…" : "Confirm deletion"}</button>
      </div>
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
    </form>
  ) : (
    <button className={`${button} text-[var(--workspace-muted)]`} type="button" onClick={() => setConfirm(true)}>Delete session</button>
  );
}
