-- 0043: 内置 AI 用量归属（internal AI usage attribution）
-- 服务端内置 AI 功能（标题/摘要/轨迹建议/技能流水线/部署分析/部署验证/快速预览/
-- git commit/PR 描述）此前经 LLM_ANALYZE_* 直连 provider，零计量零归属。现统一
-- 收口 analyzeClient，与 proxy 的 agent 会话流量共用 llm_usage 表：
--   source   = 'session'（agent 会话流量，proxy 写入；存量行 NULL，查询 COALESCE 兜底）
--              | 'internal'（内置 AI，analyzeClient 写入）
--   feature  = source='internal' 时必填的功能标识
-- 显式打标而非空值推断：标题/摘要/技能类内置调用自带 sessionId，空值推断会与
-- 同会话的 agent 流量混淆。内容不落库，仅计量。
ALTER TABLE "llm_usage" ADD COLUMN "source" text;
ALTER TABLE "llm_usage" ADD COLUMN "feature" text;
