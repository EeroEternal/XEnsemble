CREATE TABLE IF NOT EXISTS "session_conversations" (
	"session_id" text PRIMARY KEY NOT NULL,
	"summary" jsonb NOT NULL DEFAULT '{}',
	"turns" jsonb NOT NULL DEFAULT '[]',
	"last_summarized_seq" integer NOT NULL DEFAULT 0,
	"source" text NOT NULL DEFAULT 'transcript',
	"last_error" text,
	"error_count" integer NOT NULL DEFAULT 0,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'session_conversations_session_id_sessions_id_fk'
		  AND conrelid = 'session_conversations'::regclass
	) THEN
		ALTER TABLE "session_conversations" ADD CONSTRAINT "session_conversations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
