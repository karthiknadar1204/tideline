import { accountDeletionStatus } from "@tideline/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { teamLink, teamPanel } from "../../../lib/team-ui";
import { requestAccountDeletion } from "./account-request";
import { DeleteAccountForm } from "./form";

export const metadata: Metadata = { title: "Delete account | Tideline", referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function DeleteAccountPage() {
  const response = await requestAccountDeletion();
  const status = accountDeletionStatus.safeParse(response?.ok ? await response.json().catch(() => null) : null).data;

  return (
    <main className="tideline-workspace min-h-dvh bg-[var(--workspace-bg)] px-4 py-8 text-[var(--workspace-text)]">
      <div className="mx-auto grid max-w-xl gap-5">
        <h1 className="text-3xl font-semibold tracking-tight">Delete account</h1>
        <section className={teamPanel}>
          {!status ? <p role="alert">Account deletion is temporarily unavailable. Reload this page to try again.</p> : status.ownedTeams.length ? (
            <>
              <p className="text-sm">You own these team workspaces. They remain available to their members while your account stays active.</p>
              <ul className="list-inside list-disc space-y-2 text-sm">
                {status.ownedTeams.map((team) => <li key={team.id}><Link className={teamLink} href={`/workspace/${team.id}/settings`}>{team.name}</Link></li>)}
              </ul>
              <p className="text-sm">To proceed with account deletion, delete each owned workspace first. Workspace deletion removes it for all team members.</p>
            </>
          ) : (
            <>
              <p className="text-sm leading-relaxed">{status.retiring ? "Your Tideline account data is deleted. Complete the last step to remove your sign-in." : "This permanently deletes your sign-in, personal workspace, private reports, invitations you accepted, and access credentials. Sessions and shared reports you contributed stay in their teams with your profile attribution removed."}</p>
              <DeleteAccountForm retiring={status.retiring} />
            </>
          )}
        </section>
        {status && !status.retiring && <Link className={teamLink} href="/workspaces">Back to workspaces</Link>}
      </div>
    </main>
  );
}
