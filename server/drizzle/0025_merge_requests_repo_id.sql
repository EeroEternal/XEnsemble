-- 多仓库 PR/MR：merge_requests 增加 repo_id（所属 project_repos 行）
-- 单仓库 / 存量行 repo_id 为 NULL（PG 对 NULL 不去重，互不冲突）；
-- 唯一约束加入 repo_id，避免不同仓库的 MR #N 互相冲突。
ALTER TABLE "merge_requests" ADD COLUMN IF NOT EXISTS "repo_id" text;
--> statement-breakpoint
ALTER TABLE "merge_requests" DROP CONSTRAINT IF EXISTS "merge_requests_project_id_provider_remote_mr_number_unique";
--> statement-breakpoint
ALTER TABLE "merge_requests" ADD CONSTRAINT "merge_requests_project_id_provider_repo_mr_number_unique" UNIQUE("project_id","provider","repo_id","remote_mr_number");
