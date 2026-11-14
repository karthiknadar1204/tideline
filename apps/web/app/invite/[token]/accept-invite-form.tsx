"use client";

import { useActionState } from "react";
import { initialTeamAction, teamButton, teamError } from "../../../lib/team-ui";
import { acceptInvite } from "./actions";

export function AcceptInviteForm({ token }: { token: string }) {
  const [result, action, pending] = useActionState(acceptInvite.bind(null, token), initialTeamAction);

  return (
    <form action={action} className="space-y-3">
      <button className={teamButton} disabled={pending} type="submit">{pending ? "Joining…" : "Join workspace"}</button>
      {result.kind === "error" && <p role="alert" className={teamError}>{result.message}</p>}
    </form>
  );
}
