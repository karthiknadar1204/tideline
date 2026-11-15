import { z } from "zod";
import { readDay, shiftDay } from "./utc-days";
export { readDay, shiftDay, utcDay } from "./utc-days";

export const healthResponse = z.object({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponse>;

export const cliInstallConfig = z.strictObject({
  clerkIssuer: z.url({ protocol: /^https$/ }),
  oauthClientId: z.string().min(1),
});

export const workspaceCliStatus = z.strictObject({ approved: z.boolean() });

export const cliSetupCode = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const cliSetupWriter = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const repositoryCount = z.int().min(0).max(1_000_000);
const selectedCheckoutCount = z.int().min(1).max(1_000_000);
export const cliSetupTerminalProgress = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("choosing"), repositoriesFound: repositoryCount, localSessionsFound: z.int().nonnegative() }),
  z.strictObject({ phase: z.literal("approving"), checkoutsSelected: selectedCheckoutCount, history: z.boolean() }),
  z.strictObject({ phase: z.literal("ready"), checkoutsSelected: selectedCheckoutCount, background: z.boolean() }),
  z.strictObject({ phase: z.literal("cancelled") }),
  z.strictObject({ phase: z.literal("failed") }),
]);
export const cliSetupProgress = z.union([
  cliSetupTerminalProgress,
  z.strictObject({ phase: z.literal("waiting") }),
  z.strictObject({ phase: z.literal("scanning") }),
  z.strictObject({ phase: z.literal("starting"), checkoutsSelected: selectedCheckoutCount, history: z.boolean() }),
]);
export const cliSetupSnapshot = z.strictObject({
  id: z.uuid(),
  expiresAt: z.iso.datetime(),
  progress: cliSetupProgress,
});
export const cliSetupCreated = z.strictObject({ ...cliSetupSnapshot.shape, code: cliSetupCode });
export const cliSetupBrowserConnection = cliSetupSnapshot.extend({ command: z.string().min(1).max(600).optional() });
export const cliSetupClaim = z.strictObject({ code: cliSetupCode, writer: cliSetupWriter });
export const cliSetupClaimed = z.strictObject({ id: z.uuid(), workspaceId: z.uuid() });
export const cliSetupAuthorization = cliSetupClaimed.extend({ userId: z.string().min(1) });
export type CliSetupProgress = z.infer<typeof cliSetupProgress>;
export type CliSetupTerminalProgress = z.infer<typeof cliSetupTerminalProgress>;
export type CliSetupBrowserConnection = z.infer<typeof cliSetupBrowserConnection>;

export const workspaceResponse = z.object({
  id: z.uuid(),
  name: z.string().min(1),
});

export type WorkspaceResponse = z.infer<typeof workspaceResponse>;

export const billingSubscriptionStatus = z.enum([
  "incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused",
]);
export const billingPriceId = z.string().regex(/^price_[A-Za-z0-9]+$/u).max(120);
export const billingCheckoutRequest = z.strictObject({ priceId: billingPriceId });
export const workspaceBilling = z.strictObject({
  available: z.boolean(),
  hasCustomer: z.boolean(),
  pendingCheckout: z.boolean(),
  prices: z.array(z.strictObject({
    id: billingPriceId,
    name: z.string().min(1).max(200),
    interval: z.enum(["day", "week", "month", "year"]),
    intervalCount: z.int().positive(),
  })),
  subscription: z.strictObject({
    status: billingSubscriptionStatus,
    priceId: billingPriceId,
    cancelAtPeriodEnd: z.boolean(),
  }).nullable(),
});
export const billingRedirect = z.strictObject({ url: z.url({ protocol: /^https$/u, hostname: /^(?:billing|checkout)\.stripe\.com$/u }) });
export type BillingSubscriptionStatus = z.infer<typeof billingSubscriptionStatus>;

export const workspaceNameUpdate = z.strictObject({
  name: z.string().trim().min(1).max(80).refine((name) => !/\p{Cc}/u.test(name)),
});
export type WorkspaceNameUpdate = z.infer<typeof workspaceNameUpdate>;
export const confirmWorkspaceDeletion = z.strictObject({ name: z.string().min(1).max(80) });
export const workspaceAlias = z.string().trim().toLowerCase().min(3).max(48)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).refine((alias) => !workspaceResponse.shape.id.safeParse(alias).success);
export const workspaceAddress = z.strictObject({ id: workspaceResponse.shape.id, alias: workspaceAlias.nullable() });
export const workspaceAliasUpdate = z.strictObject({ alias: workspaceAlias });
export type WorkspaceAddress = z.infer<typeof workspaceAddress>;
export const accountDeletionStatus = z.strictObject({
  retiring: z.boolean(),
  ownedTeams: z.array(workspaceResponse),
});
export const confirmAccountDeletion = z.strictObject({ confirmation: z.literal("DELETE") });
export const clerkOrganizationId = z.string().regex(/^org_[A-Za-z0-9]+$/).max(120);
export const workspaceClerkDirectory = z.strictObject({ configured: z.boolean(), organizationId: clerkOrganizationId.nullable() });
export const workspaceClerkDirectoryLink = z.strictObject({ organizationId: clerkOrganizationId });

