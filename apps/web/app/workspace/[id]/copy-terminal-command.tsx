"use client";

import { useState } from "react";
import { teamSecondaryButton } from "../../../lib/team-ui";

export function CopyTerminalCommand({ command, label }: { command: string; label: string }) {
  const text = `node --env-file=apps/cli/.env.local apps/cli/dist/index.js ${command}`;
  const [status, setStatus] = useState("");

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied");
    } catch {
      setStatus("Select the command to copy it.");
    }
  }

  return (
    <div className="space-y-3">
      <code className="block whitespace-pre-wrap rounded-lg bg-[var(--workspace-subtle)] px-3 py-3 text-xs leading-relaxed [overflow-wrap:anywhere] sm:px-4">
        {text}
      </code>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={copyCommand} className={teamSecondaryButton}>{label}</button>
        <span role="status" className="text-xs text-[var(--workspace-muted)]">{status}</span>
      </div>
    </div>
  );
}
