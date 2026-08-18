# XEnsemble 生产架构设计

> 状态：生产架构规范  
> 日期：2026-06-19  
> 适用范围：`server/` 控制面、`gateway/` LLM Gateway、`web/` Web Console、`desktop/` Desktop Client、Runtime Provider  

---

## 1. 设计目标

将 XEnsemble 从“带 Web Console 的 Local MVP”演进为**以后台服务为核心、Web Console 为主入口**的生产架构：

1. **在线 Web Coding 为主入口**：普通用户通过浏览器完成代码编辑、Web Terminal、iframe Preview 等 Coding 操作；`web/` 是日常工作流的主界面。
2. **Client-Server 模式**：XEnsemble Server 作为独立后台服务运行；Desktop Client 作为可选原生客户端，与 Web Console 共用同一套控制面 API。
3. **Web 管理面与 Coding 一体**：`web/` 同时承载普通用户 Console（Session / Terminal / Preview / Workspace）与 Admin 管理台、平台状态、登录/注册。
4. **执行面三层 Provider**：执行面统一通过 `RuntimeProvider` 抽象管理生命周期，按部署成熟度分为 Local Process、BoxLite Managed Sandbox、K8s Production Runtime 三层；控制面 API、Session、Deployment、Workspace 逻辑不得绑定具体底层。
5. **生产就绪默认**：强制安全密钥、Refresh Token、进程级隔离、Secrets 不落地。Local 层服务于开发/PC/单机早期部署；BoxLite 层服务于托管 sandbox 隔离；K8s 层服务于多机、多用户、弹性伸缩的生产运维部署。

用户可见概念（Workspace / Session / Agent / Image / Environment / Gateway）与 Console 主路径见 **[`Concepts.md`](./Concepts.md)**。

---

## 2. 核心约束

| 约束 | 说明 |
|------|------|
| Web Console 是用户 Coding 主入口 | 普通用户的终端、文件编辑、iframe 预览等操作在 `web/` 提供；后台 Coding 类 API 同时服务 Web 与 Desktop Client。 |
| Desktop Client 为可选入口 | 登录、Agent、终端、预览等能力可通过 Desktop Client 完成，与 Web 共用协议；不替代 Web 主路径。 |
| Web 管理面保留 | Admin 管理、用户/Agent/平台配置、状态展示等仍通过 `web/` 操作。 |
| 执行面三层实现 | Local Process 便于开发/PC/单机部署；BoxLite 提供托管 sandbox 隔离；K8s 面向多机、多用户、弹性伸缩生产运维。 |
| 向后兼容协议 | 现有 REST/WS 消息格式尽量保留，仅在鉴权层增强（WS 也带 token）。 |
| 执行面抽象不变 | 继续沿用 `RuntimeProvider / ExecAdapter / FsAdapter / PreviewAdapter` 四层接口。 |

---

## 3. 方案选型

### 方案 A：Local Process Runtime
Desktop Client 或 Self-Hosted Server 使用 **Local Runtime Provider**，Agent/Preview 作为本机进程运行。

- **适用**：开发、个人 PC、本地调试、小团队单机部署。
- **优点**：部署简单、无需外部 sandbox 或集群、调试成本低。
- **缺点**：隔离性弱于 sandbox/K8s；需要 OS 用户、目录 jail、cgroups/systemd 加固。
- **结论**：作为默认开发模式与单机早期部署基线。

### 方案 B：BoxLite Managed Sandbox Runtime
控制面仍由 XEnsemble Server 负责，Runtime Provider 替换为 **BoxLiteRuntimeProvider**，通过 BoxLite API 创建 sandbox、执行 Agent、管理 workspace 与 preview。

- **适用**：需要比本地进程更强隔离，但不希望自建 Docker/K8s 的中期生产部署。
- **优点**：隔离、资源限制、生命周期由托管 sandbox 承担；控制面改动集中在 Runtime Provider。
- **缺点**：依赖第三方服务；需确认 PTY、workspace 持久化、preview 反代、snapshot/checkpoint、secret 注入能力。
- **结论**：作为 Local 与 K8s 之间的推荐演进层。

