import { createHash } from "node:crypto";
import { createClerkClient } from "@clerk/backend";
import { digestCadence, priceSession } from "@tideline/contracts";
import type { DigestCadence } from "@tideline/contracts";
import { buildDigest, digestDays, digestReport, digestWeeks } from "@tideline/contracts/digest";
import { createDigestDeliveryStore } from "@tideline/db/digest-delivery";
import type { createSessionStore } from "@tideline/db/sessions";

const minute = 60_000;

function privateServiceUrl(value: string | undefined, key: string) {
  const url = URL.parse(value ?? "");
  const loopback = url?.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!url || (url.protocol !== "https:" && !loopback) || url.username || url.password || url.hash) {
    throw new Error(`${key} must be HTTPS or local HTTP.`);
  }
  return url;
}

export function createDigestDelivery(databaseUrl: string, sessions: ReturnType<typeof createSessionStore>, clock = () => new Date()) {
  const { TIDELINE_DIGEST_MAIL_URL, TIDELINE_DIGEST_MAIL_TOKEN, TIDELINE_WEB_ORIGIN, CLERK_SECRET_KEY } = process.env;
  if (!TIDELINE_DIGEST_MAIL_URL && !TIDELINE_DIGEST_MAIL_TOKEN) return;
  const mailUrl = privateServiceUrl(TIDELINE_DIGEST_MAIL_URL, "TIDELINE_DIGEST_MAIL_URL");
  const webOrigin = privateServiceUrl(TIDELINE_WEB_ORIGIN, "TIDELINE_WEB_ORIGIN");
  if (!TIDELINE_DIGEST_MAIL_TOKEN || !/^\S+$/.test(TIDELINE_DIGEST_MAIL_TOKEN) || !CLERK_SECRET_KEY) {
    throw new Error("Scheduled digests require TIDELINE_DIGEST_MAIL_TOKEN and CLERK_SECRET_KEY.");
  }
  const clerk = createClerkClient({ secretKey: CLERK_SECRET_KEY });
  const store = createDigestDeliveryStore(databaseUrl);

  function periodsFor(cadence: DigestCadence, now: Date) {
    return cadence === "weekly" ? digestWeeks(undefined, now) : digestDays(now);
  }

  async function deliver(cadence: DigestCadence) {
    const now = clock();
    const periods = periodsFor(cadence, now);
    if (!periods) return;
    const periodStart = periods.current.from;
    const due = await store.due(cadence, periodStart, now);
    if (!due.length) return;
    const userId = [...new Set(due.map(({ recipientId }) => recipientId))];
    const { data: users } = await clerk.users.getUserList({ userId, limit: userId.length });
    const addresses = new Map(users.flatMap(({ id, primaryEmailAddress }) =>
      primaryEmailAddress?.verification?.status === "verified" ? [[id, primaryEmailAddress.emailAddress]] : []));

    for (const recipient of due) {
      const claimTime = clock();
      if (periodsFor(cadence, claimTime)?.current.from !== periodStart) break;
      const claim = await store.claim({ ...recipient, cadence, periodStart }, claimTime);
      if (!claim) continue;
      const to = addresses.get(recipient.recipientId);
      if (!to) {
        await store.complete(claim, { nextAttemptAt: new Date(clock().getTime() + 24 * 60 * minute) });
        continue;
      }

      try {
        const rows = await sessions.listReadyForDigest(recipient.workspaceId, { from: periods.prior.from, to: periods.current.to });
        const digest = buildDigest(rows.map(priceSession), periods);
        if (cadence === "daily" && !digest.current.sessions.length) continue;
        const report = digestReport(digest, cadence);
        const reportRoute = cadence === "weekly" ? `/weekly?week=${periodStart}` : `?days=1&through=${periodStart}`;
        const link = new URL(`/workspace/${recipient.workspaceId}/reports${reportRoute}`, webOrigin);
        const identity = [recipient.workspaceId, periodStart, recipient.recipientId];
        if (cadence === "daily") identity.push(cadence);
        const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
        const response = await fetch(mailUrl, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
          headers: {
            Authorization: `Bearer ${TIDELINE_DIGEST_MAIL_TOKEN}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `tideline-digest-${key}`,
          },
          body: JSON.stringify({
            to,
            subject: `${claim.name.replace(/\p{Cc}/gu, " ")} · ${report.title}`,
            markdown: `${report.markdown}\n\n[Open the private ${cadence} report](${link.href})\n`,
          }),
        });
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) throw new Error("Mail transport rejected the digest.");
      } catch (error) {
        await store.complete(claim, { nextAttemptAt: new Date(clock().getTime() + 15 * minute) });
        console.error("Tideline could not deliver a digest.", { cadence, error: error instanceof Error ? error.name : "UnknownError" });
        continue;
      }
      await store.complete(claim, { sentAt: clock() });
    }
  }

  return {
    async run() {
      for (const cadence of digestCadence.options) await deliver(cadence);
    },
    close: store.close,
  };
}
