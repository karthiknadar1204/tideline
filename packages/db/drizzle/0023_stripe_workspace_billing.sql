CREATE TABLE "stripe_webhook_receipts" (
	"event_id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_billing" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"checkout_session_id" text,
	"checkout_price_id" text,
	"stripe_subscription_id" text,
	"subscription_status" text,
	"subscription_price_id" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	CONSTRAINT "workspace_billing_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "workspace_billing_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "workspace_billing_subscription_fields" CHECK (num_nonnulls("workspace_billing"."stripe_subscription_id", "workspace_billing"."subscription_status", "workspace_billing"."subscription_price_id") in (0, 3)),
	CONSTRAINT "workspace_billing_checkout_fields" CHECK (num_nonnulls("workspace_billing"."checkout_session_id", "workspace_billing"."checkout_price_id") in (0, 2))
);
--> statement-breakpoint
ALTER TABLE "stripe_webhook_receipts" ADD CONSTRAINT "stripe_webhook_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_billing" ADD CONSTRAINT "workspace_billing_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_webhook_receipts_workspace_index" ON "stripe_webhook_receipts" USING btree ("workspace_id");