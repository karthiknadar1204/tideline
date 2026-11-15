ALTER TABLE "weekly_digest_deliveries" ADD COLUMN "cadence" text DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_digest_subscriptions" ADD COLUMN "cadence" text DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_digest_deliveries" DROP CONSTRAINT "weekly_digest_deliveries_workspace_id_week_start_recipient_id_pk";--> statement-breakpoint
ALTER TABLE "weekly_digest_subscriptions" DROP CONSTRAINT "weekly_digest_subscriptions_pkey";--> statement-breakpoint
ALTER TABLE "weekly_digest_deliveries" ADD CONSTRAINT "digest_deliveries_pk" PRIMARY KEY("workspace_id","cadence","week_start","recipient_id");--> statement-breakpoint
ALTER TABLE "weekly_digest_subscriptions" ADD CONSTRAINT "digest_subscriptions_pk" PRIMARY KEY("workspace_id","cadence");--> statement-breakpoint
ALTER TABLE "weekly_digest_deliveries" ADD CONSTRAINT "digest_delivery_cadence_valid" CHECK ("cadence" in ('daily', 'weekly'));--> statement-breakpoint
ALTER TABLE "weekly_digest_subscriptions" ADD CONSTRAINT "digest_subscription_cadence_valid" CHECK ("cadence" = 'weekly' or ("cadence" = 'daily' and "weekday" = 0));
