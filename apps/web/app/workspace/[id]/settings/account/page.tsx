import { SignOutButton, UserProfile } from "@clerk/nextjs";
import Link from "next/link";
import { teamLink, teamPanel } from "../../../../../lib/team-ui";
import { ThemeSettings } from "./theme-settings";

export default function AccountSettingsPage() {
  return (
    <main className="grid max-w-4xl gap-4" aria-label="Account settings">
      <section className={teamPanel} aria-labelledby="appearance-heading">
        <h2 id="appearance-heading" className="font-semibold">Appearance</h2>
        <p className="text-sm text-[var(--workspace-muted)]">Choose a theme for this browser.</p>
        <ThemeSettings />
      </section>
      <section className="grid min-w-0 gap-3" aria-labelledby="account-profile">
        <h2 id="account-profile" className="font-semibold">Profile and security</h2>
        <UserProfile routing="hash" appearance={{ elements: {
          rootBox: { width: "100%" },
          cardBox: { maxWidth: "100%", width: "100%", boxShadow: "none", border: "1px solid var(--workspace-border)" },
        } }} />
      </section>
      <section className={teamPanel} aria-labelledby="account-session">
        <h2 id="account-session" className="font-semibold">Current session</h2>
        <div><SignOutButton redirectUrl="/"><button type="button" className="min-h-9 rounded-lg border border-[var(--workspace-border)] px-3 text-sm font-medium hover:bg-[var(--workspace-subtle)]">Sign out</button></SignOutButton></div>
      </section>
      <section className={teamPanel} aria-labelledby="delete-account">
        <h2 id="delete-account" className="font-semibold">Delete account</h2>
        <Link href="/account/delete" className={teamLink}>Review account deletion</Link>
      </section>
    </main>
  );
}
