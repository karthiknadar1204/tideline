"use client";

import { SignIn, useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { signInReturnPath } from "../../lib/workspace-return";
import { tidelineAuthAppearance } from "../auth-frame";

const recoveryKey = "tideline:last-workspace-recovery";

function WorkspaceRecovery({ destination }: { destination: string }) {
  const { getToken } = useAuth();
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async () => {
    setFailed(false);
    try {
      if (await getToken({ skipCache: true })) {
        window.location.replace(destination);
        return;
      }
    } catch { /* The user can retry if Clerk is temporarily unavailable. */ }
    setFailed(true);
  }, [destination, getToken]);

  useEffect(() => {
    try {
      const previous = Number(sessionStorage.getItem(recoveryKey));
      if (Date.now() - previous < 15_000) return setFailed(true);
      sessionStorage.setItem(recoveryKey, String(Date.now()));
    } catch {
      return setFailed(true);
    }
    void refresh();
  }, [refresh]);

  return (
    <section className="space-y-4 text-center" aria-labelledby="restore-workspace">
      <h1 id="restore-workspace" className="text-xl font-semibold">Restoring your workspace</h1>
      {failed ? (
        <>
          <p role="status" className="text-sm text-[var(--workspace-muted)]">Your session could not be refreshed. Try opening this workspace again.</p>
          <button type="button" onClick={() => void refresh()} className="rounded-md bg-[var(--workspace-button)] px-4 py-2 text-sm font-medium text-[var(--workspace-button-text)]">Try again</button>
        </>
      ) : <p role="status" className="text-sm text-[var(--workspace-muted)]">Refreshing your sign-in…</p>}
    </section>
  );
}

export function WorkspaceSignIn({ origin }: { origin: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  const requested = useSearchParams().get("redirect_url");
  const destination = signInReturnPath(requested, origin);
  if (destination && /^\/workspaces?(?:[/?#]|$)/.test(destination)) {
    if (!isLoaded) return null;
    if (isSignedIn) return <WorkspaceRecovery destination={destination} />;
  }
  return <SignIn appearance={tidelineAuthAppearance} fallbackRedirectUrl="/workspace"
    forceRedirectUrl={requested === null ? undefined : destination ?? "/workspace"} />;
}
