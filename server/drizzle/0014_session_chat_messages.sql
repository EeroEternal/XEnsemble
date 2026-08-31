CREATE TABLE IF NOT EXISTS "session_chat_messages" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"ts" bigint NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"call_id" text,
	"tool" text,
	"model" text,
	CONSTRAINT "session_chat_messages_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_chat_messages_session" ON "session_chat_messages" USING btree ("session_id");
--> statement-breakpoint
ALTER TABLE "session_chat_messages" ADD CONSTRAINT "session_chat_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