export const teamMemberRole = z.enum(["admin", "member"]);
export const workspaceRole = z.enum(["owner", ...teamMemberRole.options]);
export const workspaceKind = z.enum(["personal", "team"]);
export const workspaceAccess = workspaceResponse.extend({ kind: workspaceKind, role: workspaceRole });
export const workspaceAccessList = z.array(workspaceAccess);
export const workspaceInviteRequest = z.strictObject({
  email: z.string().trim().max(254).toLowerCase().pipe(z.email()),
  role: teamMemberRole,
});
export const workspaceInviteAcceptance = z.strictObject({ token: z.string().regex(/^[0-9a-f]{64}$/) });
export const workspaceInviteLink = workspaceInviteAcceptance.extend({ id: z.uuid() });
export const workspaceMemberUpdate = z.strictObject({ role: teamMemberRole });
export const workspaceTeam = z.strictObject({
  members: z.array(z.strictObject({ userId: z.string().min(1), email: z.email().nullable(), role: workspaceRole, directoryManaged: z.boolean().optional() })),
  invites: z.array(workspaceInviteRequest.extend({ id: z.uuid(), expiresAt: z.iso.datetime() })),
});

export type WorkspaceAccess = z.infer<typeof workspaceAccess>;
export type WorkspaceTeam = z.infer<typeof workspaceTeam>;
export type WorkspaceRole = z.infer<typeof workspaceRole>;
export type TeamMemberRole = z.infer<typeof teamMemberRole>;

export const savedReportVisibility = z.enum(["private", "workspace"]);
const reportTitle = z.string().trim().min(1).max(120).refine((title) => !/\p{Cc}/u.test(title));
const reportMarkdown = z.string().trim().min(1).max(20_000).refine((markdown) => !markdown.includes("\0"));
export const MAX_REPORT_SESSION_REFERENCES = 25;
const reportSessionIds = z.array(z.uuid().toLowerCase()).max(MAX_REPORT_SESSION_REFERENCES)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Session references must be unique." });

export const saveReportRequest = z.strictObject({
  title: reportTitle,
  markdown: reportMarkdown,
  visibility: savedReportVisibility.default("private"),
  sessionIds: reportSessionIds.default([]),
});

export const SAVED_REPORT_PAGE_SIZE = 20;
export const savedReportPage = z.string().regex(/^[1-9][0-9]*$/).default("1").transform(Number)
  .pipe(z.int().min(1).max(Math.floor(Number.MAX_SAFE_INTEGER / SAVED_REPORT_PAGE_SIZE)));
export const savedReportSummary = z.strictObject({
  id: z.uuid(),
  title: reportTitle,
  visibility: savedReportVisibility,
  createdAt: z.iso.datetime(),
  sessionIds: reportSessionIds,
  isAuthor: z.boolean(),
});
export const savedReportDetail = savedReportSummary.extend({ markdown: reportMarkdown });
export const savedReportList = z.strictObject({
  reports: z.array(savedReportSummary).max(SAVED_REPORT_PAGE_SIZE),
  nextPage: z.int().positive().nullable(),
});

export type SaveReportRequest = z.infer<typeof saveReportRequest>;
export type SavedReportSummary = z.infer<typeof savedReportSummary>;
export type SavedReportDetail = z.infer<typeof savedReportDetail>;
export type SavedReportList = z.infer<typeof savedReportList>;

export const digestCadence = z.enum(["weekly", "daily"]);
export type DigestCadence = z.infer<typeof digestCadence>;
export const digestSchedule = z.strictObject({
  weekday: z.int().min(0).max(6),
  hourUtc: z.int().min(0).max(23),
  recipientIds: z.array(z.string().regex(/^user_[A-Za-z0-9]+$/).max(96)).min(1).max(25)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const digestSettings = z.strictObject({
  schedule: digestSchedule.nullable(),
  lastDeliveredAt: z.iso.datetime().nullable(),
});
export const digestSettingsUpdate = digestSettings.pick({ schedule: true });
export const weeklyDigestRange = z.strictObject({
  from: z.iso.date().refine((day) => day >= "0001-01-01"),
  to: z.iso.date(),
}).refine(({ from, to }) => Boolean(readDay(from) && new Date(from).getUTCDay() === 1 &&
  from <= "9999-12-18" && shiftDay(from, 13) === to));
export type DigestSchedule = z.infer<typeof digestSchedule>;

export const MAX_CODEX_IMPORT_BYTES = 1_048_576;
export const MAX_CLI_RELEASE_BYTES = 8 * 1024 * 1024;
export const cliRelease = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  size: z.int().positive().max(MAX_CLI_RELEASE_BYTES),
});

