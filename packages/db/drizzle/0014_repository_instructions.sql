CREATE TABLE "repository_instructions" (
	"workspace_id" uuid NOT NULL,
	"repository_key" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_instructions_workspace_id_repository_key_pk" PRIMARY KEY("workspace_id","repository_key")
);
--> statement-breakpoint
ALTER TABLE "repository_instructions" ADD CONSTRAINT "repository_instructions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;