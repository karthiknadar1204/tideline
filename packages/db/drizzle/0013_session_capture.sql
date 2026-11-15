ALTER TABLE "codex_sessions" ADD COLUMN "pending_capture" jsonb;--> statement-breakpoint
ALTER TABLE "codex_sessions" ADD COLUMN "ready_capture" jsonb;