const repository = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
});
const githubRepositorySlug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/u);
const githubEventFields = {
  id: z.union([z.string().regex(/^[1-9]\d{0,19}$/u), z.int().positive()]).transform(String),
  title: z.string().min(1).max(240),
  at: z.iso.datetime(),
};
export const githubActivityEvent = z.discriminatedUnion("kind", [
  z.strictObject({ ...githubEventFields, kind: z.literal("merge"), status: z.literal("merged") }),
  z.strictObject({ ...githubEventFields, kind: z.literal("ci"), status: z.string().regex(/^[a-z][a-z_]{0,31}$/u) }),
]);
export const githubActivityUpload = z.strictObject({
  repository: githubRepositorySlug,
  events: z.array(githubActivityEvent).max(200),
}).refine(({ events }) => new Set(events.map(({ kind, id }) => `${kind}:${id}`)).size === events.length);
export const githubActivitySyncUpload = githubActivityUpload.safeExtend({ workspaceId: workspaceResponse.shape.id });
export const githubActivityRows = z.array(z.strictObject({ repository: githubRepositorySlug, event: githubActivityEvent })).max(1_000);
export const githubActivityResponse = z.strictObject({
  events: githubActivityRows,
  counts: z.strictObject({ merge: z.int().nonnegative(), ci: z.int().nonnegative() }),
  hasMore: z.boolean(),
});
export const githubActivityReceipt = z.strictObject({ received: z.int().nonnegative().max(200) });
export const githubActivityQuery = z.strictObject({
  repository: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  repoName: repository.shape.name.optional(),
  kind: z.enum(["ci", "merge"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).refine(({ from, to }) => !from || !to || from <= to);
export type GitHubActivityEvent = z.infer<typeof githubActivityEvent>;
export type GitHubActivityUpload = z.infer<typeof githubActivityUpload>;
export type GitHubActivityRows = z.infer<typeof githubActivityRows>;
export type GitHubActivityQuery = z.infer<typeof githubActivityQuery>;
export const MAX_CODEX_IMPORT_EVENTS = 500;

export const sessionSource = z.enum(["codex", "claude-code", "cursor", "opencode"]);
export const linkSavedReportSessionRequest = z.strictObject({
  sessionId: z.uuid().toLowerCase(),
  source: sessionSource.optional(),
});
export const linkSavedReportSessionResponse = z.strictObject({
  report: savedReportSummary,
  sessionId: z.uuid(),
  linked: z.boolean(),
});
export type LinkSavedReportSessionRequest = z.infer<typeof linkSavedReportSessionRequest>;
export type LinkSavedReportSessionResponse = z.infer<typeof linkSavedReportSessionResponse>;
export const sessionSourceLabel = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
} satisfies Record<z.infer<typeof sessionSource>, string>;

export const MAX_INVENTORY_SESSIONS = 5_000;
export const MAX_INVENTORY_REPOSITORIES = 1_000;
export const syncInventoryUpload = z.strictObject({
  workspaceId: z.uuid(),
  version: cliRelease.shape.version,
  partial: z.boolean(),
  sessions: z.array(z.strictObject({ source: sessionSource, id: z.uuid(), startedAt: z.iso.datetime() })).max(MAX_INVENTORY_SESSIONS),
  repositorySettings: z.strictObject({ complete: z.boolean(), rows: z.array(repository.extend({ enabled: z.boolean() })).max(MAX_INVENTORY_REPOSITORIES) })
    .refine(({ rows }) => new Set(rows.map(({ key }) => key)).size === rows.length).optional(),
}).refine(({ sessions }) => new Set(sessions.map(({ source, id }) => `${source}:${id}`)).size === sessions.length);
export const syncInventoryUpdate = z.union([syncInventoryUpload, z.strictObject({ workspaceId: z.uuid(), clear: z.literal(true) })]);
export const syncCoverageResponse = z.strictObject({
  collectors: z.int().nonnegative(),
  reportedAt: z.iso.datetime().nullable(),
  partial: z.boolean(),
  known: z.int().nonnegative(),
  ready: z.int().nonnegative(),
  pending: z.int().nonnegative(),
});
export type SyncInventoryUpload = z.infer<typeof syncInventoryUpload>;
export type SyncInventoryUpdate = z.infer<typeof syncInventoryUpdate>;
export const repositorySyncResponse = z.array(repository.extend({
  sessions: z.int().nonnegative(),
  state: z.enum(["enabled", "paused", "unreported"]),
}));

export const usageTargetCents = z.int().positive().max(2_000_000_000);
const usageGoalScope = z.enum(["all", ...sessionSource.options]);
const usageGoalFields = {
  scope: usageGoalScope,
  period: z.enum(["week", "month"]),
  direction: z.enum(["at-most", "at-least"]),
};

export const usageGoal = z.discriminatedUnion("metric", [
  z.strictObject({ ...usageGoalFields, metric: z.literal("tokens"), target: z.int().positive().max(1_000_000_000_000) }),
  z.strictObject({ ...usageGoalFields, metric: z.literal("cost"), target: usageTargetCents }),
]);

export const workspaceUsageTargets = z.strictObject({
  monthlyBudgetCents: usageTargetCents.nullable(),
  goal: usageGoal.nullable(),
});

export const workspaceUsageTargetUpdate = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("budget"), value: workspaceUsageTargets.shape.monthlyBudgetCents }),
  z.strictObject({ kind: z.literal("goal"), value: workspaceUsageTargets.shape.goal }),
]);

export type UsageGoal = z.infer<typeof usageGoal>;
export type WorkspaceUsageTargets = z.infer<typeof workspaceUsageTargets>;
export type WorkspaceUsageTargetUpdate = z.infer<typeof workspaceUsageTargetUpdate>;

export const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const tokenCount = z.int().nonnegative().max(1_000_000_000_000);
export const modelTokens = z.strictObject({
  input: tokenCount,
  cachedInput: tokenCount,
  cacheWrite5m: tokenCount,
  cacheWrite1h: tokenCount,
  cacheWriteUnknown: tokenCount,
  output: tokenCount,
});
const modelUsage = z.strictObject({
  model: modelId.nullable(),
  tokens: modelTokens.nullable(),
});
const tokenCoverage = z.enum(["reported", "partial", "unavailable"]);
const sessionAnalytics = z.strictObject({
  throughLine: z.int().positive(),
  repository: repository.nullable(),
  models: z.array(modelUsage).max(512).refine(
    (models) => new Set(models.map(({ model }) => model)).size === models.length,
    { message: "Model usage must contain at most one entry per model." },
  ),
  tokenCoverage,
}).refine(
  ({ models, tokenCoverage }) => models.some(({ tokens }) => tokens !== null) === (tokenCoverage !== "unavailable"),
  { path: ["tokenCoverage"], message: "Token coverage must reflect whether usage was reported." },
);

