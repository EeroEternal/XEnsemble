-- Per-user custom image quota (surfaced in Settings → Default user quota and
-- Observability → Quota). Counts user-named images; auto-created recipe rows
-- are bounded separately by platform_settings.custom_image_limits.
ALTER TABLE "user_quotas" ADD COLUMN IF NOT EXISTS "max_custom_images" integer NOT NULL DEFAULT 10;
