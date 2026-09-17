# XEnsemble 客户端 API 调用指南

**Desktop / 原生 / 第三方客户端接入控制面的规范文档**。Web Console（`client/`）与本指南使用同一套 HTTP + WebSocket API；无需经过浏览器即可完成注册、登录与全部业务操作。

相关文档：

- 用户、角色、配额：[UserManagement.md](./UserManagement.md)
- LLM 反代与会话 token：[LlmProxy.md](./LlmProxy.md)
- 系统架构：[Architecture.md](./Architecture.md)

---

## 1. 控制面基址

| 环境 | 基址示例 |
|------|----------|
| 本机开发 | `http://127.0.0.1:3888` |
| 生产（systemd + nginx） | `https://xensemble.dev`（见 `deploy/xensemble.env` 中 `CONTROL_PLANE_PUBLIC_URL`） |

下文以 `{BASE}` 表示控制面根 URL（无尾部斜杠）。

**健康检查**（无需登录）：

```http
GET {BASE}/api/v1/llm/health
```

---

## 2. 通用约定

### 2.1 请求格式

- Content-Type：`application/json`（有 body 时）
- 鉴权：`Authorization: Bearer <jwt>`（公开路由除外）
- CORS：服务端允许任意 Origin（`origin: *`），原生客户端不受浏览器限制

### 2.2 JWT 用户 Token

- 签发：`POST /api/v1/auth/login` 或注册成功且 `autoLogin` 时
- 有效期：**7 天**
- Payload 含 `id`、`username`、`role`、`status`

### 2.3 错误响应

| 场景 | HTTP | body 示例 |
|------|------|-----------|
| 未登录 / token 无效 | 401 | `{ "error": "Unauthorized" }` |
| 非 admin 访问管理 API | 403 | `{ "error": "Forbidden" }` |
| 账号待审批 | 403 | `{ "error": "...", "code": "account_pending" }` |
| 账号已封禁 | 403 | `{ "error": "...", "code": "account_suspended" }` |
| Agent 未授权 | 403 | `{ "error": "agent_not_granted", "agent_id": "..." }` |
| 配额超限 | 429 | `{ "error": "quota_exceeded", "dimension": "max_sessions", "limit": 3, "current": 3 }` |
| 注册已关闭 | 403 | `{ "error": "...", "code": "registration_disabled" }` |

业务错误通常在 4xx body 中带 `"error"` 字符串说明原因。

---

## 3. 认证（公开，无需 Web）

### 3.1 注册

```http
POST {BASE}/api/v1/auth/register
Content-Type: application/json

{
  "username": "alice",
  "password": "至少8位"
}
```

**成功 — 直接可用（`registration_mode=open` 且首个用户或已激活）**：

```json
{
  "token": "eyJhbG...",
  "user": { "id": "usr_...", "username": "alice", "role": "user", "status": "active", "llm_auth_mode": "gateway" },
  "quotas": { "max_projects": 5, "max_sessions": 3, "max_previews": 2, "resource_tier": "basic", "usage": { "projects": 0, "sessions": 0, "previews": 0 } }
}
```

**成功 — 待管理员审批（`registration_mode=approval`）**，HTTP 201，无 token：

```json
{
  "message": "Registration submitted. Await administrator approval.",
  "user": { "id": "usr_...", "username": "alice", "status": "pending" }
}
```

首个注册用户自动成为 `admin` 且 `status=active`。

### 3.2 登录

```http
POST {BASE}/api/v1/auth/login
Content-Type: application/json

{
  "username": "alice",
  "password": "..."
}
```

响应与注册成功时相同：`token`、`user`、`quotas`。

### 3.3 当前用户

```http
GET {BASE}/api/v1/auth/me
Authorization: Bearer <token>
```

### 3.4 修改密码

```http
PUT {BASE}/api/v1/auth/password
Authorization: Bearer <token>

{
  "current_password": "...",
  "new_password": "至少8位"
}
```

---

## 4. 用户面 REST API

以下路由均需 `Authorization: Bearer <jwt>`，且用户 `status` 为 `active`。

### 4.1 Secrets Vault

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/secrets` | 返回当前用户解密后的 key-value 对象 |
| POST | `/api/v1/secrets` | 合并写入；空字符串/null 的 key 被忽略 |

```http
POST {BASE}/api/v1/secrets
Authorization: Bearer <token>

