"use client";

import { useActionState } from "react";
import { initialTeamAction, teamButton, teamError, teamField } from "../../lib/team-ui";
import { createTeamWorkspace } from "./actions";

export function CreateTeamForm() {
  const [result, action, pending] = useActionState(createTeamWorkspace, initialTeamAction);

  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <label className="block text-sm font-medium" htmlFor="team-name">Workspace name</label>
        <input autoComplete="off" className={teamField} id="team-name" name="name" maxLength={80} required disabled={pending} />
      </div>
      <button className={teamButton} disabled={pending} type="submit">{pending ? "Creating…" : "Create team workspace"}</button>
      {result.kind === "error" && <p role="alert" className={teamError}>{result.message}</p>}
    </form>
  );
}
