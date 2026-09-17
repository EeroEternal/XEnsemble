-- P2: custom image composition
-- 1) Indexed recipe identity on builds (replaces the `image_ref LIKE '%:<hash>'` scan).
-- No backfill: the new identity also hashes the resolved base (agent) image, so a
-- legacy tag can never match a new lookup. Historical rows stay NULL and are
-- simply not reuse candidates.
ALTER TABLE "custom_image_builds" ADD COLUMN IF NOT EXISTS "content_hash" text;

CREATE INDEX IF NOT EXISTS "idx_custom_image_builds_hash_state"
    ON "custom_image_builds" ("content_hash", "state");

-- 2) Curated ("管理员精选") catalog metadata + GC soft-delete marker.
ALTER TABLE "custom_images" ADD COLUMN IF NOT EXISTS "is_published" boolean NOT NULL DEFAULT false;
ALTER TABLE "custom_images" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "custom_images" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "custom_images" ADD COLUMN IF NOT EXISTS "stale_at" bigint;
-- Server-controlled marker for rows auto-created by /resolve (inline launch
-- recipes). Quota bucketing must not trust a client-supplied name prefix.
ALTER TABLE "custom_images" ADD COLUMN IF NOT EXISTS "is_auto" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "idx_custom_images_published" ON "custom_images" ("is_published");

-- 3) Workspace default environment.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "default_custom_image_id" text;

-- 4) Register the image GC job. The scheduler only runs jobs that have a row in
-- `scheduler_jobs` (see Scheduler.isDue), matching 0024/0026. The first run is
-- delayed by one interval so a deploy does not immediately start marking images.
-- The job itself additionally requires CUSTOM_IMAGE_GC_ENABLED=true.
INSERT INTO "scheduler_jobs" ("job_name", "next_run_at")
VALUES ('custom-image-gc', (EXTRACT(EPOCH FROM now()) * 1000)::bigint + 21600000)
ON CONFLICT DO NOTHING;
