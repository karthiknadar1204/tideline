"use client";

import { useEffect, useState } from "react";

export function CopyTerminalCommand({ command, label = "Copy command" }: { command: string; label?: string }) {
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus("Copied");
    } catch {
      setStatus("Select the command to copy it.");
    }
  }

  return (
    <div className="space-y-2">
      <div className="grid items-center gap-3 rounded-xl border border-[#384b43] bg-[#182721] px-4 py-3 text-[#e7efeb] sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 gap-3">
          <span aria-hidden="true" className="font-mono text-sm text-[#a3d4c1]">$</span>
          <code className="min-w-0 whitespace-pre-wrap text-xs leading-relaxed [overflow-wrap:anywhere]" style={{ color: "inherit" }}>{command}</code>
        </div>
        <button type="button" aria-label={label} disabled={!ready} onClick={copyCommand} className="min-h-9 w-fit rounded-md border border-[#586b62] px-3 text-xs font-medium hover:bg-[#30473c] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60">
          {status === "Copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <span role="status" className={status === "Select the command to copy it." ? "block text-xs text-current" : "sr-only"}>{status}</span>
    </div>
  );
}
