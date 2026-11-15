import { auth } from "@clerk/nextjs/server";
import { digestSettings } from "@tideline/contracts";
import type { DigestCadence } from "@tideline/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { teamLink, teamPanel } from "../../../../../lib/team-ui";
import { fetchWorkspaceResource, readWorkspaceAccess, readWorkspaceTeam } from "../../../../../lib/workspace";
import { workspaceMemberLabels } from "../../../../../lib/workspace-members";
import { updateDigestSchedule } from "./actions";

const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const hours = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0") + ":00");
const dateLabel = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const inputClass = "mt-1 block min-h-10 w-full rounded-lg border border-[var(--workspace-border)] bg-[var(--workspace-bg)] px-3 text-sm focus-visible:outline-2 focus-visible:outline-[var(--workspace-accent)]";

async function readDigestSettings(workspaceId: string, cadence: DigestCadence) {
  const response = await fetchWorkspaceResource(`${encodeURIComponent(workspaceId)}/${cadence}-digest/settings`);
  if (!response?.ok) throw new Error("Could not open digest settings.");
  return digestSettings.parse(await response.json());
}

function DigestScheduleForm({ id, cadence, recipients, viewerId, settings, status }: {
  id: string;
  cadence: DigestCadence;
  recipients: ReadonlyMap<string, string>;
  viewerId: string;
  settings: Awaited<ReturnType<typeof readDigestSettings>>;
  status?: string | string[];
}) {
  const { schedule, lastDeliveredAt } = settings;
  const weekly = cadence === "weekly";
  const day = weekly && schedule ? days[schedule.weekday] : "weekdays";
  const selected = new Set(schedule?.recipientIds ?? [viewerId]);
  const inactiveCount = [...selected].filter((id) => !recipients.has(id)).length;

  return (
    <section className={teamPanel} aria-labelledby={`${cadence}-digest-delivery`}>
      <h2 id={`${cadence}-digest-delivery`} className="font-semibold">{weekly ? "Weekly digest email" : "Daily digest email"}</h2>
      <p className="text-sm leading-relaxed text-[var(--workspace-muted)]">
        {weekly ? "Send a report for the last completed UTC week." : "Send on weekdays when the previous UTC workday had synced sessions."}
        {" "}<Link className={teamLink} href={`/workspace/${id}/reports${weekly ? "/weekly" : ""}`}>{weekly ? "View the digest" : "View usage reports"}</Link>
      </p>
      <p className="text-sm text-[var(--workspace-muted)]">
        {schedule ? `Scheduled for ${day} at ${hours[schedule.hourUtc]} UTC.` : "Email delivery is off."}
        {lastDeliveredAt && <> Last delivery {dateLabel.format(new Date(lastDeliveredAt))} UTC.</>}
      </p>
      <form className="space-y-4 border-t border-[var(--workspace-border)] pt-3" action={updateDigestSchedule.bind(null, id, cadence)}>
        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          {weekly && (
            <div className="text-sm font-medium">
              <label htmlFor="digest-weekday">Day of week</label>
              <select id="digest-weekday" name="weekday" className={inputClass} defaultValue={schedule?.weekday ?? 0}>
                {days.map((day, weekday) => <option value={weekday} key={day}>{day}</option>)}
              </select>
            </div>
          )}
          <div className="text-sm font-medium">
            <label htmlFor={`digest-${cadence}-hour`}>Time (UTC)</label>
            <select id={`digest-${cadence}-hour`} name="hour" className={inputClass} defaultValue={schedule?.hourUtc ?? 9}>
              {hours.map((label, hour) => <option value={hour} key={label}>{label}</option>)}
            </select>
          </div>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Recipients</legend>
          <p className="text-xs text-[var(--workspace-muted)]">Choose up to 25 current members. Digests go to their verified primary email addresses.</p>
          {[...recipients].map(([userId, label]) => (
            <label key={userId} className="flex items-center gap-2 break-all text-sm">
              <input type="checkbox" name="recipient" value={userId} defaultChecked={selected.has(userId)} />
              <span>{label}</span>
            </label>
          ))}
          {inactiveCount > 0 && <p className="text-xs text-[var(--workspace-muted)]">Former members in this schedule are skipped.</p>}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <button className="min-h-10 rounded-lg bg-[var(--workspace-button)] px-4 text-sm font-semibold text-[var(--workspace-button-text)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--workspace-accent)]" type="submit">
            {schedule ? "Save schedule" : "Enable email delivery"}
          </button>
          {schedule && <button type="submit" name="intent" value="disable" className={teamLink}>Turn off email</button>}
        </div>
        {(status === "saved" || status === "disabled") && (
          <p role="status" className="text-sm">{status === "saved" ? "Email schedule saved." : "Email delivery turned off."}</p>
        )}
        {(status === "invalid" || status === "failed") && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {status === "invalid" ? "Choose a schedule and at least one current recipient." : "Could not save the email schedule."}
          </p>
        )}
      </form>
    </section>
  );
}

export default async function DigestSettingsPage({ params, searchParams }: PageProps<"/workspace/[id]/settings/digest">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const workspace = await readWorkspaceAccess(id);
  if (workspace.role !== "owner") notFound();
  const [{ userId }, daily, weekly, team] = await Promise.all([
    auth.protect(),
    readDigestSettings(id, "daily"),
    readDigestSettings(id, "weekly"),
    workspace.kind === "team" ? readWorkspaceTeam(id) : undefined,
  ]);
  const recipients = team ? workspaceMemberLabels(team.members, userId) : new Map([[userId, "You"]]);
  return (
    <main className="grid max-w-4xl gap-4" aria-label="Digest settings">
      <div className="space-y-1.5 text-sm text-[var(--workspace-muted)]">
        <p>Digests include usage totals, repository and model names, and notable session titles. Report links require signing in to your workspace.</p>
        <p>Email requires a mail transport configured by the Tideline operator.</p>
      </div>
      <DigestScheduleForm id={id} cadence="daily" recipients={recipients} viewerId={userId} settings={daily} status={query.cadence === "daily" ? query.status : undefined} />
      <DigestScheduleForm id={id} cadence="weekly" recipients={recipients} viewerId={userId} settings={weekly} status={query.cadence === "weekly" ? query.status : undefined} />
    </main>
  );
}
