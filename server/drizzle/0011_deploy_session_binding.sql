-- 0011: 部署/预览与 session 强绑定 + 部署阶段持久化。
-- 1) deployments 绑定创建它的 session；session 删除时记录级联清理
--    （进程/tunnel 的显式停止见 server.js 的 DELETE /api/v1/sessions/:id）。
ALTER TABLE deployments ADD COLUMN session_id text REFERENCES sessions(id) ON DELETE CASCADE;
-- 2) auto-deploy 进行中状态持久化：当前阶段（A 分析 / B 部署 / preview）与阶段消息，
--    切 session 再切回时前端据此恢复，避免重复部署。
ALTER TABLE deployments ADD COLUMN stage text;
ALTER TABLE deployments ADD COLUMN stage_message text;
