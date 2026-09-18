-- 按对话线粘性：一个 session 下可能有多条并行对话线（Agent 派生的并行子任务
-- 共用 sessionId），原先以 session_id 单列为主键会让多条线互相覆盖粘性。
-- 改为 (session_id, line_key) 复合主键；line_key 为空串表示无线索，退化为
-- 原来的「一个 session 一条粘性」。
ALTER TABLE "session_route_sticky" ADD COLUMN IF NOT EXISTS "line_key" text DEFAULT '' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'session_route_sticky_pkey'
		  AND conrelid = 'session_route_sticky'::regclass
	) THEN
		ALTER TABLE "session_route_sticky" DROP CONSTRAINT "session_route_sticky_pkey";
	END IF;
	ALTER TABLE "session_route_sticky" ADD CONSTRAINT "session_route_sticky_pkey" PRIMARY KEY ("session_id", "line_key");
END $$;