export const MAX_SESSION_ACTIVITY_ITEMS = 250;
export const activityName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/);
export const codexSkillInstructions = /^<skill>\r?\n<name>([^\r\n<>]+)<\/name>\r?\n<path>[^\r\n<>]+<\/path>[\s\S]*?\r?\n<\/skill>$/u;
export const codexSkillCatalog = /^<skills_instructions>[^]*<\/skills_instructions>$/u;
const activityLocation = z.strictObject({ line: z.int().positive(), index: z.int().nonnegative() });

export const MAX_SESSION_CAPTURE_BYTES = 512 * 1024;
export const MAX_SESSION_CAPTURE_TEXT = 96 * 1024;
export const MAX_SESSION_CAPTURE_FILES = 250;
export const MAX_SESSION_SUBAGENT_BYTES = 96 * 1024;
export const MAX_SESSION_SUBAGENTS = 10;
export const MAX_SUBAGENT_DEPTH = 4;
export const MAX_SUBAGENT_TRANSCRIPT_BYTES = 8 * 1024;
export const MAX_SUBAGENT_MESSAGES = 40;

const captureText = z.string().max(MAX_SESSION_CAPTURE_TEXT).refine((text) => !/[\0\uD800-\uDFFF]/u.test(text));
const setupValue = z.string().min(1).max(180).refine((text) => !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(text));
const capturePath = z.string().min(1).max(512).refine((path) => (
  !/[\\\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(path) &&
  !/^[A-Za-z]:/u.test(path) &&
  path.split("/").every((part) => part && part !== ".." && part !== ".")
), { message: "Use a repository-relative path." });
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const claudeSubagentId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const subagentStatus = z.enum(["started", "running", "completed", "failed", "stopped", "unknown"]);
const sessionSubagent = activityLocation.extend({
  agentId: claudeSubagentId,
  parentAgentId: claudeSubagentId.optional(),
  name: activityName.nullable().optional(),
  status: subagentStatus.optional(),
  throughLine: z.int().positive(),
  truncated: z.boolean(),
  messages: z.array(z.strictObject({
    line: z.int().positive(),
    role: z.enum(["user", "assistant"]),
    text: captureText.min(1).max(MAX_SUBAGENT_TRANSCRIPT_BYTES),
    timestamp: z.iso.datetime(),
  })).max(MAX_SUBAGENT_MESSAGES),
}).refine(({ messages, throughLine }) => messages.every(({ line }, index) => line <= throughLine &&
  (index === 0 || line > messages[index - 1].line)), { message: "Subagent messages must follow their source order." })
  .refine((transcript) => jsonBytes(transcript) <= MAX_SUBAGENT_TRANSCRIPT_BYTES, { message: "A subagent transcript exceeds 8 KiB." });

const sessionSubagents = z.strictObject({
  source: z.enum(["claude-code-sidecar", "codex-rollout"]),
  truncated: z.boolean(),
  transcripts: z.array(sessionSubagent).max(MAX_SESSION_SUBAGENTS),
}).refine(({ transcripts }) => {
  const ancestry = new Map<string, { depth: number; throughLine: number }>();
  const calls = new Set<string>();
  for (const { agentId, parentAgentId, throughLine, line, index } of transcripts) {
    const parent = parentAgentId && ancestry.get(parentAgentId);
    if (parentAgentId && (!parent || parent.depth >= MAX_SUBAGENT_DEPTH || line > parent.throughLine)) return false;
    const call = `${parentAgentId ?? ""}:${line}:${index}`;
    if (ancestry.has(agentId) || calls.has(call)) return false;
    calls.add(call);
    ancestry.set(agentId, { depth: parent ? parent.depth + 1 : 1, throughLine });
  }
  return true;
}, { message: "Subagent transcripts must belong to distinct calls in their parent logs." });

export const sessionCapture = z.strictObject({
  throughLine: z.int().positive(),
  truncated: z.boolean(),
  tools: z.array(activityLocation.extend({
    input: captureText.nullable(),
    output: captureText.nullable(),
    truncated: z.boolean(),
  })).max(MAX_SESSION_ACTIVITY_ITEMS),
  files: z.array(activityLocation.extend({
    path: capturePath,
    previousPath: capturePath.nullable(),
    change: z.enum(["added", "modified", "deleted", "renamed"]),
    diff: captureText.nullable(),
    truncated: z.boolean(),
  })).max(MAX_SESSION_CAPTURE_FILES),
  setup: z.strictObject({
    clientVersion: setupValue.optional(),
    entrypoint: setupValue.optional(),
    branch: setupValue.optional(),
    provider: setupValue.optional(),
    model: setupValue.optional(),
    reasoningEffort: setupValue.optional(),
    approvalPolicy: setupValue.optional(),
    sandboxMode: setupValue.optional(),
    permissionMode: setupValue.optional(),
  }),
  subagents: sessionSubagents.optional(),
}).refine(({ tools, files, subagents, throughLine }) => (
  tools.every(({ line }) => line <= throughLine) &&
  files.every(({ line }) => line <= throughLine) &&
  (!subagents || subagents.transcripts.every(({ line, parentAgentId }) => parentAgentId || line <= throughLine)) &&
  new Set(tools.map(({ line, index }) => `${line}:${index}`)).size === tools.length &&
  new Set(files.map(({ line, index, path }) => `${line}:${index}:${path}`)).size === files.length
), { message: "Session details must have unique locations covered by their source cursor." })
  .refine(({ subagents, ...capture }) => jsonBytes(capture) <= MAX_SESSION_CAPTURE_BYTES, {
    message: "Session details exceed 512 KiB.",
  }).refine(({ subagents }) => !subagents || jsonBytes(subagents) <= MAX_SESSION_SUBAGENT_BYTES, {
    message: "Subagent conversations exceed 96 KiB.",
  });

export type SessionCapture = z.infer<typeof sessionCapture>;

function activityRows<T extends z.ZodType>(row: T) {
  return z.array(row).max(MAX_SESSION_ACTIVITY_ITEMS);
}

const activityDetail = z.strictObject({
  truncated: z.boolean(),
  tools: activityRows(activityLocation.extend({
    name: activityName,
    mcpServer: activityName.optional(),
    status: z.enum(["called", "returned", "failed"]),
  })),
  skills: activityRows(activityLocation.extend({
    name: activityName,
    status: z.enum(["invoked", "requested", "failed"]),
  })),
  children: activityRows(activityLocation.extend({
    name: activityName.nullable(),
    status: subagentStatus,
  })),
});

const sessionActivity = activityDetail.extend({ throughLine: z.int().positive() }).refine((activity) => (
  [activity.tools, activity.skills, activity.children].every((rows) =>
    rows.every(({ line }) => line <= activity.throughLine) &&
    new Set(rows.map(({ line, index }) => `${line}:${index}`)).size === rows.length,
  )
), { message: "Activity locations must be unique and covered by the source cursor." });

const activityCounts = z.strictObject({
  tools: z.int().min(0).max(MAX_SESSION_ACTIVITY_ITEMS),
  skills: z.int().min(0).max(MAX_SESSION_ACTIVITY_ITEMS),
  children: z.int().min(0).max(MAX_SESSION_ACTIVITY_ITEMS),
  truncated: z.boolean(),
});

export const MAX_SESSION_COMMITS = 30;
export const MAX_SESSION_FINDINGS = 100;
const commitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const pathSegment = "[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}";
const gitHubCommitPath = new RegExp(`^/${pathSegment}/${pathSegment}/commit/([0-9a-f]+)$`);
const gitLabCommitPath = new RegExp(`^/(?:${pathSegment}/)+${pathSegment}/-/commit/([0-9a-f]+)$`);

export const commitLink = z.strictObject({
  sha: commitSha,
  line: z.int().positive(),
  url: z.string().max(512).nullable(),
}).refine(({ sha, url }) => {
  if (url === null) return true;
  for (const [origin, path] of [["https://github.com", gitHubCommitPath], ["https://gitlab.com", gitLabCommitPath]] as const) {
    if (url.startsWith(origin) && path.exec(url.slice(origin.length))?.[1] === sha) return true;
  }
  return false;
}, { path: ["url"], message: "Use a canonical HTTPS commit link for the verified SHA." });

const safetyFinding = z.strictObject({
  rule: z.enum(["possible-credential", "force-push", "hard-reset", "git-clean", "recursive-delete", "remote-shell"]),
  line: z.int().positive(),
});

const reviewDetail = z.strictObject({
  commits: z.array(commitLink).max(MAX_SESSION_COMMITS),
  findings: z.array(safetyFinding).max(MAX_SESSION_FINDINGS),
  truncated: z.boolean(),
});

const sessionReview = reviewDetail.extend({ throughLine: z.int().positive() }).refine(({ commits, findings, throughLine }) => (
  commits.every(({ line }) => line <= throughLine) && findings.every(({ line }) => line <= throughLine) &&
  new Set(commits.map(({ sha }) => sha)).size === commits.length &&
  new Set(findings.map(({ rule, line }) => `${rule}:${line}`)).size === findings.length
), { message: "Review entries must be unique and covered by the source cursor." });

const conversationMessage = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string().trim().min(1).max(32_000).refine(
    (text) => !text.includes("\0") && !/[\uD800-\uDFFF]/u.test(text),
    { message: "Message text must be valid Unicode without null characters." },
  ),
  line: z.int().positive(),
  timestamp: z.iso.datetime(),
});

