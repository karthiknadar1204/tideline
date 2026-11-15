"use client";

import { OrganizationProfile, OrganizationSwitcher, useOrganization } from "@clerk/nextjs";
import { useActionState } from "react";
import { teamButton, teamError, teamPanel, teamSecondaryButton } from "../../../../../lib/team-ui";
import { linkDirectory, unlinkDirectory } from "./directory-actions";
import type { DirectoryActionState } from "./directory-actions";

const idle: DirectoryActionState = { kind: "idle" };

export function ClerkDirectorySettings({ workspaceId, organizationId, owner }: {
  workspaceId: string;
  organizationId: string | null;
  owner: boolean;
}) {
  const { organization, membership } = useOrganization();
  const [linkState, linkAction, linking] = useActionState(linkDirectory.bind(null, workspaceId), idle);
  const [unlinkState, unlinkAction, unlinking] = useActionState(unlinkDirectory.bind(null, workspaceId), idle);
  const organizationAdmin = membership?.role === "org:admin";
  const selectedIsLinked = Boolean(organization && organization.id === organizationId);

  return (
    <section className={teamPanel} aria-labelledby="clerk-directory">
      <h2 id="clerk-directory" className="font-semibold">Enterprise identity</h2>
      <p className="text-sm text-[var(--workspace-muted)]">Configure SAML single sign-on and SCIM Directory Sync in the linked Clerk organization.</p>
      {organizationId && <p className="break-all text-sm">Linked organization <code>{organizationId}</code></p>}
      {(owner || organizationId) && <OrganizationSwitcher />}
      {owner && (
        <>
          <p className="text-sm text-[var(--workspace-muted)]">Clerk members and administrators receive the corresponding Tideline role. Existing manual memberships keep their roles.</p>
          <form action={linkAction} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="organizationId" value={organization?.id ?? ""} />
            <button type="submit" className={teamButton} disabled={linking || !organizationAdmin || Boolean(organizationId && !selectedIsLinked)}>
              {linking ? "Syncing…" : organizationId ? "Sync members" : "Link organization"}
            </button>
            {linkState.kind === "saved" && <p role="status" className="text-sm">Organization members synced.</p>}
            {linkState.kind === "error" && <p role="alert" className={teamError}>{linkState.message}</p>}
          </form>
        </>
      )}
      {selectedIsLinked && organizationAdmin && (
        <OrganizationProfile routing="hash" appearance={{ elements: { rootBox: { width: "100%" }, cardBox: { maxWidth: "100%", width: "100%" } } }} />
      )}
      {owner && organizationId && (
        <details>
          <summary className={`${teamSecondaryButton} cursor-pointer`}>Disconnect organization</summary>
          <form action={unlinkAction} className="mt-3 space-y-2">
            <p className="text-sm text-[var(--workspace-muted)]">Disconnecting removes directory-managed access and revokes those members' sync credentials for this workspace.</p>
            <button className={teamSecondaryButton} type="submit" disabled={unlinking}>{unlinking ? "Disconnecting…" : "Confirm disconnect"}</button>
            {unlinkState.kind === "error" && <p role="alert" className={teamError}>{unlinkState.message}</p>}
          </form>
        </details>
      )}
    </section>
  );
}
