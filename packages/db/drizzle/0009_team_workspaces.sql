CREATE TYPE "public"."workspace_kind" AS ENUM('personal', 'team');--> statement-breakpoint
CREATE TYPE "public"."workspace_member_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "session_shares" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "session_shares_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "workspace_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "workspace_member_role" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"accepted_by" text,
	CONSTRAINT "workspace_invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "workspace_invites_single_outcome" CHECK ("workspace_invites"."revoked_at" is null or "workspace_invites"."accepted_by" is null)
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"role" "workspace_member_role" NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_owner_id_unique";--> statement-breakpoint
ALTER TABLE "sync_grants" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "kind" "workspace_kind" DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_shares" ADD CONSTRAINT "session_shares_session_id_codex_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."codex_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invites_pending_email_unique" ON "workspace_invites" USING btree ("workspace_id","email") WHERE "workspace_invites"."revoked_at" is null and "workspace_invites"."accepted_by" is null;--> statement-breakpoint
CREATE INDEX "workspace_members_user_index" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_personal_owner_unique" ON "workspaces" USING btree ("owner_id") WHERE "workspaces"."kind" = 'personal';--> statement-breakpoint
CREATE INDEX "workspaces_owner_index" ON "workspaces" USING btree ("owner_id");