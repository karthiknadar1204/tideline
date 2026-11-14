import { z } from "zod";

export const healthResponse = z.object({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponse>;

export const workspaceResponse = z.object({
  id: z.uuid(),
  name: z.string().min(1),
});

export type WorkspaceResponse = z.infer<typeof workspaceResponse>;

export const workspaceNameUpdate = z.strictObject({
  name: z.string().trim().min(1).max(80).refine((name) => !/\p{Cc}/u.test(name)),
});
export type WorkspaceNameUpdate = z.infer<typeof workspaceNameUpdate>;

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
  members: z.array(z.strictObject({ userId: z.string().min(1), email: z.email().nullable(), role: workspaceRole })),
  invites: z.array(workspaceInviteRequest.extend({ id: z.uuid(), expiresAt: z.iso.datetime() })),
});

export type WorkspaceAccess = z.infer<typeof workspaceAccess>;
export type WorkspaceRole = z.infer<typeof workspaceRole>;
export type TeamMemberRole = z.infer<typeof teamMemberRole>;

export const savedReportVisibility = z.enum(["private", "workspace"]);
const reportTitle = z.string().trim().min(1).max(120).refine((title) => !/\p{Cc}/u.test(title));
const reportMarkdown = z.string().trim().min(1).max(20_000).refine((markdown) => !markdown.includes("\0"));
const reportSessionIds = z.array(z.uuid().toLowerCase()).max(25)
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

export const MAX_CODEX_IMPORT_BYTES = 1_048_576;
export const MAX_CODEX_IMPORT_EVENTS = 500;

export const sessionSource = z.enum(["codex", "claude-code", "cursor", "opencode"]);
export const sessionSourceLabel = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
} satisfies Record<z.infer<typeof sessionSource>, string>;

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

const repository = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
});

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

function activityRows<T extends z.ZodType>(row: T) {
  return z.array(row).max(MAX_SESSION_ACTIVITY_ITEMS);
}

const activityDetail = z.strictObject({
  truncated: z.boolean(),
  tools: activityRows(activityLocation.extend({
    name: activityName,
    status: z.enum(["called", "returned", "failed"]),
  })),
  skills: activityRows(activityLocation.extend({
    name: activityName,
    status: z.enum(["invoked", "requested", "failed"]),
  })),
  children: activityRows(activityLocation.extend({
    name: activityName.nullable(),
    status: z.enum(["started", "running", "completed", "failed", "stopped", "unknown"]),
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
  }).refine(
    ({ analytics, events }) => !analytics || analytics.throughLine >= (events.at(-1)?.line ?? 0),
    { path: ["analytics", "throughLine"], message: "Analytics must cover the last conversation message." },
  ).refine(
    ({ activity, events }) => !activity || activity.throughLine >= (events.at(-1)?.line ?? 0),
    { path: ["activity", "throughLine"], message: "Activity must cover the last conversation message." },
  ).refine(
    ({ review, events }) => !review || review.throughLine >= (events.at(-1)?.line ?? 0),
    { path: ["review", "throughLine"], message: "Review must cover the last conversation message." },
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
export const sessionDetailResponse = sessionSummaryResponse.extend({
  sourceSessionId: z.uuid(),
  messages: z.array(conversationMessage).min(1).max(MAX_CODEX_IMPORT_EVENTS),
  activity: activityDetail.nullable(),
  review: reviewDetail.nullable(),
});

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

export const workspaceSessionSearchQuery = z.strictObject({
  query: z.string().trim().max(200).refine((query) => !query.includes("\0"))
    .transform((query) => query || undefined).optional(),
  source: sessionSource.optional(),
  repository: repository.shape.key.optional(),
  model: modelId.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.union([z.int(), z.string().regex(/^[1-9][0-9]*$/).transform(Number)])
    .pipe(z.int().positive()).default(1),
}).refine(validDateRange);

export const workspaceSessionSearchResponse = z.strictObject({
  sessions: sessionSummariesResponse.max(WORKSPACE_SESSION_PAGE_SIZE),
  total: z.int().nonnegative(),
  page: z.int().positive(),
  repositories: z.array(repository),
  models: z.array(modelId),
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
