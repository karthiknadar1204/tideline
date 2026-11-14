CREATE TABLE "cli_grants" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cli_grants" ADD CONSTRAINT "cli_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_workspace_receipt_index" ON "codex_sessions" USING btree ("workspace_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST);