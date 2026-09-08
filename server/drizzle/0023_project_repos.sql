-- 多仓库项目支持：project_repos 一对多子表
-- role          - frontend / backend / shared / infra / custom
-- sub_path      - 沙箱内挂载根名（/workspace/<sub_path>，1+ 段，如 'frontend'）
-- is_primary    - 项目主 repo 标识（应用层保证同 project 唯一）
-- (project_id, sub_path) UNIQUE；project 删除级联清理
CREATE TABLE IF NOT EXISTS "project_repos" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "sub_path" text NOT NULL,
  "repo_provider" text NOT NULL,
  "repo_url" text NOT NULL,
  "repo_default_branch" text NOT NULL DEFAULT 'main',
  "repo_installation_ref" text,
  "repo_token_secret_ref" text,
  "is_primary" boolean NOT NULL DEFAULT false,
  "current_branch" text,
  "clone_status" text NOT NULL DEFAULT 'pending',
  "clone_error" text,
  "remote_repo_id" text,
  "remote_full_name" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_repos_project_id_idx" ON "project_repos" ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_repos_project_subpath_uniq" ON "project_repos" ("project_id","sub_path");
--> statement-breakpoint
-- 存量回填：为每个已有 git repo 的 project 生成一条 is_primary 行（幂等）
-- sub_path 取项目名 slug（1 段）；id 固定前缀保证重复执行时被 NOT EXISTS 拦截
INSERT INTO "project_repos" (
  "id", "project_id", "role", "sub_path", "repo_provider", "repo_url",
  "repo_default_branch", "repo_installation_ref", "repo_token_secret_ref",
  "is_primary", "current_branch", "clone_status", "remote_repo_id", "remote_full_name",
  "created_at", "updated_at"
)
SELECT
  'pr_migration_' || p."id",
  p."id",
  'primary',
  lower(regexp_replace(coalesce(p."name", 'workspace'), '[^a-zA-Z0-9_-]+', '-', 'g')),
  coalesce(p."repo_provider", 'url'),
  coalesce(p."repo_url", ''),
  coalesce(p."repo_default_branch", 'main'),
  p."repo_installation_ref",
  p."repo_token_secret_ref",
  TRUE,
  p."current_branch",
  coalesce(NULLIF(p."clone_status", 'pending'), 'ready'),
  p."remote_repo_id",
  coalesce(p."remote_full_name", p."github_full_name"),
  p."created_at",
  p."created_at"
FROM "projects" p
WHERE p."repo_url" IS NOT NULL AND p."repo_url" != ''
  AND NOT EXISTS (SELECT 1 FROM "project_repos" pr WHERE pr."project_id" = p."id");
