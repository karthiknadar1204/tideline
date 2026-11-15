CREATE TABLE "github_commit_evidence" (
	"workspace_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"sha" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_commit_evidence_workspace_id_repository_sha_pk" PRIMARY KEY("workspace_id","repository","sha")
);
--> statement-breakpoint
ALTER TABLE "github_commit_evidence" ADD CONSTRAINT "github_commit_evidence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;