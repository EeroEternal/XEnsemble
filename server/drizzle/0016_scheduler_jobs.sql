CREATE TABLE IF NOT EXISTS "scheduler_jobs" (
	"job_name" text PRIMARY KEY NOT NULL,
	"locked_by" text,
	"locked_at" bigint,
	"last_run_at" bigint,
	"last_status" text,
	"last_error" text,
	"next_run_at" bigint NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO "scheduler_jobs" ("job_name", "next_run_at") VALUES ('conversation-summarize', 0)
ON CONFLICT ("job_name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "scheduler_jobs" ("job_name", "next_run_at") VALUES ('skill-pipeline', 0)
ON CONFLICT ("job_name") DO NOTHING;
