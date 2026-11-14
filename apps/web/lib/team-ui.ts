export const workspaceRoleLabel = { owner: "Owner", admin: "Admin", member: "Member" };

export const teamPanel = "min-w-0 space-y-4 rounded-xl border border-[var(--workspace-border)] bg-[var(--workspace-panel)] p-4 sm:p-5";
export const teamField = "min-h-11 w-full min-w-0 rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-bg)] px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--workspace-accent)] disabled:opacity-60";
export const teamButton = "inline-flex min-h-10 items-center justify-center rounded-lg bg-[var(--workspace-button)] px-4 py-2 text-sm font-semibold text-[var(--workspace-button-text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)] disabled:opacity-50";
export const teamSecondaryButton = "inline-flex min-h-10 items-center justify-center rounded-lg border border-[var(--workspace-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--workspace-subtle)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)] disabled:opacity-50";
export const teamLink = "text-sm font-medium text-[var(--workspace-accent)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2";
export const teamError = "text-sm text-red-700 dark:text-red-300";

export type TeamActionState = { kind: "idle" } | { kind: "error"; message: string };
export const initialTeamAction: TeamActionState = { kind: "idle" };
