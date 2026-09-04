ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "updated_at" bigint;
UPDATE "sessions" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;