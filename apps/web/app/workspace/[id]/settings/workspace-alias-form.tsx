"use client";

import { useActionState } from "react";
import { initialTeamAction, teamButton, teamError, teamField } from "../../../../lib/team-ui";
import { saveWorkspaceAlias } from "./actions";

export function WorkspaceAliasForm({ workspaceId, alias }: { workspaceId: string; alias: string | null }) {
  const [result, action, pending] = useActionState(saveWorkspaceAlias.bind(null, workspaceId), initialTeamAction);
  return (
    <form action={action} className="max-w-md space-y-3">
      <label className="grid gap-1.5 text-sm font-medium">
        <span>Workspace URL alias</span>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-normal text-[var(--workspace-muted)]">/workspace/</span>
          <input name="alias" defaultValue={alias ?? ""} className={`${teamField} min-w-36 flex-1`} required minLength={3} maxLength={48}
            autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={pending} />
        </span>
      </label>
      <button type="submit" className={teamButton} disabled={pending}>{pending ? "Saving…" : "Save URL"}</button>
      {result.kind === "error" && <p role="alert" className={teamError}>{result.message}</p>}
    </form>
  );
}
