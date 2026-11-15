"use client";

import { useUser } from "@clerk/nextjs";
import { cliSetupBrowserConnection, cliSetupSnapshot } from "@tideline/contracts";
import type { CliSetupBrowserConnection as Connection, CliSetupProgress } from "@tideline/contracts";
import { useEffect, useState } from "react";
import { CopyTerminalCommand } from "../../copy-terminal-command";

type Setup = { key: string; connection: Connection };

const statusCopy: Record<CliSetupProgress["phase"], string> = {
  waiting: "Waiting for your terminal",
  scanning: "Finding repositories on your computer",
  choosing: "Choose repositories in your terminal",
  approving: "Approve Tideline in the browser",
  starting: "Starting sync",
  ready: "Terminal connected",
  cancelled: "Setup ended in your terminal",
  failed: "Setup could not finish",
};

function folderCount(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? "folder" : "folders"} selected.`;
}

function SetupProgress({ progress }: { progress: CliSetupProgress }) {
  const description = (() => {
    switch (progress.phase) {
      case "choosing":
        return `${progress.repositoriesFound.toLocaleString()} ${progress.repositoriesFound === 1 ? "repository or folder" : "repositories and folders"} · ${progress.localSessionsFound.toLocaleString()} ${progress.localSessionsFound === 1 ? "local session" : "local sessions"} found.`;
      case "approving":
        return `${folderCount(progress.checkoutsSelected)} Use the account that opened this workspace.`;
      case "starting":
        return `${folderCount(progress.checkoutsSelected)} Tideline is saving your choices.`;
      case "ready":
        return progress.background
          ? `${folderCount(progress.checkoutsSelected)} Background sync started.`
          : `${folderCount(progress.checkoutsSelected)} Run tideline sync start when you're ready.`;
      case "failed":
        return "Check the message in your terminal, then get a fresh command.";
      default:
        return undefined;
    }
  })();
  return (
    <div className="space-y-1" role="status">
      <p className="flex items-center gap-2 text-sm font-medium">
        <span aria-hidden="true" className={`size-2 rounded-full ${progress.phase === "ready" ? "bg-[var(--workspace-accent)]" : "border border-current"}`} />
        {statusCopy[progress.phase]}
      </p>
      {description && <p className="pl-4 text-xs text-[var(--workspace-muted)]">{description}</p>}
    </div>
  );
}

function isFinished(phase: CliSetupProgress["phase"]) {
  return phase === "ready" || phase === "failed" || phase === "cancelled";
}

function storeConnection(key: string, connection?: Connection) {
  try {
    if (connection) sessionStorage.setItem(key, JSON.stringify(connection));
    else sessionStorage.removeItem(key);
  } catch {
    // Storage is optional in private browser contexts.
  }
}

