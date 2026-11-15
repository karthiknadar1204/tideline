"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import styles from "./sessions.module.css";

const refreshInterval = 30_000;
const interactionGracePeriod = 2_000;

export function SessionRefresh({ label, whenIdle = false }: { label: string; whenIdle?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!whenIdle || pending) return;

    let lastInteraction = 0;
    function noteInteraction() {
      lastInteraction = Date.now();
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastInteraction < interactionGracePeriod) return;
      if (document.activeElement?.closest("main input, main select")) return;
      if (document.querySelector("main details[open]")) return;
      startTransition(() => router.refresh());
    }, refreshInterval);
    document.addEventListener("pointerdown", noteInteraction);
    document.addEventListener("keydown", noteInteraction);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("pointerdown", noteInteraction);
      document.removeEventListener("keydown", noteInteraction);
    };
  }, [pending, router, whenIdle]);

  return (
    <button
      type="button"
      className={styles.control}
      aria-label={label}
      aria-busy={pending}
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      Refresh
    </button>
  );
}
