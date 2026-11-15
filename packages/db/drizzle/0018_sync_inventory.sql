CREATE TABLE "sync_inventories" (
	"grant_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"report" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_inventories" ADD CONSTRAINT "sync_inventories_grant_hash_sync_grants_token_hash_fk" FOREIGN KEY ("grant_hash") REFERENCES "public"."sync_grants"("token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_inventories" ADD CONSTRAINT "sync_inventories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_inventories_workspace_index" ON "sync_inventories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sync_inventories_updated_index" ON "sync_inventories" USING btree ("updated_at");