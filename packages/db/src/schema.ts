import type { TranscriptRecord } from "@tideline/contracts/transcripts";
import { savedReportVisibility as savedReportVisibilityContract, sessionSource as sessionSourceContract } from "@tideline/contracts";
import type { BillingSubscriptionStatus, CliSetupProgress, DigestCadence, GitHubActivityEvent, RepositoryInstructionSnapshot, SessionActivity, SessionAnalytics, SessionCapture, SessionImportRequest, SessionReview, SharedSessionSnapshot, SyncInventoryUpload, UsageGoal } from "@tideline/contracts";
import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const workspaceKind = pgEnum("workspace_kind", ["personal", "team"]);
export const workspaceMemberRole = pgEnum("workspace_member_role", ["admin", "member"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull(),
  kind: workspaceKind("kind").notNull().default("personal"),
  name: text("name").notNull().default("Personal workspace"),
  monthlyBudgetCents: integer("monthly_budget_cents"),
  usageGoal: jsonb("usage_goal").$type<UsageGoal>(),
}, (table) => [
  uniqueIndex("workspaces_personal_owner_unique").on(table.ownerId).where(sql`${table.kind} = 'personal'`),
  index("workspaces_owner_index").on(table.ownerId),
]);

export const workspaceBilling = pgTable("workspace_billing", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull().unique(),
  checkoutSessionId: text("checkout_session_id"),
  checkoutPriceId: text("checkout_price_id"),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  subscriptionStatus: text("subscription_status").$type<BillingSubscriptionStatus>(),
  subscriptionPriceId: text("subscription_price_id"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
}, (table) => [
  check("workspace_billing_subscription_fields", sql`num_nonnulls(${table.stripeSubscriptionId}, ${table.subscriptionStatus}, ${table.subscriptionPriceId}) in (0, 3)`),
  check("workspace_billing_checkout_fields", sql`num_nonnulls(${table.checkoutSessionId}, ${table.checkoutPriceId}) in (0, 2)`),
]);

export const stripeWebhookReceipts = pgTable("stripe_webhook_receipts", {
  eventId: text("event_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("stripe_webhook_receipts_workspace_index").on(table.workspaceId)]);

export const workspaceAliases = pgTable("workspace_aliases", {
  alias: text("alias").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  current: boolean("current").notNull().default(false),
}, (table) => [
  index("workspace_aliases_workspace_index").on(table.workspaceId),
  uniqueIndex("workspace_aliases_current_unique").on(table.workspaceId).where(sql`${table.current}`),
  check("workspace_aliases_format", sql`char_length(${table.alias}) between 3 and 48 and ${table.alias} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'`),
]);

export const accountRetirements = pgTable("account_retirements", {
  userKey: text("user_key").primaryKey(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceClerkOrganizations = pgTable("workspace_clerk_organizations", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().unique(),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
});

export const clerkDirectoryUserStates = pgTable("clerk_directory_user_states", {
  userKey: text("user_key").primaryKey(),
  blocked: boolean("blocked").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
});

export const cliSetups = pgTable("cli_setups", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  codeHash: text("code_hash").notNull().unique(),
  writerHash: text("writer_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  progress: jsonb("progress").$type<CliSetupProgress>().notNull(),
}, (table) => [index("cli_setups_expiry_index").on(table.expiresAt)]);

export const repositoryInstructions = pgTable("repository_instructions", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryKey: text("repository_key").notNull(),
  snapshot: jsonb("snapshot").$type<RepositoryInstructionSnapshot>().notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.repositoryKey] })]);

export const githubActivityEvents = pgTable("github_activity_events", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  repositoryKey: text("repository_key").notNull(),
  repository: text("repository").notNull(),
  kind: text("kind").notNull(),
  externalId: text("external_id").notNull(),
  happenedAt: timestamp("happened_at", { withTimezone: true }).notNull(),
  event: jsonb("event").$type<GitHubActivityEvent>().notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.repositoryKey, table.kind, table.externalId] }),
  index("github_activity_workspace_date_index").on(table.workspaceId, table.happenedAt),
]);

export const workspaceMembers = pgTable("workspace_members", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  email: text("email"),
  role: workspaceMemberRole("role").notNull(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  directoryObservedAt: timestamp("directory_observed_at", { withTimezone: true }),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId] }),
  index("workspace_members_user_index").on(table.userId),
]);

export const workspaceInvites = pgTable("workspace_invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: workspaceMemberRole("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  acceptedBy: text("accepted_by"),
}, (table) => [
  uniqueIndex("workspace_invites_pending_email_unique").on(table.workspaceId, table.email)
    .where(sql`${table.revokedAt} is null and ${table.acceptedBy} is null`),
  check("workspace_invites_single_outcome", sql`${table.revokedAt} is null or ${table.acceptedBy} is null`),
]);

export const sessionSource = pgEnum("session_source", [
  sessionSourceContract.enum.codex,
  ...sessionSourceContract.options.filter((source) => source !== "codex"),
]);

