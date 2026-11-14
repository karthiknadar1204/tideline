"use client";

import type { CreateSessionShareRequest } from "@tideline/contracts";
import { useActionState, useState } from "react";
import { changeSessionShare } from "./share-actions";
import type { ShareFeedback } from "./share-actions";

const initialFeedback: ShareFeedback = { kind: "idle" };
const focusStyle = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)]";
const secondaryAction = `inline-flex min-h-10 items-center rounded-lg border border-[var(--workspace-border)] px-3 text-sm font-medium hover:bg-[var(--workspace-subtle)] ${focusStyle}`;

function PublishedShare({ token }: { token: string }) {
  const path = `/share/${token}`;
  const [copyFeedback, setCopyFeedback] = useState("");

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      setCopyFeedback("Link copied.");
    } catch {
      setCopyFeedback("Open the shared session and copy its address.");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button className={secondaryAction} type="button" onClick={copyLink}>Copy link</button>
        <a className={secondaryAction} href={path} target="_blank" rel="noreferrer">Open shared session</a>
      </div>
      {copyFeedback && <p role="status" className="text-sm text-[var(--workspace-muted)]">{copyFeedback}</p>}
    </div>
  );
}

export function SessionShare({ workspaceId, sessionId, displayed, status }: {
  workspaceId: string;
  sessionId: string;
  displayed: CreateSessionShareRequest;
  status?: { token: string | null };
}) {
  const [feedback, submit, pending] = useActionState(changeSessionShare.bind(null, workspaceId, sessionId, displayed), initialFeedback);
  const token = status?.token;

  return (
    <details className="mt-4 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] px-4 py-2.5 sm:px-5">
      <summary className={`w-fit cursor-pointer rounded text-sm font-medium text-[var(--workspace-accent)] ${focusStyle}`}>
        Share session
      </summary>
      {status ? (
        <div className="space-y-3 pt-3">
          <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
            {token ? "Anyone with the link can read the published copy. It stays the same as this session syncs." : "Create a link anyone can open to read a copy of the conversation shown here. You can revoke it at any time."}
          </p>
          {token && <PublishedShare key={token} token={token} />}
          <form action={submit}>
            <button
              type="submit"
              name="intent"
              value={token ? "revoke" : "create"}
              disabled={pending}
              className={token ? `${secondaryAction} disabled:opacity-50` : `min-h-10 rounded-lg bg-[var(--workspace-button)] px-3 text-sm font-medium text-[var(--workspace-button-text)] hover:opacity-90 disabled:opacity-50 ${focusStyle}`}
            >
              {pending ? "Saving…" : token ? "Revoke link" : "Create share link"}
            </button>
          </form>
          {feedback.kind !== "idle" && !pending && (
            <p role={feedback.kind === "error" ? "alert" : "status"} className="text-sm text-[var(--workspace-muted)]">{feedback.message}</p>
          )}
        </div>
      ) : (
        <p className="pt-3 text-sm text-[var(--workspace-muted)]">Sharing is unavailable. Refresh and try again.</p>
      )}
    </details>
  );
}
