import { sessionSource as sessionSourceContract } from "@tideline/contracts";
import type { SessionActivity, SessionAnalytics, SessionImportRequest, SessionReview, SharedSessionSnapshot, UsageGoal } from "@tideline/contracts";
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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

export const workspaceMembers = pgTable("workspace_members", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  email: text("email").notNull(),
  role: workspaceMemberRole("role").notNull(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
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
}, (table) => [
  unique("agent_sessions_workspace_source_unique").on(table.workspaceId, table.source, table.sourceSessionId),
  index("agent_sessions_workspace_receipt_index").on(table.workspaceId, table.receivedAt.desc(), table.id.desc()),
]);

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

export const sessionShares = pgTable("session_shares", {
  sessionId: uuid("session_id").primaryKey().references(() => agentSessions.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  snapshot: jsonb("snapshot").$type<SharedSessionSnapshot>().notNull(),
});
