"use client";

import { useActionState } from "react";
import { initialTeamAction, teamError, teamField, teamSecondaryButton } from "../../../../lib/team-ui";
import { deleteWorkspace } from "./actions";

export function DeleteWorkspaceForm({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const [result, action, pending] = useActionState(deleteWorkspace.bind(null, workspaceId), initialTeamAction);
  return (
    <details>
      <summary className={`${teamSecondaryButton} cursor-pointer text-red-700 dark:text-red-300`}>Delete workspace</summary>
      <form action={action} className="mt-4 max-w-sm space-y-3">
        <label className="grid gap-1 text-sm">
          <span>Type <strong>{workspaceName}</strong> to confirm.</span>
          <input name="name" required maxLength={80} autoComplete="off" className={teamField} disabled={pending} />
        </label>
        <button type="submit" disabled={pending} className="min-h-10 rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50">
          {pending ? "Deleting…" : "Permanently delete workspace"}
        </button>
        {result.kind === "error" && <p role="alert" className={teamError}>{result.message}</p>}
      </form>
    </details>
  );
}
