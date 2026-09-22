-- 循环任务「完成后保留会话」模式（原「等待人工」挂起态下线）：
--   干完即记 succeeded（会话保留不退出），不再有 awaiting_review 挂起态，
--   通过/打回收口与 24h 超时清扫一并移除。
-- 存量 awaiting_review run 一次性按 succeeded 收口（run 的会话若仍在跑，
-- 由既有 idle hibernate / 用户操作接管生命周期）；review_started_at 列随之废弃。
UPDATE loop_task_runs
SET status = 'succeeded',
    finished_at = COALESCE(finished_at, (extract(epoch from clock_timestamp()) * 1000)::bigint)
WHERE status = 'awaiting_review';
--> statement-breakpoint
ALTER TABLE loop_task_runs DROP COLUMN IF EXISTS review_started_at;
