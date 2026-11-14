"use client";

import { useActionState, useId, useState } from "react";
import type { TeamMemberRole } from "@tideline/contracts";
import { initialTeamAction, teamButton, teamError, teamField, teamSecondaryButton, workspaceRoleLabel } from "../../../../lib/team-ui";
import { inviteMember, revokeInvite, updateMember } from "./actions";

export function InviteMemberForm({ workspaceId, canInviteAdmin, pendingInviteIds }: {
  workspaceId: string;
  canInviteAdmin: boolean;
  pendingInviteIds: string[];
}) {
  const [result, action, pending] = useActionState(inviteMember.bind(null, workspaceId), initialTeamAction);

  return (
    <div className="space-y-4">
      <form action={action} className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,10rem)_auto]">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium" htmlFor="invite-email">Email address</label>
          <input className={teamField} id="invite-email" type="email" name="email" maxLength={254} required disabled={pending} />
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium" htmlFor="invite-role">Role</label>
          <select className={teamField} id="invite-role" name="role" defaultValue="member" disabled={pending}>
            <option value="member">Member</option>
            {canInviteAdmin && <option value="admin">Admin</option>}
          </select>
        </div>
        <button className={`${teamButton} min-h-11 justify-self-start`} type="submit" disabled={pending}>{pending ? "Creating…" : "Create invite link"}</button>
      </form>
      {result.kind === "error" && <p role="alert" className={teamError}>{result.message}</p>}
      {result.kind === "created" && !pending && pendingInviteIds.includes(result.id) && <InviteLink key={result.id} token={result.token} />}
    </div>
  );
}

function InviteLink({ token }: { token: string }) {
  const [copyStatus, setCopyStatus] = useState("");
  const path = `/invite/${token}`;

  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus("Could not copy automatically. Open the link and copy its address.");
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-subtle)] p-3">
      <p className="text-sm">Send this link to the invited email address. It expires in 7 days.</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button className={teamSecondaryButton} type="button" onClick={copyInviteLink}>Copy link</button>
        <a className="text-sm text-[var(--workspace-accent)] underline underline-offset-4" href={path} target="_blank" rel="noreferrer">Open invite link</a>
        <p role="status" className="text-sm text-[var(--workspace-muted)]">{copyStatus}</p>
      </div>
    </div>
  );
}

export function RevokeInviteForm({ workspaceId, inviteId }: { workspaceId: string; inviteId: string }) {
  const [result, action, pending] = useActionState(revokeInvite.bind(null, workspaceId, inviteId), initialTeamAction);
  return (
    <form action={action} className="space-y-1.5">
      <button className={teamSecondaryButton} type="submit" disabled={pending}>{pending ? "Revoking…" : "Revoke invite"}</button>
      {result.kind === "error" && <p role="alert" className={teamError}>{result.message}</p>}
    </form>
  );
}

export function MemberForm({ workspaceId, userId, role, canChangeRole }: {
  workspaceId: string;
  userId: string;
  role: TeamMemberRole;
  canChangeRole: boolean;
}) {
  const [result, action, pending] = useActionState(updateMember.bind(null, workspaceId, userId), initialTeamAction);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [nextRole, setNextRole] = useState<string>(role);
  const roleLabel = useId();

  return (
    <form action={action} className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {canChangeRole && !confirmRemove && (
          <>
            <label className="sr-only" htmlFor={roleLabel}>Role</label>
            <select className={`${teamField} w-auto`} id={roleLabel} name="role" value={nextRole} disabled={pending} onChange={(event) => setNextRole(event.target.value)}>
              <option value="member">{workspaceRoleLabel.member}</option>
              <option value="admin">{workspaceRoleLabel.admin}</option>
            </select>
            <button type="submit" className={teamSecondaryButton} disabled={pending || nextRole === role}>Save role</button>
          </>
        )}
        {confirmRemove ? (
          <>
            <button className={teamSecondaryButton} type="button" disabled={pending} onClick={() => setConfirmRemove(false)}>Cancel</button>
            <button className={`${teamSecondaryButton} text-red-700 dark:text-red-300`} type="submit" name="intent" value="remove" disabled={pending}>Confirm removal</button>
          </>
        ) : (
          <button className={teamSecondaryButton} type="button" disabled={pending} onClick={() => setConfirmRemove(true)}>Remove</button>
        )}
      </div>
      {pending && <p className="text-sm text-[var(--workspace-muted)]" role="status">Saving…</p>}
      {result.kind === "error" && <p role="alert" className={teamError}>{result.message}</p>}
    </form>
  );
}
