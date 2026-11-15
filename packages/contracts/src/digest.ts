import type { DigestCadence, DigestSessionSummary, SessionSummary } from "./index";
import { readDay, shiftDay, utcDay } from "./utc-days";
import { formatCost, formatCount, summarizeSession, summarizeWorkspace } from "./usage";
import type { Usage } from "./usage";

const firstWeek = "0001-01-08";
const dateLabel = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
type DigestRange = { from: string; to: string };
type DigestPeriods = { current: DigestRange; prior: DigestRange };

export function digestWeeks(requested: string | string[] | undefined, now = new Date()) {
  const latest = shiftDay(utcDay(now), -7 - (now.getUTCDay() + 6) % 7);
  const day = readDay(requested);
  const start = day && day >= firstWeek && day <= latest && new Date(day).getUTCDay() === 1 ? day : latest;
  const weekBefore = shiftDay(start, -7);
  return {
    latest,
    current: { from: start, to: shiftDay(start, 6) },
    prior: { from: weekBefore, to: shiftDay(start, -1) },
    older: weekBefore >= firstWeek ? weekBefore : undefined,
    newer: start < latest ? shiftDay(start, 7) : undefined,
  };
}

export function formatDigestWeek({ from, to }: ReturnType<typeof digestWeeks>["current"]) {
  return dateLabel.formatRange(new Date(from), new Date(to));
}

function previousWeekday(day: string) {
  return shiftDay(day, new Date(day).getUTCDay() === 1 ? -3 : -1);
}

export function digestDays(now: Date): DigestPeriods | undefined {
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return;
  const day = previousWeekday(utcDay(now));
  const priorDay = previousWeekday(day);
  return { current: { from: day, to: day }, prior: { from: priorDay, to: priorDay } };
}

export function buildDigest<Periods extends DigestPeriods>(
  allSessions: DigestSessionSummary[],
  periods: Periods,
) {
  function summarize({ from, to }: DigestRange) {
    const sessions = allSessions.filter(({ startedAt }) => {
      const day = startedAt.slice(0, 10);
      return from <= day && day <= to;
    });
    const usage = summarizeWorkspace(sessions);
    return {
      sessions,
      usage,
      errors: sessions.filter(({ recordedToolFailure }) => recordedToolFailure),
      incompleteActivity: sessions.filter(({ activityCounts }) => !activityCounts || activityCounts.truncated).length,
    };
  }

  const current = summarize(periods.current);
  const prior = summarize(periods.prior);
  const longest = [...current.sessions].sort((a, b) => b.messageCount - a.messageCount)[0];
  const highestCost = current.sessions.reduce<{ session: SessionSummary; value: number } | undefined>((highest, session) => {
    const cost = summarizeSession(session.analytics).cost.value;
    return cost !== null && (!highest || cost > highest.value) ? { session, value: cost } : highest;
  }, undefined);
  const notable = new Map<string, { session: SessionSummary; reasons: string[] }>();
  if (longest) notable.set(longest.id, { session: longest, reasons: [`Most messages · ${formatCount(longest.messageCount)}`] });
  if (highestCost && highestCost.value > 0) {
    const { session, value } = highestCost;
    const reason = `Highest recorded estimate · ${formatCost(value)}`;
    const existing = notable.get(session.id);
    if (existing) existing.reasons.push(reason);
    else notable.set(session.id, { session, reasons: [reason] });
  }

  return {
    periods,
    current,
    prior,
    repositories: current.usage.repositories.filter(({ key }) => key !== null).slice(0, 5),
    models: current.usage.models.filter(({ key }) => key !== null).slice(0, 5),
    errors: current.errors.slice(0, 5),
    notable: Array.from(notable.values()),
  };
}

function digestMetric(metric: Usage["tokens"], format: (value: number) => string) {
  if (metric.value === null) return "Unavailable";
  return `${format(metric.value)}${metric.complete ? "" : " (partial)"}`;
}

export function digestComparison({ current, prior }: ReturnType<typeof buildDigest>) {
  return [
    { label: "Sessions", value: formatCount(current.sessions.length), previous: formatCount(prior.sessions.length) },
    {
      label: "Reported tokens",
      value: digestMetric(current.usage.total.tokens, formatCount),
      previous: digestMetric(prior.usage.total.tokens, formatCount),
    },
    {
      label: "Estimated cost",
      value: digestMetric(current.usage.total.cost, formatCost),
      previous: digestMetric(prior.usage.total.cost, formatCost),
    },
    {
      label: "Sessions with recorded failures",
      value: formatCount(current.errors.length),
      previous: formatCount(prior.errors.length),
    },
  ];
}

function escapeMarkdown(value: string) {
  return value.slice(0, 250).replace(/\p{Cc}/gu, " ").replace(/[\\!`*_\[\]{}()<>#+\-.|&]/g, "\\$&");
}

export function digestReport(digest: ReturnType<typeof buildDigest>, cadence: DigestCadence) {
  const { current, prior, periods, repositories, models, errors, notable } = digest;
  const periodUnit = cadence === "weekly" ? "week" : "workday";
  const titlePrefix = cadence === "weekly" ? "Weekly digest" : "Daily digest";
  const label = cadence === "weekly" ? formatDigestWeek : ({ from }: DigestRange) => dateLabel.format(new Date(from));
  const lines = [
    `${label(periods.current)} (UTC)`,
    "",
    `Compared with ${label(periods.prior)} (UTC)`,
    "",
    ...digestComparison(digest).map(({ label, value, previous }) => `- **${label}** — ${escapeMarkdown(value)} · prior ${periodUnit} ${escapeMarkdown(previous)}`),
  ];
  if (current.incompleteActivity || prior.incompleteActivity) {
    lines.push("", `Tool activity was incomplete or unavailable for ${formatCount(current.incompleteActivity)} sessions this ${periodUnit} and ${formatCount(prior.incompleteActivity)} in the prior ${periodUnit}.`);
  }
  for (const [heading, rows] of [["Top repositories", repositories], ["Top models", models]] as const) {
    lines.push("", `## ${heading}`, "", ...(rows.length ? rows.map(({ name, sessionCount }) => `- ${escapeMarkdown(name)} — ${formatCount(sessionCount)} sessions`) : ["No data recorded."]));
  }
  lines.push("", "## Recent sessions with recorded failures", "",
    ...(errors.length ? errors.map(({ title }) => `- ${escapeMarkdown(title)}`) : ["No failures recorded."]),
    "", "## Notable sessions", "",
    ...(notable.length ? notable.map(({ session, reasons }) => `- ${escapeMarkdown(session.title)} — ${escapeMarkdown(reasons.join(" · "))}`) : [`No sessions in this ${periodUnit}.`]));
  return {
    title: `${titlePrefix} · ${periods.current.from}`,
    markdown: lines.join("\n"),
    sessionIds: [...new Set([...errors, ...notable.map(({ session }) => session)].map(({ id }) => id))],
  };
}
