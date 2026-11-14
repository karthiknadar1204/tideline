ALTER TABLE "codex_sessions" ADD COLUMN "pending_review" jsonb;--> statement-breakpoint
ALTER TABLE "codex_sessions" ADD COLUMN "ready_review" jsonb;