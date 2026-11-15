CREATE TABLE "session_transcript_attachments" (
	"session_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"mime" text NOT NULL,
	"data" text NOT NULL,
	CONSTRAINT "transcript_attachments_pk" PRIMARY KEY("session_id","digest")
);
--> statement-breakpoint
CREATE TABLE "session_transcript_records" (
	"session_id" uuid NOT NULL,
	"line" integer NOT NULL,
	"start_offset" bigint NOT NULL,
	"end_offset" bigint NOT NULL,
	"digest" text NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "transcript_records_pk" PRIMARY KEY("session_id","line")
);
--> statement-breakpoint
ALTER TABLE "session_transcript_attachments" ADD CONSTRAINT "session_transcript_attachments_session_id_codex_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."codex_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_transcript_records" ADD CONSTRAINT "session_transcript_records_session_id_codex_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."codex_sessions"("id") ON DELETE cascade ON UPDATE no action;