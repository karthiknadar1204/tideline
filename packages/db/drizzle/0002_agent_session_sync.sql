CREATE TYPE "public"."session_source" AS ENUM('codex', 'claude-code');--> statement-breakpoint
CREATE TABLE "sync_grants" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "codex_sessions" DROP CONSTRAINT "codex_sessions_workspace_source_unique";--> statement-breakpoint
ALTER TABLE "codex_sessions" ADD COLUMN "source" "session_source" DEFAULT 'codex' NOT NULL;--> statement-breakpoint
ALTER TABLE "codex_sessions" ADD COLUMN "ready_message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_grants" ADD CONSTRAINT "sync_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codex_sessions" ADD CONSTRAINT "agent_sessions_workspace_source_unique" UNIQUE("workspace_id","source","source_session_id");
--> statement-breakpoint
UPDATE "codex_sessions" SET "ready_message_count" = jsonb_array_length("messages") WHERE "title" IS NOT NULL;
