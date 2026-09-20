-- 0042: 铃铛通知中心（docs/proposals/agent-attention-notification.md §4）。
-- 未读红点 / 角标数需跨刷新、跨标签存活 → PG 持久化（不引入 Redis）。
-- 正文不落库：只存结构化 payload 快照（sessionId/skillId/名称/reason），文案由前端 i18n 渲染。
-- 注：drizzle-kit generate 因 pull_requests→project_repos 的历史漂移进入交互式确认，
--     故本迁移手工书写；列/约束/索引与 schema.js 中 notifications 表定义一一对应。

CREATE TABLE IF NOT EXISTS "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- 角标轮询：count where user_id=? and read_at is null
CREATE INDEX IF NOT EXISTS "idx_notifications_user_unread" ON "notifications" USING btree ("user_id","read_at","created_at");
--> statement-breakpoint
-- 列表分页：order by user_id, created_at desc
CREATE INDEX IF NOT EXISTS "idx_notifications_user_created" ON "notifications" USING btree ("user_id","created_at");
