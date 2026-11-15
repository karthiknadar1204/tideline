CREATE TABLE "report_session_follows" (
	"report_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "report_session_follows_report_id_session_id_pk" PRIMARY KEY("report_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "report_session_follows" ADD CONSTRAINT "report_session_follows_report_id_saved_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."saved_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_session_follows" ADD CONSTRAINT "report_session_follows_session_id_codex_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."codex_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_session_follows_session_index" ON "report_session_follows" USING btree ("session_id");