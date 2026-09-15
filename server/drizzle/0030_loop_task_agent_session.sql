-- LoopTask 拉起 Agent 执行（Architecture.md §5.3 修订）：
--   一次 Run = 在项目沙箱内创建真实 Agent 会话执行（用户的 Agent + 用户的模型额度），
--   TaskAgent 控制面 ReAct 循环退役。
-- run↔session 一对一关联；会话保留（exited）供复盘。
-- loop_task 会话通过 sessions.source 标记：列表接口默认过滤，不进主侧边栏、不占 sessions 配额。

ALTER TABLE "sessions" ADD COLUMN "source" text NOT NULL DEFAULT 'interactive';
ALTER TABLE "loop_tasks" ADD COLUMN "agent_id" text;
ALTER TABLE "loop_tasks" ADD COLUMN "auto_approve" boolean NOT NULL DEFAULT true;
ALTER TABLE "loop_task_runs" ADD COLUMN "session_id" text;
ALTER TABLE "loop_task_runs" ADD COLUMN "agent_id" text;
CREATE INDEX IF NOT EXISTS "idx_loop_task_runs_session" ON "loop_task_runs" ("session_id");

-- 存量任务回填：取该用户最近一次使用的非 shell Agent。
-- 回填不到（从没建过 Agent 会话）的保持 NULL——触发时报错提示编辑任务，不静默失败。
UPDATE "loop_tasks" t SET "agent_id" = (
	SELECT s."agent_id" FROM "sessions" s
	WHERE s."user_id" = t."user_id"
	  AND s."agent_id" IS NOT NULL
	  AND s."agent_id" <> 'shell'
	ORDER BY s."created_at" DESC
	LIMIT 1
) WHERE t."agent_id" IS NULL;
