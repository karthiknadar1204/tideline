ALTER TABLE "codex_sessions" ADD COLUMN "uploaded_by" text;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD COLUMN "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "removed_at" timestamp with time zone;