export const sessionImportRequest = z.strictObject({
  version: z.literal(1),
  workspaceId: workspaceResponse.shape.id,
  session: z.strictObject({
    source: sessionSource.default("codex"),
    sourceSessionId: z.uuid(),
    startedAt: z.iso.datetime(),
    events: z.array(conversationMessage).min(1).max(MAX_CODEX_IMPORT_EVENTS).refine(
      (events) => events.every((event, index) => index === 0 || events[index - 1].line < event.line),
      { message: "Messages must be in source line order." },
    ),
    analytics: sessionAnalytics.optional(),
    activity: sessionActivity.optional(),
    review: sessionReview.optional(),
    capture: sessionCapture.optional(),
  }).refine(
    ({ analytics, events }) => !analytics || analytics.throughLine >= (events.at(-1)?.line ?? 0),
    { path: ["analytics", "throughLine"], message: "Analytics must cover the last conversation message." },
  ).refine(
    ({ activity, events }) => !activity || activity.throughLine >= (events.at(-1)?.line ?? 0),
    { path: ["activity", "throughLine"], message: "Activity must cover the last conversation message." },
  ).refine(
    ({ review, events }) => !review || review.throughLine >= (events.at(-1)?.line ?? 0),
    { path: ["review", "throughLine"], message: "Review must cover the last conversation message." },
  ).refine(
    ({ activity, capture, source, events }) => !capture || (
      (source === "codex" || source === "claude-code") && capture.throughLine >= (events.at(-1)?.line ?? 0) &&
      (!capture.subagents || (capture.subagents.source === (source === "codex" ? "codex-rollout" : "claude-code-sidecar") &&
        capture.subagents.transcripts.every(({ line, index, parentAgentId }) => parentAgentId ||
          activity?.children.some((child) => child.line === line && child.index === index))))
    ),
    { path: ["capture"], message: "Session details must cover the conversation and come from a supported agent." },
  ),
});

