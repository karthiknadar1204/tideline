CREATE TABLE "account_retirements" (
	"user_key" text PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