{ "OPENAI_API_KEY": "sk-..." }
```

### 4.2 Agents

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/v1/agents` | 用户 | 返回已授权 Agent 列表 |
| POST | `/api/v1/agents` | admin | 注册 Agent |
| PUT | `/api/v1/agents/:id` | admin | 更新 Agent |
| DELETE | `/api/v1/agents/:id` | admin | 删除 Agent |

Agent 对象字段：`id`、`name`、`cmd`、`args`、`env_required`、`llm_auth_mode`、`gateway_model`。

### 4.3 Projects

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/projects` | 列出当前用户项目 |
| POST | `/api/v1/projects` | 创建项目；body: `{ "name": "My App" }` |
| DELETE | `/api/v1/projects/:projectId` | 删除项目 |
| GET/PUT | `/api/v1/projects/:projectId/repository` | Git 仓库绑定 |
| GET/PUT | `/api/v1/projects/:projectId/dev-profile` | 开发环境配置 |
| GET/POST | `/api/v1/projects/:projectId/repo-snapshots` | 仓库快照 |
| GET/POST | `/api/v1/projects/:projectId/checkpoints` | 检查点；POST 可带 `session_id` |

创建项目响应示例：

```json
{
  "id": "proj_abc123",
  "name": "My App",
  "server_path": "/path/to/workspace",
  "default_runtime_id": "rt_...",
  "created_at": 1718000000000
}
```

### 4.4 Sessions

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions` | 列出 Session；含 `alive`、`memoryStatus` |
| POST | `/api/v1/session/start` | 启动 Agent Session |
| POST | `/api/v1/sessions/:sessionId/resume` | 恢复已退出且可恢复的 Session |
| DELETE | `/api/v1/sessions/:sessionId` | 终止 Session |

**启动 Session**：

```http
POST {BASE}/api/v1/session/start
Authorization: Bearer <token>

{
  "agent_id": "kimi-code",
  "project_id": "proj_abc123",
  "terminal_theme_id": "dracula"
}
```

`terminal_theme_id` 可选；省略时使用用户偏好 → 平台默认 → catalog 默认。解析优先级：`请求体` > `用户偏好` > `平台 default_terminal_theme_id` > catalog `default_id`。

成功响应：

```json
{
  "session_id": "sess_deadbeef",
  "status": "running",
  "runtime_id": "rt_...",
  "stream_ref": null,
  "recoverable": true,
  "terminal_theme_id": "dracula",
  "spawn_env_preview": { "COLORFGBG": "15;0", "COLORTERM": "truecolor" }
}
```

spawn 时 Server 按 effective theme 注入 `COLORFGBG` 等变量（Cursor Agent 等 CLI 用于 dark/light TUI 探测）。Admin 可在 Agent gateway config 的 `env_overrides.COLORFGBG` 覆盖 per-agent。

P2 已交付：对支持 native state 的 Agent，退出后可通过 `POST /api/v1/sessions/:sessionId/resume` 继续同一 transcript，前提是该 Session 在 catalog 中标记为可恢复且已有 `state_dir_ref`。当前 L2 可恢复 Agent：**Factory Droid**（`FACTORY_HOME_OVERRIDE` + `--resume`，已 CLI 核实）、**Claude Code**（`CLAUDE_CONFIG_DIR` + `--continue`，文档级）。

### 4.4.1 Terminal Themes & 用户偏好

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/terminal-themes` | Theme catalog（metadata；完整 palette 由 Desktop 持有） |
| GET | `/api/v1/user/preferences` | 用户偏好 |
| PUT | `/api/v1/user/preferences` | 更新偏好；body: `{ "terminal_theme_id": "dracula" }` |
| GET | `/api/v1/session/spawn-preview?agent_id=&terminal_theme_id=` | 预览 effective spawn env（含 COLORFGBG） |

**Theme catalog 响应**：

```json
{
  "default_id": "github-dark",
  "themes": [
    { "id": "github-dark", "label": "GitHub Dark", "appearance": "dark" },
    { "id": "nord", "label": "Nord", "appearance": "dark" }
  ]
}
```

Admin 平台设置（`GET/PUT /api/v1/admin/platform-settings`）扩展字段：`default_terminal_theme_id`、`disabled_terminal_theme_ids`。

启动前须：项目存在、Agent 已授权、Secrets 已配置（Gateway 或 BYOK 模式）、未超并发 Session 配额。

### 4.5 Workspace 文件

| 方法 | 路径 | Query | 说明 |
|------|------|-------|------|
| GET | `/api/v1/workspace/files` | `project_id` | 列出 workspace 文件树 |
| GET | `/api/v1/workspace/file` | `project_id`, `path` | 读取单个文件；响应 `{ "content": "..." }` |

### 4.6 Runtimes & Deployments / Preview

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/runtimes?project_id=` | 项目 Runtime 列表 |
| GET | `/api/v1/deployments?project_id=` | Deployment 列表 |
| GET | `/api/v1/deployments/:deploymentId` | 单个 Deployment |
| POST | `/api/v1/projects/:projectId/preview` | 一键部署并启动 Preview |
| POST | `/api/v1/deployments` | 创建 Deployment；body: `{ "project_id": "..." }` |
| POST | `/api/v1/deployments/:id/start` | 启动 |
| POST | `/api/v1/deployments/:id/preview-token` | 为 running deployment 签发/轮换 `preview_token` |
| POST | `/api/v1/deployments/:id/stop` | 停止 Preview |
| DELETE | `/api/v1/deployments/:id` | 删除 |

