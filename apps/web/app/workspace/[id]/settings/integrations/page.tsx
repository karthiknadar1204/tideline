import { workspaceClerkDirectory } from "@tideline/contracts";
import Link from "next/link";
import { teamLink, teamPanel } from "../../../../../lib/team-ui";
import { fetchWorkspaceResource, readWorkspaceAccess } from "../../../../../lib/workspace";
import { CopyTerminalCommand } from "../../../../copy-terminal-command";
import { McpSetup } from "../mcp-setup";
import { ClerkDirectorySettings } from "./clerk-directory-settings";

export default async function WorkspaceIntegrationSettings({ params }: PageProps<"/workspace/[id]/settings/integrations">) {
  const { id } = await params;
  const access = await readWorkspaceAccess(id);
  const response = access.kind === "team" ? await fetchWorkspaceResource(`${id}/clerk-directory`) : undefined;
  const directory = workspaceClerkDirectory.safeParse(response?.ok ? await response.json().catch(() => null) : null).data;

  return (
    <main aria-label="Integration settings" className="max-w-4xl space-y-4">
      <McpSetup workspaceId={id} />
      <section className={teamPanel} aria-labelledby="github-setup">
        <h2 className="font-semibold" id="github-setup">GitHub</h2>
        <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
          Sign in with <code>gh auth login</code>, then run this command from your checkout to link verified session commits to pull requests and GitHub Actions jobs.
        </p>
        <CopyTerminalCommand command={`tideline github sync --workspace ${id}`} label="Copy GitHub sync command" />
        <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
          For automatic updates, run <code>tideline sync setup --github-activity</code> and select the checkouts to sync. Your GitHub credential stays in <code>gh</code>.
        </p>
        <Link className={teamLink} href={`/workspace/${id}/reports/github`}>View GitHub activity</Link>
      </section>
      {directory?.configured ? (
        <ClerkDirectorySettings workspaceId={id} organizationId={directory.organizationId} owner={access.role === "owner"} />
      ) : access.kind === "team" && access.role === "owner" && (
        <section className={teamPanel} aria-labelledby="clerk-directory">
          <h2 id="clerk-directory" className="font-semibold">Enterprise identity</h2>
          <p className="text-sm text-[var(--workspace-muted)]">Configure Clerk Organizations and webhook delivery to connect SAML single sign-on and SCIM Directory Sync.</p>
        </section>
      )}
    </main>
  );
}
