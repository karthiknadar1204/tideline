CREATE TABLE "clerk_directory_user_states" (
	"user_key" text PRIMARY KEY NOT NULL,
	"blocked" boolean NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_clerk_organizations" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_clerk_organizations_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "directory_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_clerk_organizations" ADD CONSTRAINT "workspace_clerk_organizations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;