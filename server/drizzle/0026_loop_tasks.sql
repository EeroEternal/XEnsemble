-- LoopTask：用户自定义定时任务（LoopTask 功能，Architecture.md §5.3 Task Automation）。
-- 执行模型：一次 Run = TaskAgent（控制面 ReAct 循环）在 Workspace runtime 沙箱内执行，
-- 不创建 Session、不占用 Session 配额（与部署 verify agent 同构）。

CREATE TABLE IF NOT EXISTS "loop_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"cron_expr" text NOT NULL,
	"timezone" text NOT NULL DEFAULT 'Asia/Shanghai',
	"status" text NOT NULL DEFAULT 'active',
	"next_run_at" bigint NOT NULL DEFAULT 0,
	"last_run_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loop_task_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"scheduled_for" bigint NOT NULL,
	"status" text NOT NULL DEFAULT 'running',
	"rounds" integer,
	"logs" jsonb DEFAULT '[]',
	"error" text,
	"started_at" bigint,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_loop_task_runs_slot" ON "loop_task_runs" ("task_id","scheduled_for");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_loop_tasks_due" ON "loop_tasks" ("status","next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_loop_task_runs_task" ON "loop_task_runs" ("task_id","started_at");
--> statement-breakpoint
ALTER TABLE "loop_tasks" ADD CONSTRAINT "loop_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "loop_tasks" ADD CONSTRAINT "loop_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "loop_task_runs" ADD CONSTRAINT "loop_task_runs_task_id_loop_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "loop_tasks"("id") ON DELETE CASCADE;
--> statement-breakpoint
INSERT INTO "scheduler_jobs" ("job_name", "next_run_at") VALUES ('loop-task-runner', 0)
ON CONFLICT ("job_name") DO NOTHING;
