ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "exit_code" integer;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "exited_at" bigint;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "source_hash" text;