export const codexImportResponse = z.strictObject({
  id: z.uuid(),
  alreadyReceived: z.boolean(),
});

const sessionSummaryResponse = z.strictObject({
  id: z.uuid(),
  source: sessionSource,
  startedAt: z.iso.datetime(),
  title: z.string().min(1).max(100),
  messageCount: z.int().positive(),
  activityCounts: activityCounts.nullable(),
  analytics: z.strictObject({
    repository: repository.nullable(),
    tokenCoverage,
    models: z.array(modelUsage.extend({
      estimatedCostUsd: z.number().nonnegative().nullable(),
    })),
  }).nullable(),
});

export const sessionSummariesResponse = z.array(sessionSummaryResponse);
export const weeklyDigestSessionsResponse = z.array(sessionSummaryResponse.extend({ recordedToolFailure: z.boolean() }));
export type DigestSessionSummary = z.infer<typeof weeklyDigestSessionsResponse>[number];
export const workspaceTrendsQuery = z.strictObject({ from: z.iso.date(), to: z.iso.date() })
  .refine(({ from, to }) => readDay(from) && readDay(to) && from >= "0001-01-01" && from <= to &&
    Date.parse(to) - Date.parse(from) < 180 * 86_400_000);
export const workspaceTrendsSessions = z.array(sessionSummaryResponse.extend({
  recordedToolFailure: z.boolean(),
  reportedFrustration: z.boolean(),
}));
export type WorkspaceTrendsSession = z.infer<typeof workspaceTrendsSessions>[number];
export const workspaceInsightSessionSummariesResponse = z.array(sessionSummaryResponse.extend({
  member: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("active"), id: z.string().min(1) }),
    z.strictObject({ kind: z.literal("former") }),
    z.strictObject({ kind: z.literal("unknown") }),
  ]),
  reportedFrustration: z.boolean(),
}));
export type WorkspaceInsightSessionSummary = z.infer<typeof workspaceInsightSessionSummariesResponse>[number];
export const sessionDetailResponse = sessionSummaryResponse.extend({
  sourceSessionId: z.uuid(),
  messages: z.array(conversationMessage).min(1).max(MAX_CODEX_IMPORT_EVENTS),
  activity: activityDetail.nullable(),
  review: reviewDetail.nullable(),
});

export const workspaceSessionDetailResponse = sessionDetailResponse.extend({ capture: sessionCapture.nullable() });
export type WorkspaceSessionDetail = z.infer<typeof workspaceSessionDetailResponse>;
export const cliSessionExport = sessionDetailResponse.extend({ capture: sessionCapture.nullish() });
export type CliSessionExport = z.infer<typeof cliSessionExport>;

export const sessionShareToken = z.string().regex(/^tdshare_[0-9a-f]{64}$/);

export const createSessionShareRequest = z.strictObject({
  messageCount: z.int().positive().max(MAX_CODEX_IMPORT_EVENTS),
  lastMessageLine: conversationMessage.shape.line,
});

export const sessionShareStatus = z.strictObject({ token: sessionShareToken.nullable() });

export const sharedSessionSnapshot = z.strictObject({
  ...sessionDetailResponse.pick({ title: true, source: true, startedAt: true }).shape,
  messages: z.array(conversationMessage.pick({ role: true, text: true })).min(1).max(MAX_CODEX_IMPORT_EVENTS),
});

export type CreateSessionShareRequest = z.infer<typeof createSessionShareRequest>;
export type SharedSessionSnapshot = z.infer<typeof sharedSessionSnapshot>;

export const syncEnrollmentRequest = z.strictObject({
  workspaceId: workspaceResponse.shape.id,
});

export const syncEnrollmentResponse = z.strictObject({
  token: z.string().regex(/^tdsync_[0-9a-f]{64}$/),
  expiresAt: z.iso.datetime(),
  userId: z.string().min(1).optional(),
});

export const cliAccountResponse = z.strictObject({
  userId: z.string().min(1),
  workspace: workspaceResponse,
});

export const cliLoginResponse = z.strictObject({
  token: z.string().regex(/^tdcli_[0-9a-f]{64}$/),
  expiresAt: z.iso.datetime(),
  account: cliAccountResponse,
});

const cliSessionFilterFields = {
  repo: repository.shape.name.optional(),
  source: sessionSource.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
};

function validDateRange({ from, to }: { from?: string; to?: string }) {
  return !from || !to || from <= to;
}

export const cliSessionFilters = z.strictObject(cliSessionFilterFields).refine(validDateRange);
export const cliSessionListQuery = z.strictObject({
  ...cliSessionFilterFields,
  after: z.uuid().optional(),
}).refine(validDateRange);

export const CLI_SESSION_PAGE_SIZE = 100;

export const cliSessionPageResponse = z.strictObject({
  sessions: sessionSummariesResponse.max(CLI_SESSION_PAGE_SIZE),
  nextCursor: z.uuid().nullable(),
});

export const WORKSPACE_SESSION_PAGE_SIZE = 25;

const sessionSearchRange = z.union([
  z.number(),
  z.string().max(32).regex(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/).transform(Number),
]).pipe(z.number().nonnegative().max(Number.MAX_SAFE_INTEGER));
const sessionSearchCount = sessionSearchRange.pipe(z.int());

