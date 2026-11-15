import type { WorkspaceAccess } from "@tideline/contracts";
import { SettingsNav } from "./settings-nav";

export function SettingsHeader({ workspace }: { workspace: WorkspaceAccess }) {
  return (
    <>
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Settings</h1>
        <p className="text-sm text-[var(--workspace-muted)]">{workspace.name}</p>
      </header>
      <SettingsNav workspaceId={workspace.id} team={workspace.kind === "team"} />
    </>
  );
}
