ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "requested_model" text;
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "trigger" text;
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "seq" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_session_seq" ON "llm_usage" ("session_id", "seq");