export const agentSessions = pgTable("codex_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  uploadedBy: text("uploaded_by"),
  source: sessionSource("source").notNull().default("codex"),
  sourceSessionId: uuid("source_session_id").notNull(),
  startedAt: text("started_at").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  messages: jsonb("messages").$type<SessionImportRequest["session"]["events"]>().notNull(),
  title: text("title"),
  readyMessageCount: integer("ready_message_count").notNull().default(0),
  pendingAnalytics: jsonb("pending_analytics").$type<SessionAnalytics>(),
  readyAnalytics: jsonb("ready_analytics").$type<SessionAnalytics>(),
  pendingActivity: jsonb("pending_activity").$type<SessionActivity>(),
  readyActivity: jsonb("ready_activity").$type<SessionActivity>(),
  pendingReview: jsonb("pending_review").$type<SessionReview>(),
  readyReview: jsonb("ready_review").$type<SessionReview>(),
  pendingCapture: jsonb("pending_capture").$type<SessionCapture>(),
  readyCapture: jsonb("ready_capture").$type<SessionCapture>(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  unique("agent_sessions_workspace_source_unique").on(table.workspaceId, table.source, table.sourceSessionId),
  index("agent_sessions_workspace_receipt_index").on(table.workspaceId, table.receivedAt.desc(), table.id.desc()),
]);

export const transcriptRecords = pgTable("session_transcript_records", {
  sessionId: uuid("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  stream: text("stream").notNull().default("main"),
  line: integer("line").notNull(),
  start: bigint("start_offset", { mode: "number" }).notNull(),
  offset: bigint("end_offset", { mode: "number" }).notNull(),
  digest: text("digest").notNull(),
  record: jsonb("record").$type<TranscriptRecord>().notNull(),
}, (table) => [primaryKey({ name: "transcript_records_pk", columns: [table.sessionId, table.stream, table.line] })]);

export const transcriptAttachments = pgTable("session_transcript_attachments", {
  sessionId: uuid("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  digest: text("digest").notNull(),
  mime: text("mime").notNull(),
  data: text("data").notNull(),
}, (table) => [primaryKey({ name: "transcript_attachments_pk", columns: [table.sessionId, table.digest] })]);

export const syncGrants = pgTable("sync_grants", {
  tokenHash: text("token_hash").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  userId: text("user_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const cliGrants = pgTable("cli_grants", {
  tokenHash: text("token_hash").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const syncInventories = pgTable("sync_inventories", {
  grantHash: text("grant_hash").primaryKey().references(() => syncGrants.tokenHash, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  report: jsonb("report").$type<SyncInventoryUpload>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("sync_inventories_workspace_index").on(table.workspaceId), index("sync_inventories_updated_index").on(table.updatedAt)]);

export const sessionShares = pgTable("session_shares", {
  sessionId: uuid("session_id").primaryKey().references(() => agentSessions.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  snapshot: jsonb("snapshot").$type<SharedSessionSnapshot>().notNull(),
});

export const savedReportVisibility = pgEnum("saved_report_visibility", savedReportVisibilityContract.enum);

export const savedReports = pgTable("saved_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull(),
  title: text("title").notNull(),
  markdown: text("markdown").notNull(),
  visibility: savedReportVisibility("visibility").notNull(),
  sessionIds: uuid("session_ids").array().notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("saved_reports_content_unique").on(table.workspaceId, table.authorId, table.contentHash),
  index("saved_reports_workspace_created_index").on(table.workspaceId, table.createdAt.desc(), table.id.desc()),
]);

export const weeklyDigestSubscriptions = pgTable("weekly_digest_subscriptions", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  cadence: text("cadence").$type<DigestCadence>().notNull().default("weekly"),
  weekday: integer("weekday").notNull(),
  hourUtc: integer("hour_utc").notNull(),
  recipientIds: text("recipient_ids").array().notNull(),
}, (table) => [
  primaryKey({ name: "digest_subscriptions_pk", columns: [table.workspaceId, table.cadence] }),
  check("weekly_digest_schedule_valid", sql`${table.weekday} between 0 and 6 and ${table.hourUtc} between 0 and 23`),
  check("weekly_digest_recipients_valid", sql`cardinality(${table.recipientIds}) between 1 and 25`),
  check("digest_subscription_cadence_valid", sql`${table.cadence} = 'weekly' or (${table.cadence} = 'daily' and ${table.weekday} = 0)`),
]);

export const weeklyDigestDeliveries = pgTable("weekly_digest_deliveries", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  cadence: text("cadence").$type<DigestCadence>().notNull().default("weekly"),
  periodStart: date("week_start").notNull(),
  recipientId: text("recipient_id").notNull(),
  attempts: integer("attempts").notNull().default(1),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (table) => [
  primaryKey({ name: "digest_deliveries_pk", columns: [table.workspaceId, table.cadence, table.periodStart, table.recipientId] }),
  check("digest_delivery_cadence_valid", sql`${table.cadence} in ('daily', 'weekly')`),
]);
