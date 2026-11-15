CREATE TABLE "github_activity_events" (
	"workspace_id" uuid NOT NULL,
	"repository_key" text NOT NULL,
	"repository" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"happened_at" timestamp with time zone NOT NULL,
	"event" jsonb NOT NULL,
	CONSTRAINT "github_activity_events_workspace_id_repository_key_kind_external_id_pk" PRIMARY KEY("workspace_id","repository_key","kind","external_id")
);
--> statement-breakpoint
ALTER TABLE "github_activity_events" ADD CONSTRAINT "github_activity_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_activity_workspace_date_index" ON "github_activity_events" USING btree ("workspace_id","happened_at");