**Preview 访问**（HTTP/WebSocket 反代，需 deployment-scoped token）：

- 创建/启动 Deployment 的响应体新增 `preview_token` 字段。
- 访问 Preview 时通过 header 或 query 携带该 token：

```
{BASE}/preview/{deploymentId}/...
x-preview-token: <preview_token>
```

或通过 query：`?preview_token=<preview_token>`。

---

## 5. Agent 终端传输

仅当客户端需要**交互式终端**（PTY stdin/stdout）时使用。纯编排（启停 Session、读文件）可只用 REST。

控制面提供**两条并行通道**，消息格式相同；WebSocket 为默认，HTTP（SSE + POST）供 WS 被禁环境使用。

| 通道 | 输出（服务端→客户端） | 输入（客户端→服务端） |
|------|----------------------|----------------------|
| WebSocket（默认） | `GET /ws/v1/terminal?sessionId=...` | WS 帧 JSON |
| HTTP 备选 | `GET /api/v1/terminal/stream?sessionId=...`（SSE） | `POST /api/v1/terminal/input` |

Web Console 默认 `auto`：先连 WS，约 4s 内未建立则自动切 HTTP。可通过环境变量 `VITE_TERMINAL_TRANSPORT=ws|http|auto` 强制指定。

### 5.1 WebSocket

```
ws://127.0.0.1:3888/ws/v1/terminal?sessionId=<session_id>&access_token=<jwt>     # 开发
wss://xensemble.dev/ws/v1/terminal?sessionId=<session_id>&access_token=<jwt>     # 生产
```

- WS 必须通过 query `access_token` 携带短期 Access Token，并通过 `sessionId` 关联已启动的 Session
- TCP/HTTP upgrade 完成不代表应用鉴权成功；收到 `{"type":"ready"}` 后才可重置重连计数
- Access Token 无效或过期时，服务端发送 `error` 并以 `4401` 关闭；客户端须先用 Refresh Token 换取新 Access Token，再发起有上限的重连
- Session 不存在或已结束会收到 error 后关闭
- 可选 `after=<seq>` 用于从终端 transcript 游标恢复；`output` / `exit` 下行会附带 `seq`

### 5.2 HTTP（SSE + POST）

**输出流**（Server-Sent Events）：

```http
GET {BASE}/api/v1/terminal/stream?sessionId=<session_id>&access_token=<jwt>
Accept: text/event-stream
```

浏览器 `EventSource` 无法自定义 Header，须用 query `access_token`；原生客户端也可传 `Authorization: Bearer <jwt>`。
SSE 支持原生续传：服务端会为带 `seq` 的事件写入 `id: <seq>`，浏览器断线后会自动携带 `Last-Event-ID`；也可显式传 `?after=<seq>` 指定起点。

每条 SSE 的 `data` 字段为 JSON，与 WS 下行消息相同：

```
id: 42
data: {"type":"output","data":"...","seq":42}

id: 43
data: {"type":"exit","data":0,"seq":43}
```

收到 `error` 或 `exit` 后流结束。

**输入**：

```http
POST {BASE}/api/v1/terminal/input
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "session_id": "sess_...",
  "type": "input",
  "data": "ls -la\r"
}
```

`type` 亦可为 `resize`，附带 `cols`、`rows`。须 JWT 且 Session 属于当前用户。

### 5.3 消息格式（WS 与 HTTP 共用）

**客户端 → 服务端**

| type | 字段 | 说明 |
|------|------|------|
| `input` | `data` | 键盘/粘贴输入（含 ANSI 转义） |
| `resize` | `cols`, `rows` | 终端尺寸 |

