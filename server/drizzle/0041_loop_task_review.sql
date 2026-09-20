-- LoopTask 人工复核模式（等待人工 / human-in-the-loop）：
--   loop_tasks.require_review       任务级开关：开启后 run 执行完毕不自动终态，
--                                   会话保持存活进入 awaiting_review，由人工在
--                                   Loop Tasks 中通过/打回，超时自动按 succeeded 收口
--   loop_task_runs.review_started_at 进入 awaiting_review 的时间戳（超时判定依据）
ALTER TABLE "loop_tasks" ADD COLUMN IF NOT EXISTS "require_review" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "loop_task_runs" ADD COLUMN IF NOT EXISTS "review_started_at" bigint;