export const workspaceSessionSearchQuery = z.strictObject({
  query: z.string().trim().max(200).refine((query) => !query.includes("\0"))
    .transform((query) => query || undefined).optional(),
  sessionId: z.uuid().toLowerCase().optional(),
  source: sessionSource.optional(),
  repository: repository.shape.key.optional(),
  model: modelId.optional(),
  member: z.string().regex(/^user_[A-Za-z0-9]+$/).max(96).optional(),
  skill: activityName.optional(),
  subagent: activityName.optional(),
  failedTools: z.enum(["yes", "no"]).optional(),
  frustration: z.literal("reported").optional(),
  minCost: sessionSearchRange.optional(),
  maxCost: sessionSearchRange.optional(),
  minTokens: sessionSearchCount.optional(),
  maxTokens: sessionSearchCount.optional(),
  minDurationMinutes: sessionSearchRange.optional(),
  maxDurationMinutes: sessionSearchRange.optional(),
  minMessages: sessionSearchCount.optional(),
  maxMessages: sessionSearchCount.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  sort: z.enum(["newest", "oldest"]).optional(),
  page: z.union([z.int(), z.string().regex(/^[1-9][0-9]*$/).transform(Number)])
    .pipe(z.int().positive()).default(1),
}).refine(validDateRange).refine(({
  minCost, maxCost, minTokens, maxTokens, minDurationMinutes, maxDurationMinutes, minMessages, maxMessages,
}) => [
  [minCost, maxCost],
  [minTokens, maxTokens],
  [minDurationMinutes, maxDurationMinutes],
  [minMessages, maxMessages],
].every(([min, max]) => min === undefined || max === undefined || min <= max));

export const workspaceSessionSearchResponse = z.strictObject({
  sessions: sessionSummariesResponse.max(WORKSPACE_SESSION_PAGE_SIZE),
  total: z.int().nonnegative(),
  page: z.int().positive(),
  repositories: z.array(repository),
  models: z.array(modelId),
});

export const workspaceSessionSearchWithFacets = workspaceSessionSearchResponse.extend({
  skills: z.array(activityName),
  subagents: z.array(activityName),
});

export const codexImportRequest = sessionImportRequest;
export type SessionImportRequest = z.infer<typeof sessionImportRequest>;
export type CodexImportRequest = z.input<typeof sessionImportRequest>;
export type SessionSource = z.infer<typeof sessionSource>;
export type SessionAnalytics = z.infer<typeof sessionAnalytics>;
export type SessionActivity = z.infer<typeof sessionActivity>;
export type SessionReview = z.infer<typeof sessionReview>;
export type SafetyFinding = z.infer<typeof safetyFinding>;
export type ModelTokens = z.infer<typeof modelTokens>;
export type SessionSummary = z.infer<typeof sessionSummaryResponse>;
export type SessionDetail = z.infer<typeof sessionDetailResponse>;
export type CliAccount = z.infer<typeof cliAccountResponse>;
export type CliSessionListQuery = z.infer<typeof cliSessionListQuery>;
export type WorkspaceSessionSearchQuery = z.infer<typeof workspaceSessionSearchQuery>;
export type WorkspaceSessionSearchResponse = z.infer<typeof workspaceSessionSearchResponse>;
export type WorkspaceSessionSearchWithFacets = z.infer<typeof workspaceSessionSearchWithFacets>;

export { estimateSessionModelCost, priceSession, standardSessionRates } from "./session-pricing";

export const workspaceActivityKind = z.enum(["skills", "mcp"]);
export const workspaceActivityQuery = z.strictObject({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  source: sessionSource.optional(),
  repository: repository.shape.key.optional(),
}).refine(validDateRange);
export const workspaceActivityResponse = z.strictObject({
  sessionCount: z.int().nonnegative(),
  coveredSessions: z.int().nonnegative(),
  truncatedSessions: z.int().nonnegative(),
  limited: z.boolean(),
  rows: z.array(z.strictObject({
    name: activityName,
    calls: z.int().positive(),
    sessions: z.int().positive(),
    failed: z.int().nonnegative(),
    latest: z.strictObject({ id: z.uuid(), at: z.iso.datetime() }),
  })).max(100),
});

export type WorkspaceActivityQuery = z.infer<typeof workspaceActivityQuery>;
export type WorkspaceActivityKind = z.infer<typeof workspaceActivityKind>;

export const repositoryKey = repository.shape.key;
export const repositoryEvidenceQuery = z.strictObject({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  source: sessionSource.optional(),
  file: capturePath.optional(),
  page: z.coerce.number().int().min(1).max(1_000).default(1),
}).refine(validDateRange);

const repositoryFileSession = z.strictObject({
  id: z.uuid(),
  title: z.string().min(1).max(100),
  source: sessionSource,
  startedAt: z.iso.datetime(),
});
const repositoryFileChange = z.enum(["added", "modified", "deleted", "renamed"]);

export const repositoryFilesResponse = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("index"),
    rows: z.array(z.strictObject({
      path: capturePath,
      change: repositoryFileChange,
      changes: z.int().positive(),
      session: repositoryFileSession,
    })).max(40),
    hasNext: z.boolean(),
    partial: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("history"),
    rows: z.array(z.strictObject({
      line: activityLocation.shape.line,
      index: activityLocation.shape.index,
      change: repositoryFileChange,
      previousPath: capturePath.nullable(),
      diff: captureText.nullable(),
      truncated: z.boolean(),
      session: repositoryFileSession,
    })).max(8),
    hasNext: z.boolean(),
    partial: z.boolean(),
  }),
]);

