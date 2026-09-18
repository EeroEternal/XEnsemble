-- A+C: sessions start immediately on the base agent image; the selected
-- environment components are installed inside the sandbox afterwards. These
-- columns track that background provisioning.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "env_provision_state" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "env_provision_error" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "env_provision_started_at" bigint;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "env_provision_finished_at" bigint;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "env_provision_log_ref" text;
