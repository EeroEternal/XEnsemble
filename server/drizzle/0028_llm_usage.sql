CREATE TABLE IF NOT EXISTS "llm_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"project_id" text,
	"agent_id" text,
	"model" text,
	"prompt_tokens" integer NOT NULL DEFAULT 0,
	"completion_tokens" integer NOT NULL DEFAULT 0,
	"total_tokens" integer NOT NULL DEFAULT 0,
	"cached_tokens" integer,
	"status_code" integer,
	"latency_ms" integer,
	"created_at" bigint NOT NULL,
	"requested_model" text,
	"trigger" text,
	"seq" integer,
	"difficulty" double precision
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'llm_usage_user_id_users_id_fk'
		  AND conrelid = 'llm_usage'::regclass
	) THEN
		ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_user_created" ON "llm_usage" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_user_project" ON "llm_usage" ("user_id", "project_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_created" ON "llm_usage" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_session_seq" ON "llm_usage" ("session_id", "seq");