export const MAX_REPOSITORY_INSTRUCTION_SNAPSHOT_BYTES = 96 * 1024;
export const MAX_REPOSITORY_INSTRUCTION_FILE_BYTES = 16 * 1024;
export const MAX_REPOSITORY_INSTRUCTION_FILES = 24;
export const MAX_REPOSITORY_CONTEXT_ENTRIES = 48;
export const MAX_REPOSITORY_CONTEXT_METADATA_BYTES = 256 * 1024;
export const repositorySkillRoots = [".agents/skills", ".claude/skills", ".codex/skills", ".cursor/skills", ".opencode/skills", ".opencode/skill"] as const;
export const repositoryAgentRootExtensions = {
  ".claude/agents": ".md", ".codex/agents": ".toml", ".cursor/agents": ".md", ".opencode/agents": ".md", ".opencode/agent": ".md",
} as const;
export const repositoryConfigPaths: readonly string[] = [
  ".mcp.json", ".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml", ".cursor/mcp.json",
  ".vscode/mcp.json", "opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc",
];

export function repositoryContextKind(path: string): "skill" | "agent" | "config" | "resource" | undefined {
  if (!capturePath.safeParse(path).success || /(?:^|\/)(?:node_modules|vendor|dist|build|coverage)(?:\/|$)/iu.test(path)) return;
  if (repositoryConfigPaths.includes(path)) return "config";
  for (const [root, extension] of Object.entries(repositoryAgentRootExtensions)) {
    if (path.startsWith(`${root}/`) && path.endsWith(extension) && path.split("/").slice(2).every((part) => !part.startsWith("."))) return "agent";
  }
  const root = repositorySkillRoots.find((candidate) => path.startsWith(`${candidate}/`));
  if (!root) return;
  const parts = path.slice(root.length + 1).split("/");
  if (parts.length < 2 || parts.some((part) => part.startsWith("."))) return;
  return parts.at(-1) === "SKILL.md" ? "skill" : "resource";
}

export const repositoryInstructionPath = capturePath.refine((path) => (
  /^(?:(?!\.)[^/]+\/)*(?:(?:\.claude|\.codex)\/)?(?:AGENTS(?:\.override)?|CLAUDE(?:\.local)?)\.md$/u.test(path) &&
  !/(?:^|\/)(?:node_modules|vendor|dist|build|coverage)(?:\/|$)/iu.test(path)
));
const instructionDocument = z.strictObject({
  path: repositoryInstructionPath,
  content: captureText.max(MAX_REPOSITORY_INSTRUCTION_FILE_BYTES),
});
const repositoryRevision = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u).nullable();
const contextEntryPath = (kind: NonNullable<ReturnType<typeof repositoryContextKind>>) => capturePath.refine((path) => repositoryContextKind(path) === kind);
const contextFileMetadata = { bytes: z.int().nonnegative().max(MAX_REPOSITORY_CONTEXT_METADATA_BYTES),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u) };
const repositoryContextEntry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("skill"), path: contextEntryPath("skill"), content: instructionDocument.shape.content }),
  z.strictObject({ kind: z.literal("agent"), path: contextEntryPath("agent"), content: instructionDocument.shape.content }),
  z.strictObject({ kind: z.literal("config"), path: contextEntryPath("config"), ...contextFileMetadata }),
  z.strictObject({ kind: z.literal("resource"), path: contextEntryPath("resource"), definitionPath: contextEntryPath("skill"), ...contextFileMetadata }),
]);
const repositoryContextSnapshot = z.strictObject({ revision: repositoryRevision, partial: z.boolean(), entries: z.array(repositoryContextEntry).max(MAX_REPOSITORY_CONTEXT_ENTRIES) })
  .refine(({ entries }) => {
    const paths = new Set(entries.map(({ path }) => path));
    return paths.size === entries.length && entries.every((item) => item.kind !== "resource" || (
      paths.has(item.definitionPath) && item.path.startsWith(item.definitionPath.slice(0, -"SKILL.md".length))
    ));
  });
export const repositoryInstructionSnapshot = z.strictObject({
  revision: repositoryRevision,
  documents: z.array(instructionDocument).max(MAX_REPOSITORY_INSTRUCTION_FILES),
  partial: z.boolean(),
  context: repositoryContextSnapshot.optional(),
}).refine(({ documents }) => new Set(documents.map(({ path }) => path)).size === documents.length)
  .refine((snapshot) => jsonBytes(snapshot) <= 2 * MAX_REPOSITORY_INSTRUCTION_SNAPSHOT_BYTES);
export const repositoryInstructionUpload = z.strictObject({
  workspaceId: z.uuid(),
  repository: repositoryKey,
  snapshot: repositoryInstructionSnapshot,
  contextOnly: z.literal(true).optional(),
}).refine(({ snapshot: { context, ...instructions }, contextOnly }) => jsonBytes(instructions) <= MAX_REPOSITORY_INSTRUCTION_SNAPSHOT_BYTES &&
  (!context || jsonBytes(context) <= MAX_REPOSITORY_INSTRUCTION_SNAPSHOT_BYTES) &&
  (!contextOnly || (context !== undefined && instructions.documents.length === 0 && instructions.revision === null && !instructions.partial)));
export const repositoryInstructionsResponse = z.strictObject({
  observedAt: z.iso.datetime(),
  snapshot: repositoryInstructionSnapshot,
}).nullable();

export type RepositoryEvidenceQuery = z.infer<typeof repositoryEvidenceQuery>;
export type RepositoryInstructionUpload = z.infer<typeof repositoryInstructionUpload>;
export type RepositoryInstructionSnapshot = z.infer<typeof repositoryInstructionSnapshot>;
export type RepositoryContextEntry = z.infer<typeof repositoryContextEntry>;
export type RepositoryFilesResponse = z.infer<typeof repositoryFilesResponse>;
