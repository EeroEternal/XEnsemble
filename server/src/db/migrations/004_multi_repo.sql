-- 004_multi_repo.sql
-- 多仓库项目支持：为 projects 增加一对多 project_repos
--
-- 字段含义：
--   role          - frontend / backend / shared / infra / custom
--   sub_path      - 仓内根路径 (如 'a/b/c' 或 'a/b'，>0 层分隔符)
--   is_primary    - 项目主 repo 标识，同 project 下唯一
--   current_branch - 仓库当前分支
--   clone_status  - pending / cloning / ready / failed
--   remote_*      - 上游仓库标识 (github / gitlab / gitea / url)
--
-- 约束：
--   (project_id, sub_path) UNIQUE — 同一 project 下 sub_path 不可重复
--   is_primary 唯一性由应用层保证 (addRepo 内部事务)
--   cascade delete on project_id — 项目删除时自动清理

CREATE TABLE IF NOT EXISTS project_repos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  sub_path TEXT NOT NULL,
  repo_provider TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  repo_default_branch TEXT NOT NULL DEFAULT 'main',
  repo_installation_ref TEXT,
  repo_token_secret_ref TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  current_branch TEXT,
  clone_status TEXT NOT NULL DEFAULT 'pending',
  clone_error TEXT,
  remote_repo_id TEXT,
  remote_full_name TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS project_repos_project_id_idx ON project_repos(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_repos_project_subpath_uniq ON project_repos(project_id, sub_path);

-- 一次性数据迁移：把现有单 repo project 的 repo 同步到 project_repos
-- sub_path 使用 project name 的 slug 形式（最低 2 层）
-- 该 INSERT 是幂等的：如果该 project 已有 project_repos 行（>0），跳过
INSERT INTO project_repos (
  id, project_id, role, sub_path, repo_provider, repo_url, repo_default_branch,
  is_primary, current_branch, clone_status, created_at, updated_at
)
SELECT
  'pr_migration_' || p.id,
  p.id,
  'primary',
  -- 构造最低 2 层 sub_path: 'project/<name-slug>'，保证符合 PathGroupingService 要求
  'project/' || lower(regexp_replace(coalesce(p.name, 'workspace'), '[^a-zA-Z0-9_-]+', '-', 'g')),
  coalesce(p.repo_provider, 'url'),
  coalesce(p.repo_url, ''),
  coalesce(p.repo_default_branch, 'main'),
  TRUE,
  p.current_branch,
  coalesce(NULLIF(p.clone_status, 'pending'), 'ready'),
  p.created_at,
  p.created_at
FROM projects p
WHERE p.repo_url IS NOT NULL
  AND p.repo_url != ''
  AND NOT EXISTS (SELECT 1 FROM project_repos pr WHERE pr.project_id = p.id);
