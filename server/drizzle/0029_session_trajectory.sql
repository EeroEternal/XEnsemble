CREATE TABLE IF NOT EXISTS "session_trajectory" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"ts" bigint NOT NULL,
	"agent_id" text,
	"model" text,
	"snapshot" boolean NOT NULL DEFAULT false,
	"msg_count" integer NOT NULL DEFAULT 0,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"status" text NOT NULL DEFAULT 'ok',
	"latency_ms" integer,
	"error" text,
	CONSTRAINT "session_trajectory_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_trajectory_session" ON "session_trajectory" USING btree ("session_id");
--> statement-breakpoint
ALTER TABLE "session_trajectory" ADD CONSTRAINT "session_trajectory_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
