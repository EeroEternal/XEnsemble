-- repo-clone-reap：收割中断的多仓库导入（部署重启/超时后 clone_status 永停 cloning）
INSERT INTO "scheduler_jobs" ("job_name", "next_run_at") VALUES ('repo-clone-reap', 0)
ON CONFLICT ("job_name") DO NOTHING;
