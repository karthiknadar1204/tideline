CREATE TABLE "cli_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"writer_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"progress" jsonb NOT NULL,
	CONSTRAINT "cli_setups_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "cli_setups" ADD CONSTRAINT "cli_setups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cli_setups_expiry_index" ON "cli_setups" USING btree ("expires_at");