"use client";

import { useActionState, useState } from "react";
import { saveWorkspaceName } from "./actions";
import type { NameSaveResult } from "./actions";

const initialResult: NameSaveResult = { kind: "idle" };

export function WorkspaceNameForm({ workspaceId, name }: { workspaceId: string; name: string }) {
  const [draft, setDraft] = useState(name);
  const [result, action, pending] = useActionState(async (_previous: NameSaveResult, form: FormData) => {
    const saved = await saveWorkspaceName(workspaceId, form);
    if (saved.kind === "saved") setDraft(saved.name);
    return saved;
  }, initialResult);

  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="workspace-name" className="block text-sm font-medium">Workspace name</label>
        <input
          id="workspace-name"
          name="name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          required
          maxLength={80}
          disabled={pending}
          aria-invalid={result.kind === "error"}
          aria-describedby={result.kind === "error" ? "workspace-name-error" : undefined}
          className="min-h-11 w-full max-w-md rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-bg)] px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--workspace-accent)] disabled:opacity-60"
        />
      </div>
      {result.kind === "error" && <p id="workspace-name-error" role="alert" className="text-sm text-red-700 dark:text-red-300">{result.message}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="submit"
          disabled={pending || draft === name}
          className="min-h-10 rounded-lg bg-[var(--workspace-button)] px-4 py-2 text-sm font-medium text-[var(--workspace-button-text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)] disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save name"}
        </button>
        <p role="status" className="text-sm text-[var(--workspace-muted)]">
          {result.kind === "saved" && draft === result.name && !pending ? "Workspace name saved." : ""}
        </p>
      </div>
    </form>
  );
}