**服务端 → 客户端**

| type | 字段 | 说明 |
|------|------|------|
| `ready` | — | WebSocket 应用鉴权及终端订阅已成功 |
| `output` | `data`, `seq?` | PTY 输出（含 ANSI）；带 transcript 时附游标 |
| `metrics` | `data` | `{ "cpu": 0.12, "memory": 45678912 }`，约 3s 一次 |
| `error` | `data` | 错误说明；连接随后关闭 |
| `exit` | `data`, `seq?`, `message?` | 进程退出码；可选格式化消息；支持 transcript 游标 |

连接成功后，服务端可能先 replay 缓冲区历史 output；带 transcript 的会话会按 `seq` 顺序回放并支持 `after` 断点续传。旧会话若仅存在 legacy `.scrollback`，仍会回放一次纯 `output`，保持兼容。

---

## 6. LLM 反代（Agent 进程用）

Gateway 模式下，Agent CLI 不直连 UniGateway，而是请求控制面 `{BASE}/api/v1/llm`。鉴权使用**会话 token**（`xel_*`），由 `session/start` 在 spawn 时注入 Agent 环境变量，**不是**用户 JWT。

| 路径 | 说明 |
|------|------|
| `GET /api/v1/llm/health` | 健康检查 |
| `POST /api/v1/llm/v1/chat/completions` | OpenAI 兼容 |
| `POST /api/v1/llm/v1/messages` | Anthropic 兼容 |
| `POST /api/v1/llm/v1/embeddings` | Embeddings |

Header：`Authorization: Bearer xel_...` 或 `X-Api-Key: xel_...`

详情见 [LlmProxy.md](./LlmProxy.md)。Desktop 客户端通常**不需要**直接调用此组 API，除非自行实现 Agent 运行时。

---

## 7. 管理员 API

所有 `/api/v1/admin/*` 路由需 JWT 且 `role=admin`。完整契约见 [UserManagement.md](./UserManagement.md) §7.2。

主要分组：

- **用户**：`/api/v1/admin/users` CRUD、配额、Agent 授权、重置密码
- **平台设置**：`/api/v1/admin/platform-settings`（含 `registration_mode`）
- **Agent 运维**：`/api/v1/admin/agents`、install/uninstall/update、agent-secrets、gateway-spawn-preview
- **Gateway**：`/api/v1/admin/gateway/*`（UniGateway 状态、providers、config）

---

## 8. Desktop 客户端典型流程

```
1. POST /api/v1/auth/login          → 保存 token
2. GET  /api/v1/auth/me             → 展示配额
3. GET  /api/v1/agents              → 选择 Agent
4. POST /api/v1/projects            → 创建项目（或 GET 列表）
5. POST /api/v1/secrets             → 配置 Agent 所需 API Key（BYOK 模式）
6. POST /api/v1/session/start        → 获得 session_id
7. [可选] 终端：WS 或 HTTP SSE+POST（见 §5）
8. GET  /api/v1/workspace/files      → 浏览产出文件
9. DELETE /api/v1/sessions/:id       → 结束 Session
```

### curl 示例

```bash
BASE=https://xensemble.dev

# 登录
TOKEN=$(curl -sS -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret123"}' \
  | jq -r .token)

# 列出 Agent
curl -sS "$BASE/api/v1/agents" -H "Authorization: Bearer $TOKEN"

# 创建项目
curl -sS -X POST "$BASE/api/v1/projects" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo"}'

# 启动 Session
curl -sS -X POST "$BASE/api/v1/session/start" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"kimi-code","project_id":"proj_xxx"}'
```

### 参考实现

Web Console 中的 HTTP 封装见 `client/src/lib/api.js`；终端传输（WS + HTTP 回退）见 `client/src/lib/terminalTransport.js`、`client/src/components/AgentConsole.jsx`。Desktop 可按相同约定移植。

---

## 9. 实现位置索引

| 模块 | 路径 |
|------|------|
| 路由注册 | `server/src/server.js` |
| 认证路由 | `server/src/routes/auth.js` |
| 管理路由 | `server/src/routes/admin.js` |
| JWT / Vault | `server/src/auth/index.js` |
| 终端 bridge | `server/src/session/terminalBridge.js` |
| 终端 WS | `server/src/server.js`（`/ws/v1/terminal`） |
| 终端 HTTP | `server/src/routes/terminalHttp.js` |
| LLM 反代 | `server/src/llm/proxy.js` |
| Preview 反代 | `server/src/preview/gateway.js` |