export function PairedCliSetup({ workspaceId, fallbackCommand }: { workspaceId: string; fallbackCommand: string }) {
  const { user } = useUser();
  const storageKey = user ? `tideline:setup:${user.id}:${workspaceId}` : null;
  const endpoint = `/workspace/${encodeURIComponent(workspaceId)}/connect-state`;
  const [setup, setSetup] = useState<Setup>();
  const [request, setRequest] = useState<{ key: string; status: "pending" | "failed" | "expired" | "copied" }>();
  const connection = setup?.key === storageKey ? setup.connection : undefined;
  const requestState = request?.key === storageKey ? request.status : undefined;

  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = cliSetupBrowserConnection.safeParse(JSON.parse(sessionStorage.getItem(storageKey) ?? "null"));
      if (saved.success) setSetup({ key: storageKey, connection: saved.data });
    } catch {
      // Invalid entries are ignored and the user can start a new setup.
    }
  }, [storageKey]);

  const latestId = connection?.id;
  const finished = connection ? isFinished(connection.progress.phase) : false;
  useEffect(() => {
    if (!storageKey || !latestId || finished) return;
    const key = storageKey;
    const id = latestId;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function readProgress() {
      try {
        const response = await fetch(`${endpoint}?id=${encodeURIComponent(id)}`, {
          cache: "no-store",
          signal: stop.signal,
        });
        if (stop.signal.aborted) return;
        if (response.status === 404) {
          storeConnection(key);
          setSetup((current) => current?.connection.id === id ? undefined : current);
          setRequest({ key, status: "expired" });
          return;
        }
        if (response.ok) {
          const next = cliSetupSnapshot.safeParse(await response.json());
          if (stop.signal.aborted) return;
          if (next.success && next.data.id === id) {
            setSetup((current) => {
              if (current?.key !== key || current.connection.id !== id) return current;
              const command = next.data.progress.phase === "waiting" ? current.connection.command : undefined;
              return { key, connection: { ...next.data, command } };
            });
            if (isFinished(next.data.progress.phase)) return;
          }
        }
      } catch {
        // Transient connectivity failures resume on the next poll.
      }
      if (!stop.signal.aborted) timer = setTimeout(readProgress, 2_000);
    }
    void readProgress();
    return () => {
      stop.abort();
      clearTimeout(timer);
    };
  }, [endpoint, finished, latestId, storageKey]);

  useEffect(() => {
    if (storageKey && connection) storeConnection(storageKey, connection);
  }, [connection, storageKey]);

  async function generateCommand() {
    if (!storageKey || requestState === "pending") return;
    setRequest({ key: storageKey, status: "pending" });
    const command = fetch(endpoint, { method: "POST", cache: "no-store" }).then(async (response) => {
      const parsed = cliSetupBrowserConnection.safeParse(response.ok ? await response.json() : null);
      if (!parsed.success || !parsed.data.command) return;
      return { connection: parsed.data, text: parsed.data.command };
    }).catch(() => undefined);
    let copied: Promise<boolean> | undefined;
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const text = command.then((value) => {
        if (!value) throw new Error("Setup command unavailable");
        return new Blob([value.text], { type: "text/plain" });
      });
      copied = navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]).then(() => true, () => false);
    }
    const next = await command;
    if (!next) {
      setRequest({ key: storageKey, status: "failed" });
      return;
    }
    setSetup({ key: storageKey, connection: next.connection });
    setRequest(await copied ? { key: storageKey, status: "copied" } : undefined);
  }

  return (
    <div className="space-y-3">
      {connection && (
        <>
          {connection.progress.phase === "waiting" && connection.command && <CopyTerminalCommand command={connection.command} label="Copy paired setup command" />}
          <SetupProgress progress={connection.progress} />
        </>
      )}
      {requestState === "expired" && <p role="status" className="text-sm">This setup code expired. Get a fresh command to continue.</p>}
      {requestState === "failed" && <p role="alert" className="text-sm">Couldn't make a paired command. Try again or use the direct command below.</p>}
      {requestState === "copied" && connection?.progress.phase === "waiting" && <p role="status" className="text-sm">Command copied. Paste it into your terminal.</p>}
      {(!connection || finished || connection.progress.phase === "waiting" || connection.progress.phase === "choosing") && (
        <button type="button" disabled={!storageKey || requestState === "pending"} onClick={generateCommand}
          className={`min-h-9 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-65 ${connection ? "border border-[var(--workspace-border)] hover:bg-[var(--workspace-panel)]" : "bg-[var(--workspace-button)] text-[var(--workspace-button-text)] hover:opacity-90"}`}>
          {requestState === "pending" ? "Creating command…" : connection || requestState === "expired" ? "Get a fresh command" : "Copy setup command"}
        </button>
      )}
      {(!connection || finished) && (
        <details className="space-y-2">
          <summary className="w-fit cursor-pointer text-xs font-medium text-[var(--workspace-muted)]">Use a direct command</summary>
          <CopyTerminalCommand command={fallbackCommand} label="Copy direct setup command" />
        </details>
      )}
    </div>
  );
}
