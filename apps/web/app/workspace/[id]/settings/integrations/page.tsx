import { workspaceClerkDirectory } from "@tideline/contracts";
import { teamPanel } from "../../../../../lib/team-ui";
import { fetchWorkspaceResource, readWorkspaceAccess } from "../../../../../lib/workspace";
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
