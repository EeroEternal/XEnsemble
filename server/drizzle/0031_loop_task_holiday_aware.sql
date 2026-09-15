-- LoopTask 工作日感知：cron `M H * * 1-5` 形态的任务按中国法定日历调度——
-- 法定节假日跳过、调休补班（周末上班）照常触发。日历数据来自 chinese-days 包
-- （随包版本更新，超出覆盖年份退化为纯周一至周五语义）。

ALTER TABLE "loop_tasks" ADD COLUMN "holiday_aware" boolean NOT NULL DEFAULT false;
