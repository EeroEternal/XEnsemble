# LLM 控制面反代（Agent ↔ Gateway）

**Agent 与 UniGateway 连接的规范设计**。实现与评审须对齐本文；系统架构上下文见 [Architecture.md](./Architecture.md)，Agent 注册与 Gateway 管理见 [agents.md](./agents.md)。

## 1. 目标

- Agent（含远端 Runtime 内进程）**不直连** UniGateway；只访问控制面公开 URL。
- UniGateway 仅监听控制面内网（默认 `127.0.0.1:8741`），由控制面反代转发；或使用外部 UniGateway（Phase 3）。
- **不依赖** K8s sidecar 或 Runtime 内嵌 Gateway。
- Gateway 模式下，Agent 进程内**不注入**平台 master key（`ugk_*`），改为**会话级 token**（`xel_*`）。

## 2. 拓扑

```
Agent（任意 Runtime）
    │  HTTPS/HTTP
    │  Authorization: Bearer xel_…  （或 X-Api-Key: xel_…）
    ▼
控制面  POST /api/v1/llm/v1/chat/completions 等
    │  验 session token、查 session / active user / agent grant
    │  按 tier 限流（/health、/v1/models* 豁免）
    │  派生 per-agent gateway key，转发时覆盖 Authorization 并清除 x-api-key
    │  Authorization: Bearer <per-agent-key>（内部）
    ▼
UniGateway（本地子进程 或 LLM_GATEWAY_UPSTREAM_URL）
    │  本地：service_id = agentId；外部：service_id = default
    ▼
OpenAI / Anthropic / …（providers 配置）
```

与 Preview 反代（`server/src/preview/gateway.js`）同一模式：对外验权、对内转发。

## 3. 对外 URL

优先级：

1. 环境变量 **`CONTROL_PLANE_PUBLIC_URL`**
2. Admin Settings → Gateway → **Control plane public URL**（`gateway_public_url`）
3. 默认 `http://127.0.0.1:${PORT}`

**Router 基址**：`{public_url}/api/v1/llm`

| 场景 | 示例 |
|------|------|
| 本机 Local | `http://127.0.0.1:3888` |
| Agent 在 Docker | `http://host.docker.internal:3888` |
| 生产 | `https://app.example.com` |

Gateway 模式 spawn 时，由 `agentEnv.js` 的 `applyGatewaySynthesis` 展开为各 CLI 所需的 `*_BASE_URL` / `*_API_KEY`（值为 `xel_*` session token）。

## 4. 控制面路由

实现：`server/src/llm/proxy.js`（`registerLlmProxy`）。

| 对外路径 | 转发至 UniGateway |
|----------|-------------------|
| `POST /api/v1/llm/v1/chat/completions` | `/v1/chat/completions` |
| `POST /api/v1/llm/v1/messages` | `/v1/messages` |
| `POST /api/v1/llm/v1/embeddings` | `/v1/embeddings` |
| `GET /api/v1/llm/health` | `/health` |

须支持 **SSE 流式**响应（`http-proxy` 透传）。

## 5. 会话 Token（`xel_`）

**签发**：`POST /api/v1/session/start`，Gateway 模式、spawn 之前（`server/src/llm/sessionToken.js`）。

JWT claims（`typ: llm_session`）：`sid`、`uid`、`pid`、`aid`、`model`（可选）、`role`（配额豁免 admin）。

**校验**：JWT 有效 + DB `sessions.status === 'running'`。

**撤销**：session 退出或 `DELETE /api/v1/sessions/:id` → `status = exited`。

## 6. 模块职责

| 模块 | 职责 |
|------|------|
| `llm/publicUrl.js` | 公开 URL / Router 基址 |
| `llm/sessionToken.js` | 签发 / 校验 `xel_` token |
| `llm/proxy.js` | 反代、鉴权、限流、审计事件 |
| `llm/gatewayUpstream.js` | 解析 UniGateway 上游地址 |
| `llm/serviceRouter.js` | 派生并注册 per-agent UniGateway API key |
| `llm/agentServiceSync.js` | 同步 `unigateway.toml` services/bindings（按 agent 替换 binding） |
| `llm/quota.js` | 按用户每分钟固定配额（tier 前端下线后不再按 `resource_tier` 区分） |
| `agents/agentEnv.js` | spawn env |
| `admin/GatewaySettings.js` | `public_url`、`upstream_url` 配置 |
| `llm/promptCapture.js` | 临时：原始请求落盘采集（`LLM_CAPTURE_*`，默认 all，见 §11） |

## 7. Phase 2（已实现）

- 反代结构化日志：`sessionId`、`userId`、`agentId`、`path`
- `events` 表写入 `llm_proxy_forward` 审计（含 `status_code` / 失败信息）
- 按 user 固定每分钟限流（`llm/quota.js`，`LLM_REQ_LIMIT_PER_MIN`；`/health` 与 `/v1/models*` 不占配额）
- Agent Configure 保存时同步 UniGateway `service_id = agentId` binding（`agentServiceSync.js`，切换 provider 时替换而非追加）
- 控制面为每个 agent 派生确定性 gateway key（`serviceRouter.js`），不再对 master key 做 per-request rebind
- Agent 只持有 `xel_*` session token；控制面在转发时换成 gateway key

## 8. Phase 3（已实现）

- **外部 UniGateway**：`LLM_GATEWAY_UPSTREAM_URL` 或 Settings → **External UniGateway URL**；本地子进程可不启动
- **多控制面实例**：session 鉴权以 **DB `sessions` 为准**（非内存 SessionManager）；多实例须共享同一数据库
- Admin status 返回 `llm_proxy_url`、`control_plane_public_url`、`gateway_upstream_url`、`external_upstream`

## 9. 验收

```bash
cd server
npm test                              # 单元测试
npm run test:llm-acceptance           # 需 UniGateway 二进制 + RUN_LLM_ACCEPTANCE=1
```

验收用例（`proxy.acceptance.test.js`）：无 token 401、有效 token 转发 `/health`、session exited 401。

## 10. 与 BYOK 的关系

BYOK 模式不变：用户 Vault → spawn env，不经过 `/api/v1/llm`。仅 Gateway 模式走反代 + session token。

## 11. 临时诊断：原始请求采集（promptCapture）

**TEMPORARY**——为分析各 agent 组装后的提示词（system prompt / messages 顺序 / 上下文增长）而加，网关消息归一化功能上线后整体移除。默认 **all**（全量采集，零配置生效——部署链路不透传新增环境变量，开关语义落在代码默认值上）。磁盘由总量配额（2GB）+ 保留期（7 天）+ 单请求上限（8MB）兜底；设 `LLM_CAPTURE_MODE=off` 关闭。

- 接入点：`proxy.js` 转发前、opencode alias 改写之前，捕获 agent 原始请求体字节
- 布局与格式：`$LLM_CAPTURE_DIR/<agent>/<sessionId>.json`，内容 `{"agent": "...", "messages": [<请求1完整报文>, ...]}`——每会话一个文件，messages 顺序即请求时序，元素为 agent 发给 LLM 的完整请求 JSON（含内置 system prompt）
- 开关与磁盘保护见 `.env.example` 的 `LLM_CAPTURE_*` 段：采样模式、单请求上限、总量配额（按文件 mtime 从最旧删除，活跃文件跳过）、保留期清理、ENOSPC 自动停采
- 下线：关 env → 删 `$LLM_CAPTURE_DIR` → 删 `promptCapture.js` 与 proxy.js 接入行
