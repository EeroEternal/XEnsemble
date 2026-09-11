-- LoopTask 调度类型扩展（对齐 OpenClaw：cron / every / at 三种）。
-- cron    → cron_expr + timezone（既有行为，存量行默认）
-- every   → interval_ms（每次触发后 next_run_at += interval_ms）
-- at      → 单次执行，目标时间存 next_run_at，触发后任务置 completed

ALTER TABLE "loop_tasks" ADD COLUMN "schedule_kind" text NOT NULL DEFAULT 'cron';
--> statement-breakpoint
ALTER TABLE "loop_tasks" ADD COLUMN "interval_ms" bigint;
