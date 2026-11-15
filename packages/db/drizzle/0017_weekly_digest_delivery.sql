CREATE TABLE "weekly_digest_deliveries" (
	"workspace_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"recipient_id" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "weekly_digest_deliveries_workspace_id_week_start_recipient_id_pk" PRIMARY KEY("workspace_id","week_start","recipient_id")
);
--> statement-breakpoint
CREATE TABLE "weekly_digest_subscriptions" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"weekday" integer NOT NULL,
	"hour_utc" integer NOT NULL,
	"recipient_ids" text[] NOT NULL,
	CONSTRAINT "weekly_digest_schedule_valid" CHECK ("weekly_digest_subscriptions"."weekday" between 0 and 6 and "weekly_digest_subscriptions"."hour_utc" between 0 and 23),
	CONSTRAINT "weekly_digest_recipients_valid" CHECK (cardinality("weekly_digest_subscriptions"."recipient_ids") between 1 and 25)
);
--> statement-breakpoint
ALTER TABLE "weekly_digest_deliveries" ADD CONSTRAINT "weekly_digest_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_digest_subscriptions" ADD CONSTRAINT "weekly_digest_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;