import type { SessionAnalytics, SessionImportRequest } from "@tideline/contracts";
import { integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull().unique(),
  name: text("name").notNull().default("Personal workspace"),
});

export const sessionSource = pgEnum("session_source", ["codex", "claude-code"]);

export const agentSessions = pgTable("codex_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  source: sessionSource("source").notNull().default("codex"),
  sourceSessionId: uuid("source_session_id").notNull(),
  startedAt: text("started_at").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  messages: jsonb("messages").$type<SessionImportRequest["session"]["events"]>().notNull(),
  title: text("title"),
  readyMessageCount: integer("ready_message_count").notNull().default(0),
  pendingAnalytics: jsonb("pending_analytics").$type<SessionAnalytics>(),
  readyAnalytics: jsonb("ready_analytics").$type<SessionAnalytics>(),
}, (table) => [
  unique("agent_sessions_workspace_source_unique").on(table.workspaceId, table.source, table.sourceSessionId),
]);

export const syncGrants = pgTable("sync_grants", {
  tokenHash: text("token_hash").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
