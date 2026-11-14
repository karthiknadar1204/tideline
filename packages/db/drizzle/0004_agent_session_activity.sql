ALTER TABLE "codex_sessions" ADD COLUMN "pending_activity" jsonb;--> statement-breakpoint
ALTER TABLE "codex_sessions" ADD COLUMN "ready_activity" jsonb;