### 方案 C：K8s Production Runtime
控制面不变，Runtime Provider 替换为 **K8sRuntimeProvider**，由 Kubernetes 负责 Pod 调度、资源限制、网络隔离、服务发现与多节点弹性。

- **适用**：多机、多用户、高并发、企业私有化、统一观测与运维。
- **优点**：标准化资源调度、强隔离、弹性伸缩、可观测、可对接企业基础设施。
- **缺点**：需要 Kubernetes 基础设施、集群运维、镜像/存储/网络策略治理。
- **结论**：作为规模化生产运维部署形态。

---

## 4. 总体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         web/ Web Console（主入口）                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐             │
│  │ 登录 / 设置  │  │ 项目管理     │  │ Agent / Session 管理 │             │
│  └─────────────┘  └─────────────┘  └─────────────────────┘             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐             │
│  │ Workspace 编辑│  │ 终端 (xterm) │  │ iframe Preview      │             │
│  └─────────────┘  └─────────────┘  └─────────────────────┘             │
│  ┌─────────────┐  ┌─────────────┐                                      │
│  │ Admin 管理台 │  │ 平台状态     │                                      │
│  └─────────────┘  └─────────────┘                                      │
└───────────────────┬─────────────────────────────────────────────────────┘
                    │ HTTPS / WSS
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       XEnsemble Server（控制面 + 执行面）                 │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐             │
│  │ Auth / Policy │ │ SessionManager│ │ RuntimeService       │             │
│  │ JWT + Refresh │ │ (bridge only) │ │ (distributed lock)   │             │
│  └──────────────┘ └──────────────┘ └──────────────────────┘             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐             │
│  │ Deployment   │ │ LLM Proxy    │ │ Events / Audit       │             │
│  │ Service      │ │ /api/v1/llm  │ │                      │             │
│  └──────────────┘ └──────────────┘ └──────────────────────┘             │
│  ┌──────────────┐ ┌──────────────┐                                      │
│  │ Admin API    │ │ Preview      │                                      │
│  │ /admin/*     │ │ Gateway      │                                      │
│  └──────────────┘ └──────────────┘                                      │
└─────────────────────────────────────────────────────────────────────────┘
                    │
                    │ RuntimeProvider
                    │  Local Process / BoxLite Sandbox / K8s Runtime
                    ▼
        ┌─────────────────────┐
        │  Agent PTY / Preview │
        │  Workspace / FS      │
        │  Runtime Lifecycle   │
        └─────────────────────┘

┌─────────────────────────────────┐
│  desktop/ Desktop Client（可选） │
│  原生终端 / 本地编辑器 / 系统浏览器│
└─────────────────────────────────┘
```

---

## 5. 组件职责

### 5.1 Web Console（`web/`）

- **身份**：浏览器端 React 应用；普通用户 Coding 与 Admin 管理的主入口。
- **职责**：
  - **Coding Console**：项目 / Agent / Session / Deployment；Web Terminal（xterm + WSS）；Workspace 文件浏览与编辑；iframe Preview。
  - **Admin 管理台**：用户/配额/Agent 授权/平台设置/Gateway 配置。
  - **状态展示**：项目列表、Session 状态、Deployment 状态、事件审计。
  - **登录/注册入口**：用户获取账号并进入 Console 工作流。
- **约束**：所有执行面操作经控制面 API/WS；不直接调用 Runtime Provider 或沙箱厂商 API。

### 5.2 Desktop Client（`desktop/`）

- **身份**：原生桌面应用（推荐 Electron / Tauri / 独立原生框架）。本项目代码位于 `desktop/`。
- **职责**：
  - 登录后台，保存 Refresh Token 到系统钥匙串，管理 Access Token 生命周期。
  - 展示项目、Agent、Session、Deployment 列表与管理界面。
  - 嵌入终端组件（xterm.js 等）通过 WSS 连接后台 `/ws/v1/terminal`。
  - 本地编辑器集成：调用用户本机 VS Code / Cursor / 其他编辑器打开 workspace；不内嵌代码编辑器。
  - 预览：收到 `publicUrl` 后调用系统默认浏览器打开；不内嵌 iframe 预览。
  - 文件同步：通过 SFTP/SSHFS/Git 或专用同步协议把 Server 端 workspace 映射到本地目录（可选）。
- **禁止**：在 Client 里直接读写后端 FS（必须通过 API/FS 适配器）。
- **定位**：可选增强入口，与 Web Console 共用控制面协议；不以 Desktop 替代 Web 主路径。

### 5.3 控制面（XEnsemble Server）

基于现有 Fastify 服务，保留并强化面向 Web / Desktop 的 Coding 与管理能力：

| 模块 | 生产化调整 |
|------|------------|
| `auth/index.js` | 强制 `JWT_SECRET`/`ENCRYPTION_KEY`；引入 Refresh Token；PBKDF2 升级到 ≥210k 次或 Argon2id。 |
| `auth/PolicyService.js` | 继续执行 quota / agent grant；增加 `checkUserActive` 全局钩子。 |
| `auth/hooks.js` | `authenticate` 校验 Access Token；新增 `requireActive`、`requireAdmin`。 |
| `runtime/*` | 保留接口；按 Local Process、BoxLite Sandbox、K8s Production 三层实现 Provider；所有具体执行面假设严格限制在对应 Provider 内。 |
| `session/SessionManager.js` | 仍只保存 bridge handle；scrollback 事实来源为 Runtime 侧（本地可由 sidecar/文件缓存实现）。 |
| `deployments/DeploymentService.js` | 状态机不变；revision 必须指向真实 `gitSha` / `snapshotId` / `checkpointId`。 |
| `llm/*` | 保留 session token 反代；移除全局 rebind 锁，改为 per-agent gateway key 或 header 路由。 |
| `gateway/*` | UniGateway 作为本地进程或外部上游；admin token 强制配置。 |
| `preview/gateway.js` | 代理预览流量；使用 deployment-scoped token 并校验 `Host`/用户状态。 |
| `events/recordEvent.js` | 保留审计。 |

### 5.4 执行面（Runtime Provider）

执行面通过同一组接口封装：`RuntimeProvider / ExecAdapter / FsAdapter / PreviewAdapter`。前台用户拉起 Agent 时，控制面仍负责鉴权、quota、session、secrets、审计与 deployment 状态；具体进程、sandbox 或 Pod 的创建由当前 Provider 负责。

#### 5.4.1 Local Process Runtime

- **定位**：开发、PC 用户、单机自托管早期部署。
- **LocalRuntimeProvider**：确保 workspace 目录存在；管理本地运行环境生命周期。
- **LocalExecAdapter**：基于 `node-pty` 提供 `spawn`；实现 `exec` 用于短任务/构建探测。
- **LocalFsAdapter**：受控文件列表/读取，严格路径 jail，禁止返回宿主机绝对路径；解析 symlink 防止越界。
- **LocalPreviewAdapter**：在本地启动 preview 进程，声明端口，注册到 Gateway。
- **安全边界**：Agent/Preview 以低权限 OS 用户运行；使用目录 jail、`RUNTIME_UID`/`RUNTIME_GID`、cgroups/systemd 加固；Secrets 仅注入环境变量，不写入 workspace。

#### 5.4.2 BoxLite Managed Sandbox Runtime（Phase 2 / 未来开发）

- **定位**：托管 sandbox 执行层，作为 Local 与自建 K8s 之间的演进层。
- **BoxLiteRuntimeProvider**：通过 BoxLite API 创建、恢复、停止、销毁 sandbox，并维护 runtime 与 project/session 的映射。
- **BoxLiteExecAdapter**：在 sandbox 内执行 Agent 命令；必须支持交互式 PTY 或等价的 stdin/stdout/resize/stream 能力。
- **BoxLiteFsAdapter**：通过 sandbox 文件 API 管理 workspace；不得向客户端暴露 sandbox 内部路径或 sandbox id。
- **BoxLitePreviewAdapter**：在 sandbox 内启动 preview，并由 XEnsemble Preview Gateway 反代；客户端仍访问 `/preview/:deploymentId`。
- **约束**：Desktop/Web 不直接调用 BoxLite；BoxLite token、内部 URL、sandbox id 均为控制面内部细节。
- **当前状态**：`server/src/runtime/BoxLiteRuntimeProvider` / `BoxLiteExecAdapter` / `BoxLiteFsAdapter` 已接 blink（默认 `RUNTIME_PROVIDER=boxlite`）；`BoxLitePreviewAdapter` 仍为 stub。详见 [`docs/Sandbox-Integration.md`](./Sandbox-Integration.md)。

#### 5.4.3 K8s Production Runtime（Phase 2 / 未来开发）

- **定位**：多机、多用户、弹性伸缩、企业私有化和统一生产运维。
- **K8sRuntimeProvider**：将 runtime/session/deployment 映射为 Pod/Job/Service/PVC 等 Kubernetes 资源。
- **K8sExecAdapter**：通过 Kubernetes exec/attach/stream 或 sidecar 提供交互式 Agent 会话。
- **K8sFsAdapter**：通过 PVC、对象存储或 sidecar 文件服务访问 workspace。
- **K8sPreviewAdapter**：通过 Service/Gateway/Ingress 暴露 preview，仍由 XEnsemble Preview Gateway 执行 token、Host、用户状态与 deployment 状态校验。
- **生产能力**：使用 requests/limits、ResourceQuota、NetworkPolicy、SecurityContext、ServiceAccount、日志与指标系统实现隔离、调度和观测。
- **当前状态**：`server/src/runtime/K8s*.js` 已提供占位实现。可通过 `RUNTIME_PROVIDER=k8s` 加载，但所有方法均返回 `501 Not Implemented`。

#### 5.4.4 接入更多沙箱后端（多沙箱 = 多 Provider）

**决策**：当出现 BoxLite/blink 之外的沙箱技术（如 Tencent [CubeSandbox](https://github.com/tencentcloud/CubeSandbox)、各类在线/托管沙箱 API）时，一律**新增一档 `RuntimeProvider` 实现**接入，而**不**在执行面（如 blink）内部再造一层"多厂商 broker"。理由：

- **抽象归属**：针对 agent 生命周期（session、quota、preview、deployment、鉴权、审计）的编排在控制面，能力协商（`supportsHibernate()`、`docs/DurableSessions.md` 的 `recoverable` 分级）也在控制面；沙箱抽象自然落在控制面的四层接口上。
- **定位与依赖方向**：blink 自身定位为"基于 BoxLite/libkrun 的 execution plane（library + service + CLI）"，明确把登录/配额/console 留给控制面（见 blink `README.md` / `docs/PRODUCT.md`）。控制面依赖执行后端，而非相反；让执行后端去 broker 其它厂商会造成定位冲突与依赖倒置。
- **零控制面侵入**：新增后端只需实现 `RuntimeProvider / ExecAdapter / FsAdapter / PreviewAdapter` 四件套，并在 `registry.js` 增加分支；`server.js`、SessionManager、Deployment、Gateway、鉴权/quota 均不改动。

**接入规范**（沿用 §5.4.2 BoxLite 的约束）：

- **Provider 映射**：维护 `runtimeId ↔ 厂商 sandbox id/name` 映射，**绝不向客户端暴露**厂商内部 id、token 或内部 URL。
- **Exec**：`spawn` 提供交互式 PTY（或等价 stdin/stdout/resize/stream），`exec` 跑短任务/git 操作。
- **Fs**：无原生文件 API 时先用 session 内 `exec`（`ls`/`cat`）兜底，后续有原生端点再替换。
- **Preview**：由 XEnsemble Preview Gateway 反代，客户端仍访问 `/preview/:deploymentId`。
- **能力差异显式声明**：托管/在线沙箱可能不支持 checkpoint/export/warm；用 `supportsHibernate()` 与 `recoverable` 分级表达，控制面按能力降级（如不支持 resume 则退回 transcript 续传），**禁止在控制面硬编码某后端专有能力**。

**优先复用 blink 的 REST 契约作为归一化协议**：若为某厂商写一层 shim，使其对外说 blink `docs/XENSEMBLE.md` 的 REST 方言，则 XEnsemble 现成的 `BoxLite*Adapter` 可近乎零改动复用，省去一整套 Adapter；仅当厂商 API 差异过大时才单独实现 Provider。即：**抽象是协议，blink 是参考实现之一**，而非抽象本身。

### 5.5 LLM Gateway

- `gateway/` Rust 二进制继续作为可选内置 LLM 路由。
- 生产推荐以外部 UniGateway（`LLM_GATEWAY_UPSTREAM_URL`）运行，控制面只负责 session token 鉴权与转发。
- Desktop Client / Web Console 不直接连接 UniGateway。

---

## 6. 通信协议

### 6.1 认证

- **登录**：`POST /api/v1/auth/login` 返回 `{ access_token, refresh_token, user, quotas }`。
- **刷新**：`POST /api/v1/auth/refresh` 用 Refresh Token 换取新的 Access Token。
- **Access Token**：短期（如 15 分钟），用于 API/WS。
- **Refresh Token**：长期（如 30 天），存储于 `refresh_tokens` 表，支持撤销与设备绑定。
- Desktop Client 使用系统钥匙串保存 Refresh Token；Web Console 使用安全的浏览器存储策略。

### 6.2 REST API

保留并加固现有接口：

- `/api/v1/auth/*`
- `/api/v1/admin/*`（Web 管理面与 Desktop Client 共用）
- `/api/v1/projects/*`
- `/api/v1/sessions/*`
- `/api/v1/deployments/*`
- `/api/v1/runtimes/*`
- `/api/v1/secrets`
- `/api/v1/agents`（按授权过滤）
- `/api/v1/llm/*`（Agent 使用，非 Client 直接调用）
- `/api/v1/workspace/*`（受控文件列表/读取/写入，供 Web Console 与 Desktop Client 使用）

**约束**：
- CORS 不允许 `origin: '*'`；改为只允许配置的 Web Console origin 与 Desktop Client origin。

### 6.3 WebSocket 终端

- 路径：`/ws/v1/terminal?sessionId=...&access_token=...`
- 必须携带 Access Token；后台校验 token、用户 `active`、session 归属与 `status === 'running'`。
- 消息格式与现有协议保持一致。
- HTTP(SSE+POST) 回退保留，供企业防火墙环境使用。
- Web Console 与 Desktop Client 均可使用 Web Terminal。

### 6.4 Preview 访问

- Preview URL 形如 `https://<server>/preview/<deploymentId>/...`。
- 使用 **deployment-scoped token**（短期、绑定 deploymentId），而非用户 JWT。
  - 通过 `POST /api/v1/projects/:id/preview`、`POST /api/v1/deployments`、`POST /api/v1/deployments/:id/start` 生成/轮换。
  - 已有 running deployment 可通过 `POST /api/v1/deployments/:id/preview-token` 签发新 token。
  - 访问时通过 `x-preview-token` header 或 `?preview_token=...` query 携带。
- Web Console 以 iframe 嵌入 Preview；Desktop Client 可调用系统浏览器打开同一 URL。
- Gateway 校验 Host 白名单、token、deployment 状态、用户 `active`、project 归属。

---

## 7. 数据模型调整

### 7.1 新增

- `refresh_tokens(id, user_id, token_hash, device_name, created_at, expires_at, revoked_at)`
- `runtime_providers` 配置表（可选，用于动态 provider 选择）

### 7.2 保留

- `users`（扩展 `status`、`last_login_at` 等）
- `user_quotas`、`user_agent_grants`
- `platform_settings`
- `projects`（保留 `default_runtime_id`；`server_path` 仅为 Local Provider 内部字段，不得通过 API 暴露）
- `runtimes`（一等实体；provider 可为 `local`、`boxlite`、`k8s`）
- `sessions`（含 `runtime_id`、`stream_ref`、`recoverable`）
- `deployments`（状态机 + `revision` + `preview_token_hash`）
- `events`
- `repo_snapshots`、`workspace_checkpoints`、`dev_environment_profiles`

### 7.3 废弃/移除

- 不再把 `scrollback` 作为控制面持久化字段；事实来源在 Runtime 侧（本地可用文件/ring-buffer 缓存）。
- 内存单飞/内存配额（替换为 Redis）。
- 硬编码 JWT/加密密钥回退。
- `trustProxy: true` 默认开启。
- CORS `origin: '*'`。

---

## 8. 安全与隔离

| 层面 | 要求 |
|------|------|
| 控制面 | 强制 `JWT_SECRET`/`ENCRYPTION_KEY`；关闭 `trustProxy` 或配置可信代理；CORS 受限；所有管理面需 admin。 |
| 认证 | Access/Refresh Token 分离；Refresh Token 可撤销；密码哈希升级。 |
| 进程隔离（第一阶段） | Server 进程与 Agent/Preview 进程运行在不同 OS 用户；目录 jail；cgroups/systemd 限制资源；禁止 Agent 访问 Server 代码/配置/数据库。 |
| 路径隔离 | `LocalFsAdapter` 强制 jail；解析 symlink；禁止返回绝对路径；不同 project 使用独立 workspace 目录。 |
| Secrets | 仅启动/重启时注入；不写入镜像、volume、deployment record、build log；provider key 不存明文 TOML。 |
| Preview | deployment-scoped token；校验 Host；公开/租户内两种模式可配置。 |
| Desktop Client | Refresh Token 存系统钥匙串；不缓存用户 secrets 明文。 |
| Web Console | 普通用户 Coding 与 Admin 分权；Admin API 需 admin 校验；终端/Preview/Workspace 均走鉴权 API。 |

---

## 9. 可扩展性

- **水平扩展**：
  - Session bridge 状态外置到 Redis / NATS，或 Runtime Provider 直接暴露 stream endpoint。
  - 配额/单飞状态使用 Redis-backed distributed lock。
  - 数据库使用 PostgreSQL 替代 SQLite。
- **多 Runtime Provider**：通过 `runtime/registry.js` 插件化加载 Local Process / BoxLite Sandbox / K8s Production provider。
- **LLM Gateway**：支持外部上游，控制面无状态转发。

---

## 10. 部署拓扑（三层 Runtime）

### 10.1 单节点自托管

```
[Server]
  ├─ XEnsemble Server (Node.js, port 3888)
  ├─ UniGateway (Rust, 127.0.0.1:8741)
  ├─ SQLite / Postgres
  └─ Local Execution Environment
      ├─ Agent PTY processes (node-pty)
      ├─ Preview processes
      └─ Workspace directories

[Web Console]     ──HTTPS/WSS──▶ [Server]
[Desktop Clients] ──HTTPS/WSS──▶ [Server]（可选）
[Admin Browser]   ──HTTPS──────▶ [Server]（Web 管理面）
```

### 10.2 BoxLite 托管 Sandbox

```
[Server]
  ├─ XEnsemble Server (Node.js, port 3888)
  ├─ UniGateway
  ├─ SQLite / Postgres
  └─ BoxLiteRuntimeProvider ──API──▶ [BoxLite Sandbox Fleet]
                                      ├─ Agent PTY / stream
                                      ├─ Workspace filesystem
                                      └─ Preview process

[Web Console]     ──HTTPS/WSS──▶ [Server]
[Desktop Clients] ──HTTPS/WSS──▶ [Server]（可选）
[Preview Browser] ──HTTPS──────▶ [Server Preview Gateway] ──▶ [BoxLite Sandbox]
```

### 10.3 K8s 多机生产运维

```
[Nginx / LB]
   ├── Server Instance 1
   ├── Server Instance 2
   └── Server Instance N
   [Shared Postgres]
   [Shared Redis]
   [K8s Runtime Cluster]
      ├─ Runtime / Session Pods
      ├─ Preview Services
      ├─ Workspace PVC / Object Storage
      └─ Metrics / Logs / Events
```

---

## 11. 移除/废弃清单

| 能力 | 处理方式 | 说明 |
|------|----------|------|
| Web Console（Coding + Admin） | **保留并强化** | 用户 Coding 主入口；与 Desktop Client 共用 API。 |
| Desktop Client | **保留（可选）** | 原生终端 / 本地编辑器 / 系统浏览器预览。 |
| 内存单飞/内存配额 | 替换为 Redis | 支持多实例。 |
| 硬编码 JWT/加密密钥 | 删除回退 | 未配置则启动失败。 |
| `trustProxy: true` 默认 | 关闭或白名单 | 防止 IP/协议欺骗。 |
| CORS `origin: '*'` | 受限 | 只允许 Web Console 与 Desktop Client origin。 |
| K8s 作为第一阶段默认 | 推迟到生产运维层 | 先使用 Local Process 降低部署门槛；需要托管隔离时优先接 BoxLite。 |

---

## 12. 迁移路径

### Phase 1 — 强化 Web Console & 认证 & 本地执行加固
1. 保留并持续完善 `web/` Coding 入口（Web Terminal、iframe Preview、Workspace 编辑）。
2. 保留并加固 Web Admin UI。
3. WS 终端加 `access_token` 鉴权。
4. 引入 Refresh Token；强制生产环境配置 `JWT_SECRET`/`ENCRYPTION_KEY`。
5. 升级密码哈希参数。
6. 完善 Local Runtime Provider：
   - 实现 `LocalExecAdapter.exec`。
   - 实现 `RuntimeProvider.attachSession` 与本地 scrollback 缓存（文件/ring-buffer）。
   - 加固 `LocalFsAdapter` 路径 jail（解析 symlink、禁止绝对路径）。
   - Local preview 注入 scoped secrets。
7. 限制 Agent/Preview 进程权限（独立 OS 用户、cgroups、目录 jail）。

### Phase 2 — 真实 Revision & 状态外部化
1. Deployment revision 指向真实 checkpoint/gitSha/snapshot。
2. Session bridge 外置（Redis/NATS 或本地文件快照）。
3. Quota / singleflight 使用 Redis。
4. 支持 PostgreSQL。

### Phase 3 — BoxLite Runtime Provider
1. 实现 BoxLiteRuntimeProvider / BoxLiteExecAdapter / BoxLiteFsAdapter / BoxLitePreviewAdapter。
2. 验证交互式 PTY、workspace 持久化、preview 反代、snapshot/checkpoint 与 secret 注入能力。
3. 通过配置切换 provider，保持 Web Console / Desktop Client 不变。

### Phase 4 — K8s Production Runtime Provider
1. 实现 K8sRuntimeProvider 全套 adapter。
2. 接入 Pod/Service/PVC/ResourceQuota/NetworkPolicy/SecurityContext。
3. 支持多控制面实例 + 负载均衡 + Shared Postgres/Redis。
4. 子域名 Preview Gateway 与外部 UniGateway 生产部署。

---

## 13. 非目标

- 公共 SaaS 多租户计费。
- 完整的 CI/CD pipeline（可由外部 GitHub Actions 触发平台 API）。
- 原生移动端 Client（先聚焦 Web；Desktop 为可选增强）。

---

## 14. 相关文档

- 客户端 API：`docs/ApiClient.md`
- 用户/配额：`docs/UserManagement.md`
- LLM 反代：`docs/LlmProxy.md`
- Agent 说明：`docs/agents.md`
- Agent 镜像（boxlite 构建、绑定、Admin 注册）：`docs/Agent-Images.md`
- Desktop Client：`desktop/README.md`、`desktop/DESIGN.md`、`desktop/AGENTS.md`
- Web UI：`DESIGN.md`、`docs/Designs.md`
