CREATE TABLE "workspace_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"current" boolean DEFAULT false NOT NULL,
	CONSTRAINT "workspace_aliases_format" CHECK (char_length("workspace_aliases"."alias") between 3 and 48 and "workspace_aliases"."alias" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "workspace_aliases" ADD CONSTRAINT "workspace_aliases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_aliases_workspace_index" ON "workspace_aliases" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_aliases_current_unique" ON "workspace_aliases" USING btree ("workspace_id") WHERE "workspace_aliases"."current";