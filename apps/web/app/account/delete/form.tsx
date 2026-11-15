"use client";

import { useClerk } from "@clerk/nextjs";
import { useActionState, useEffect } from "react";
import { teamError, teamField } from "../../../lib/team-ui";
import { deleteAccount } from "./action";
import type { AccountDeleteResult } from "./action";

const initial: AccountDeleteResult = { kind: "idle" };

export function DeleteAccountForm({ retiring }: { retiring: boolean }) {
  const [result, action, pending] = useActionState(deleteAccount, initial);
  const clerk = useClerk();
  useEffect(() => {
    if (result.kind !== "done") return;
    void clerk.signOut({ redirectUrl: "/" }).catch(() => window.location.replace("/"));
  }, [clerk, result.kind]);

  return (
    <form action={action} className="max-w-sm space-y-4">
      <label className="grid gap-2 text-sm">
        <span>Type <strong>DELETE</strong> to confirm.</span>
        <input className={teamField} name="confirmation" required autoComplete="off" maxLength={6} disabled={pending || result.kind === "done"} />
      </label>
      <button className="min-h-10 rounded-lg bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
        type="submit" disabled={pending || result.kind === "done"}>
        {pending || result.kind === "done" ? "Deleting…" : retiring ? "Finish deleting account" : "Permanently delete account"}
      </button>
      {result.kind === "error" && <p className={teamError} role="alert">{result.message}</p>}
    </form>
  );
}
