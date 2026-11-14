"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { teamSecondaryButton } from "../../../lib/team-ui";

export function RefreshSessions({ showButton = false }: { showButton?: boolean }) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") router.refresh();
    }

    const timer = window.setInterval(refreshWhenVisible, 5_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [router]);

  if (!showButton) return null;

  return (
    <button type="button" className={teamSecondaryButton} disabled={refreshing} onClick={() => startTransition(() => router.refresh())}>
      {refreshing ? "Refreshing…" : "Refresh sessions"}
    </button>
  );
}
