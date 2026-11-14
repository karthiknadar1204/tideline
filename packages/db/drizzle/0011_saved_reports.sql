CREATE TYPE "public"."saved_report_visibility" AS ENUM('private', 'workspace');--> statement-breakpoint
CREATE TABLE "saved_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"title" text NOT NULL,
	"markdown" text NOT NULL,
	"visibility" "saved_report_visibility" NOT NULL,
	"session_ids" uuid[] NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_reports_content_unique" UNIQUE("workspace_id","author_id","content_hash")
);
--> statement-breakpoint
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_reports_workspace_created_index" ON "saved_reports" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);