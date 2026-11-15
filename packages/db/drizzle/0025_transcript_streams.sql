ALTER TABLE "session_transcript_records" ADD COLUMN "stream" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_transcript_records" DROP CONSTRAINT "transcript_records_pk";
--> statement-breakpoint
ALTER TABLE "session_transcript_records" ADD CONSTRAINT "transcript_records_pk" PRIMARY KEY("session_id","stream","line");