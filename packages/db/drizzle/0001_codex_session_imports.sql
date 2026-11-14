CREATE TABLE "codex_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_session_id" uuid NOT NULL,
	"started_at" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"messages" jsonb NOT NULL,
	"title" text,
	CONSTRAINT "codex_sessions_workspace_source_unique" UNIQUE("workspace_id","source_session_id")
);
--> statement-breakpoint
ALTER TABLE "codex_sessions" ADD CONSTRAINT "codex_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;