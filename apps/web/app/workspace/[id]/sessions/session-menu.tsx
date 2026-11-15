"use client";

import type { ReactNode } from "react";
import styles from "./sessions.module.css";

export function SessionMenu({ label, children, initiallyOpen }: { label: ReactNode; children: ReactNode; initiallyOpen?: boolean }) {
  return (
    <details
      name="session-controls"
      className={styles.menu}
      open={initiallyOpen || undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.preventDefault();
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}
    >
      <summary className={styles.control}>{label}</summary>
      {children}
    </details>
  );
}
