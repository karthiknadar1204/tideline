ALTER TABLE "workspaces" ADD COLUMN "monthly_budget_cents" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "usage_goal" jsonb;