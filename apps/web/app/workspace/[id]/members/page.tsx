import { auth } from "@clerk/nextjs/server";
import { workspaceTeam } from "@tideline/contracts";
import { notFound } from "next/navigation";
import { teamPanel, workspaceRoleLabel } from "../../../../lib/team-ui";
import { fetchWorkspaceResource, readWorkspaceAccess } from "../../../../lib/workspace";
import { SettingsHeader } from "../settings/settings-header";
import { InviteMemberForm, MemberForm, RevokeInviteForm } from "./member-forms";

const expiration = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

export default async function MembersPage({ params }: PageProps<"/workspace/[id]/members">) {
  const { id } = await params;
  const [{ userId }, workspace, response] = await Promise.all([
    auth(), readWorkspaceAccess(id), fetchWorkspaceResource(`${encodeURIComponent(id)}/team`),
  ]);
  if (workspace.kind !== "team") notFound();
  if (!response?.ok) throw new Error("Could not open the team roster.");
  const team = workspaceTeam.parse(await response.json());
  const isOwner = workspace.role === "owner";
  const canInvite = workspace.role !== "member";

  return (
    <main className="space-y-6 pt-7 sm:pt-9">
      <SettingsHeader workspace={workspace} />
      {canInvite && (
        <section aria-labelledby="invite-member" className={teamPanel}>
          <div className="space-y-1">
            <h2 className="font-semibold" id="invite-member">Invite a teammate</h2>
            <p className="text-sm text-[var(--workspace-muted)]">Members can sync and read team sessions and reports. Admins can also invite and remove members and manage settings.</p>
          </div>
          <InviteMemberForm workspaceId={id} canInviteAdmin={isOwner} pendingInviteIds={team.invites.map(({ id }) => id)} />
        </section>
      )}
      <section aria-labelledby="team-roster" className={teamPanel}>
        <h2 className="font-semibold" id="team-roster">Team roster</h2>
        <ul className="divide-y divide-[var(--workspace-border)] border-t border-[var(--workspace-border)]">
          {team.members.map((member) => {
            const name = member.email ?? (member.role === "owner" ? "Workspace owner" : "Team member");
            const role = member.role;
            return (
              <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 py-3 last:pb-0">
                <div className="min-w-0 break-all">
                  <p className="text-sm font-medium">{name}{member.userId === userId && <span className="text-[var(--workspace-muted)]"> (you)</span>}</p>
                  <p className="mt-0.5 text-sm text-[var(--workspace-muted)]">{workspaceRoleLabel[role]}</p>
                </div>
                {role !== "owner" && (isOwner || (canInvite && role === "member")) && (
                  <MemberForm key={`${member.userId}:${role}`} workspaceId={id} userId={member.userId} role={role} canChangeRole={isOwner} />
                )}
              </li>
            );
          })}
        </ul>
      </section>
      {canInvite && (
        <section aria-labelledby="pending-invites" className={teamPanel}>
          <h2 className="font-semibold" id="pending-invites">Pending invitations</h2>
          {team.invites.length === 0 ? <p className="text-sm text-[var(--workspace-muted)]">No pending invitations.</p> : (
            <ul className="divide-y divide-[var(--workspace-border)] border-t border-[var(--workspace-border)]">
              {team.invites.map((invite) => (
                <li key={invite.id} className="flex flex-wrap items-center justify-between gap-3 py-3 last:pb-0">
                  <div className="min-w-0 break-all">
                    <p className="text-sm font-medium">{invite.email}</p>
                    <p className="mt-0.5 text-sm text-[var(--workspace-muted)]">
                      {workspaceRoleLabel[invite.role]} · Expires <time dateTime={invite.expiresAt}>{expiration.format(new Date(invite.expiresAt))} UTC</time>
                    </p>
                  </div>
                  {(isOwner || invite.role === "member") && <RevokeInviteForm workspaceId={id} inviteId={invite.id} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
