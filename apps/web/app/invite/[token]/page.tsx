import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { workspaceInviteAcceptance } from "@tideline/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { teamButton, teamLink, teamPanel } from "../../../lib/team-ui";
import { AcceptInviteForm } from "./accept-invite-form";

export const metadata: Metadata = {
  title: "Team invitation | Tideline",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function AcceptInvitePage({ params }: PageProps<"/invite/[token]">) {
  const input = workspaceInviteAcceptance.safeParse(await params);
  if (!input.success) notFound();
  const { token } = input.data;
  const { userId } = await auth();
  const redirectQuery = new URLSearchParams({ redirect_url: `/invite/${token}` });

  return (
    <div className="tideline-workspace min-h-dvh bg-[var(--workspace-bg)] text-[var(--workspace-text)]">
      <div className="mx-auto w-full max-w-xl px-4 pb-12 sm:px-8">
        <header className="flex min-h-16 items-center justify-between border-b border-[var(--workspace-border)]">
          <Link className="font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4" href="/">Tideline</Link>
          {userId && <UserButton />}
        </header>
        <main className="pt-7 sm:pt-10">
          <section className={teamPanel} aria-labelledby="team-invitation">
            <h1 className="text-2xl font-semibold tracking-tight" id="team-invitation">Team invitation</h1>
            <p className="text-sm text-[var(--workspace-muted)]">Use the email address listed in your invitation.</p>
            {userId ? <AcceptInviteForm token={token} /> : (
              <div className="flex flex-wrap items-center gap-4">
                <Link className={teamButton} href={`/sign-in?${redirectQuery}`} prefetch={false}>Sign in</Link>
                <Link className={teamLink} href={`/sign-up?${redirectQuery}`} prefetch={false}>Create an account</Link>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
