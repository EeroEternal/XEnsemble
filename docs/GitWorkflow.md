# Git 工作流集成设计（多平台 Provider）

> 状态：设计草案 v2  
> 日期：2026-06-22  
> 适用范围：`server/` 控制面、`desktop/` Desktop Client、`client/` Web 管理面  
> 依赖：`docs/Architecture.md`（执行面三层 Provider）、`docs/ApiClient.md`（REST/WS 协议）、`docs/LocalGit.md`（本地 Git 版本跟踪）

> **设计理念**：XEnsemble 自身具备完整的 Git 版本管理能力（内置 Git），用户无需任何外部 Git 平台即可工作。同时通过 **OAuth + Provider 抽象** 支持与 GitHub、GitLab、Gitea/Forgejo、Bitbucket 等外部平台集成，实现双向同步和 PR/MR 提交。

---

## 1. 设计目标

### 1.1 两层 Git 架构

```
Layer 1 — 内置 Git（所有用户默认可用）
  ├─ 每个项目自动拥有 Git 仓库（workspace = .git）
  ├─ 本地分支管理、commit、checkpoint、回滚
  ├─ 内置 bare repo 作为平台"远端"（多 session 共享）
  └─ 无需外部账号，零配置开始工作

Layer 2 — 外部 Git Provider（可选，按需连接）
  ├─ 通过 OAuth 连接 GitHub / GitLab / Gitea 等
  ├─ 导入外部仓库 → 同步到内置 Git
  ├─ 双向同步 + 创建 PR/MR
  └─ Provider 抽象：统一接口，差异化适配器
```

### 1.2 核心用户故事

**场景 1 — 零配置用户（无外部 Git 平台）**
1. 创建项目 → 自动初始化内置 Git 仓库
2. Agent session 在分支上开发 → 自动 checkpoint commit
3. 浏览代码历史、diff、回滚到任意检查点
4. 完整的本地 Git 工作流，无需任何外部服务

**场景 2 — 连接 GitHub 的用户**
1. 通过 OAuth 连接 GitHub 账号
2. 导入 GitHub 仓库 → clone 到 workspace
3. Agent session 在独立分支上开发
4. 一键提交 Pull Request 回 GitHub

**场景 3 — 企业内部 GitLab**
1. 通过 OAuth 连接自建 GitLab 实例
2. 导入仓库 → Agent 开发 → 提交 Merge Request

**场景 4 — 混合多平台**
1. 同时管理多个项目：部分来自 GitHub、部分来自 GitLab、部分纯本地
2. 统一的分支/PR 管理界面

### 1.3 非目标（Phase 1）

- GitHub App 安装方式（Phase 1 统一使用 OAuth；GitHub App 为可选增强，见 Phase 3）
- Webhook 驱动的实时 PR 事件同步（先使用轮询 + 用户触发刷新）
- 代码 Review 界面（用户在 Git 平台上完成 Review）
- GitLab / Gitea Provider 实现（Phase 2 实现，但 Phase 1 架构已预留 Provider 接口）
- CI/CD 集成（GitHub Actions / GitLab CI 等）

---

## 2. 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Desktop Client                                │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────────┐       │
│  │ Git Provider  │  │ Repo Import │  │ Branch / PR 管理  │       │
│  │ OAuth 连接    │  │ 选库 / Clone │  │ 创建 / 查看 / 同步│       │
│  └──────────────┘  └─────────────┘  └──────────────────┘       │
└───────────────────┬─────────────────────────────────────────────┘
                    │ HTTPS / WSS
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    XEnsemble Server 控制面                       │
│                                                                  │
│  ┌───────────────────────────────────────────────────────┐      │
│  │              GitProviderService (抽象接口)              │      │
│  │  OAuth / listRepos / createPR / getPR / getUser       │      │
│  ├───────────┬────────────┬──────────────┬───────────────┤      │
│  │  GitHub   │   GitLab   │ Gitea/Forgejo│  Bitbucket   │      │
│  │  Adapter  │   Adapter  │   Adapter    │   Adapter    │      │
│  │ (Phase 1) │  (Phase 2) │  (Phase 2)   │  (Phase 2+)  │      │
│  └───────────┴────────────┴──────────────┴───────────────┘      │
│                                                                  │
│  ┌─────────────────┐  ┌───────────────────┐                     │
│  │GitOperationSvc   │  │ RepositoryEnv     │                    │
│  │clone/branch/     │  │ (已有 + 扩展)     │                    │
│  │commit/push       │  └───────────────────┘                    │
│  │(平台无关)        │  ┌───────────────────┐                    │
│  └─────────────────┘  │ RuntimeProvider    │                    │
│                        │ (workspace FS)     │                    │
│  ┌─────────────────┐  └───────────────────┘                    │
│  │LocalGitService   │                                           │
│  │(内置 Git 管理)   │                                           │
│  │checkpoint/restore│                                           │
│  └─────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘
                    │
                    ▼
    ┌───────────┬──────────────┬──────────────┐
    │ GitHub API│  GitLab API  │  Gitea API   │
    │ (REST v3) │  (REST v4)   │  (REST v1)   │
    └───────────┴──────────────┴──────────────┘
```

**关键设计决策：**

- **Git 操作在 Runtime 侧执行**：clone/pull/push/branch 等 git 命令通过 `ExecAdapter` 在 workspace 所在的执行环境中运行（Local、BoxLite、K8s 均适用）。控制面只负责编排、鉴权和状态记录。
- **平台 API 调用在控制面**：OAuth token 管理、平台 REST API（仓库列表、PR 创建/查询）在控制面通过 Provider 适配器执行，token 不注入 agent 环境。
- **Git 认证通过临时凭据**：push/pull 时，控制面签发短期 credential（`GIT_ASKPASS`），避免长期 token 落地到 workspace。
- **内置 Git 与外部 Provider 独立**：内置 Git（LocalGitService）管理 workspace 版本跟踪，外部 Provider 是可选增强。两者可以共存——外部仓库导入后，内置 Git 的 checkpoint 机制仍然工作。

---

## 3. GitProviderService 抽象接口

### 3.1 接口定义

所有外部 Git 平台通过统一的 `GitProviderService` 接口接入。每个平台实现一个 Adapter。

```js
// server/src/git/providers/GitProviderService.js

class GitProviderService {
  /** Provider 标识 */
  get name() {}            // 'github' | 'gitlab' | 'gitea' | 'bitbucket'
  get displayName() {}     // 'GitHub' | 'GitLab' | 'Gitea' | 'Bitbucket'

  /** PR 术语（GitHub/Gitea 叫 Pull Request，GitLab 叫 Merge Request） */
  get prTerminology() {}   // { singular: 'Pull Request', plural: 'Pull Requests', abbreviation: 'PR' }

  // ── OAuth ──
  buildAuthUrl(clientId, callbackUrl, state, scope) → string
  exchangeCode(code, { clientId, clientSecret, callbackUrl }) → { accessToken, refreshToken?, expiresIn?, scope }
  refreshAccessToken(refreshToken, { clientId, clientSecret }) → { accessToken, refreshToken?, expiresIn? }

  // ── User ──
  getAuthenticatedUser(token) → { id, username, displayName, avatarUrl, email }

  // ── Repositories ──
  listUserRepos(token, { page, perPage, search? }) → { repos: [RepoInfo], hasMore }
  getRepo(token, repoIdentifier) → RepoInfo
  //   RepoInfo = { id, fullName, cloneUrl, defaultBranch, private, description, language, updatedAt }

  // ── Pull Request / Merge Request ──
  createPR(token, repoIdentifier, { title, body, head, base }) → PRInfo
  getPR(token, repoIdentifier, prNumber) → PRInfo
  listPRs(token, repoIdentifier, { state, page, perPage }) → [PRInfo]
  //   PRInfo = { number, url, title, body, state, merged, headRef, baseRef, mergeCommitSha }

  // ── Token ──
  revokeToken(token, { clientId, clientSecret }) → void

  // ── Utility ──
  parseRepoIdentifier(fullName) → { owner, repo }   // GitHub/Gitea: owner/repo; GitLab: group/subgroup/project
  buildCloneUrl(repoIdentifier) → string
}
```

### 3.2 各平台差异对照

| 能力 | GitHub | GitLab | Gitea/Forgejo | Bitbucket |
|------|--------|--------|---------------|-----------|
| **OAuth Authorize URL** | `github.com/login/oauth/authorize` | `{host}/oauth/authorize` | `{host}/login/oauth/authorize` | `bitbucket.org/site/oauth2/authorize` |
| **Token Exchange URL** | `github.com/login/oauth/access_token` | `{host}/oauth/token` | `{host}/login/oauth/access_token` | `bitbucket.org/site/oauth2/access_token` |
| **Token 类型** | 不过期（直到用户撤销） | 有 refresh token，2h 过期 | 不过期 | 有 refresh token，2h 过期 |
| **API 基址** | `api.github.com` 或 GHE `/api/v3` | `{host}/api/v4` | `{host}/api/v1` | `api.bitbucket.org/2.0` |
| **列出仓库** | `GET /user/repos` | `GET /projects?membership=true` | `GET /user/repos` | `GET /repositories/{workspace}` |
| **创建 PR/MR** | `POST /repos/{owner}/{repo}/pulls` | `POST /projects/{id}/merge_requests` | `POST /repos/{owner}/{repo}/pulls` | `POST /repositories/{workspace}/{repo}/pullrequests` |
| **Scope** | `repo` | `api` | 无 scope（全权限） | `repository:write`, `pullrequest:write` |
| **PR 术语** | Pull Request | Merge Request | Pull Request | Pull Request |
| **Repo 标识** | `owner/repo` | `group/subgroup/project` (path) 或 numeric ID | `owner/repo` | `workspace/repo` |

### 3.3 Provider 注册与解析

```js
// server/src/git/providers/registry.js

const providers = new Map();

function registerProvider(name, AdapterClass) {
  providers.set(name, AdapterClass);
}

function getProvider(name) {
  const Adapter = providers.get(name);
  if (!Adapter) throw new Error(`Unknown git provider: ${name}`);
  return new Adapter();
}

function listProviders() {
  return [...providers.keys()];
}

// Phase 1: 仅注册 GitHub
registerProvider('github', require('./GitHubAdapter'));
// Phase 2:
// registerProvider('gitlab', require('./GitLabAdapter'));
// registerProvider('gitea', require('./GiteaAdapter'));
```

---

## 4. OAuth 认证（统一流程）

### 4.1 统一 OAuth 流程

所有平台使用相同的 OAuth 流程，仅参数不同：

```
Desktop Client                   Server                        Git Platform
     │                              │                              │
     │  1. POST /git/connect        │                              │
     │  body: { provider }          │                              │
     │  ← { auth_url, state }      │                              │
     │                              │                              │
     │  2. 打开系统浏览器           │                              │
     │  → {platform}/authorize      │                              │
     │     ?client_id=...           │                              │
     │     &redirect_uri=server/cb  │                              │
     │     &scope=...               │                              │
     │     &state=<state>           │                              │
     │                              │                              │
     │                              │  3. 用户授权后平台回调        │
     │                              │  ← GET /git/callback          │
     │                              │     ?code=...&state=...       │
     │                              │                              │
     │                              │  4. Provider.exchangeCode     │
     │                              │  → POST {platform}/token      │
     │                              │  ← access_token (+refresh)   │
     │                              │                              │
     │                              │  5. 加密存储 token，标记完成  │
     │                              │  → git_connections 表         │
     │                              │  → 返回 HTML「请返回 Desktop」│
     │                              │                              │
     │  6. Desktop 轮询（2s 间隔）  │                              │
     │  GET /git/connection         │                              │
     │  ← { connected: true, ... }  │                              │
```

Desktop Client **不使用**自定义协议（`xensemble://`），而是采用 **Server 回调 + Desktop 轮询** 模式：

1. Desktop 调用 `POST /api/v1/git/connect` 并传入 `{ provider: 'github' }`
2. Server 通过 Provider 适配器构建 `auth_url`，存储 state
3. 调用 `shell.openExternal(auth_url)` 在系统浏览器中打开授权页
4. Server 的 `GET /api/v1/git/callback` 完成 code→token 交换后，返回 HTML 页面
5. Desktop 以 2s 间隔轮询 `GET /api/v1/git/connection`，检测 `connected: true` 后停止
6. 轮询超时 5 分钟后放弃，提示用户重试

### 4.2 平台配置（Admin）

Admin 在 Settings → **Git Providers** 面板为每个平台配置 OAuth 凭据：

```json
// platform_settings 表中的配置结构
// key: GIT_PROVIDER_{PROVIDER_NAME}_CONFIG
// value: JSON

// GitHub 配置示例
{
  "provider": "github",
  "enabled": true,
  "display_name": "GitHub",
  "client_id": "Ov23li...",
  "client_secret_enc": "<encrypted>",
  "callback_url": "https://your-domain.com/api/v1/git/callback",
  "api_base": "https://api.github.com",
  "authorize_url": "https://github.com/login/oauth/authorize",
  "token_url": "https://github.com/login/oauth/access_token",
  "scope": "repo"
}

// GitLab 自建实例配置示例
{
  "provider": "gitlab",
  "enabled": true,
  "display_name": "GitLab (Corp)",
  "client_id": "app_id_...",
  "client_secret_enc": "<encrypted>",
  "callback_url": "https://your-domain.com/api/v1/git/callback",
  "api_base": "https://gitlab.corp.com/api/v4",
  "authorize_url": "https://gitlab.corp.com/oauth/authorize",
  "token_url": "https://gitlab.corp.com/oauth/token",
  "scope": "api"
}
```

支持同时配置多个 Provider（包括同一平台的多个实例，如 github.com + GHE）。

### 4.3 GitHub OAuth App 创建指南

> 以下步骤指导 Admin 在 GitHub 上创建 OAuth App。

1. 登录 GitHub → 进入 **Settings → Developer settings → OAuth Apps → New OAuth App**
   - 直达链接：<https://github.com/settings/applications/new>
2. 填写表单：

| 字段 | 值 | 说明 |
|------|-----|------|
| Application name | `XEnsemble` | 用户授权时看到的名称 |
| Homepage URL | `https://your-domain.com` | XEnsemble 公网地址或文档页 |
| Authorization callback URL | `https://your-domain.com/api/v1/git/callback` | **必须与 Server 配置一致** |

3. 点击 **Register application**，进入 App 详情页：
   - 复制 **Client ID** → 填入 XEnsemble Settings → Git Providers → GitHub
   - 点击 **Generate a new client secret** → 复制 → 填入 Client Secret
   - Client Secret 只展示一次，请立即保存
4. （可选）上传 Logo，设置 App 描述

> **GitHub Enterprise Server**：将上述 `github.com` 替换为 GHE 域名。

### 4.4 GitLab OAuth Application 创建指南

1. 登录 GitLab → **Preferences → Applications**（个人）或 **Admin Area → Applications**（实例级）
2. 填写：

| 字段 | 值 |
|------|-----|
| Name | `XEnsemble` |
| Redirect URI | `https://your-domain.com/api/v1/git/callback` |
| Scopes | `api`（读写仓库、创建 MR） |
| Confidential | ✅ 勾选 |

3. 保存后获取 Application ID + Secret

### 4.5 Gitea/Forgejo OAuth2 Application 创建指南

1. 登录 Gitea → **Site Administration → Applications → Create OAuth2 Application**
2. 填写 Application Name、Redirect URI
3. 保存后获取 Client ID + Client Secret

---

## 5. 数据模型

### 5.1 数据模型演进（Phase 1 → Phase 2）

Phase 1 已实现的 `github_connections` 和 `pull_requests` 表将在 Phase 2 泛化为 `git_connections` 和 `merge_requests`。Phase 1 代码在 GitHub-only 场景下继续工作，Phase 2 通过迁移脚本升级。

### 5.2 Phase 2 目标表结构

#### `git_connections`（替代 `github_connections`）

用户级 Git 平台连接（OAuth token 存储），支持多平台。

```sql
CREATE TABLE git_connections (
  id               TEXT PRIMARY KEY,          -- 'gitconn_...'
  user_id          TEXT NOT NULL REFERENCES users(id),
  provider         TEXT NOT NULL,             -- 'github' | 'gitlab' | 'gitea' | 'bitbucket'
  provider_config  TEXT,                      -- 指向 platform_settings 中的 provider config key（支持同平台多实例）
  remote_user_id   TEXT NOT NULL,             -- 平台用户 ID（string 化）
  remote_username  TEXT NOT NULL,
  remote_avatar    TEXT,
  access_token_enc TEXT NOT NULL,             -- 加密的 OAuth access token
  refresh_token_enc TEXT,                     -- 加密的 refresh token（GitLab/Bitbucket 需要）
  token_scope      TEXT,                      -- 'repo' / 'api' etc.
  token_expires_at INTEGER,                   -- access token 过期时间（null = 不过期）
  connected_at     INTEGER NOT NULL,
  last_used_at     INTEGER,
  revoked_at       INTEGER                   -- soft delete
);

-- 每用户每平台实例仅一个连接
CREATE UNIQUE INDEX idx_git_connections_user_provider
  ON git_connections(user_id, provider, provider_config);
```

#### `git_oauth_states`（替代 `github_oauth_states`）

```sql
CREATE TABLE git_oauth_states (
  state       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  provider    TEXT NOT NULL,               -- 回调时知道用哪个 adapter
  expires_at  INTEGER NOT NULL
);
```

#### `merge_requests`（替代 `pull_requests`）

平台创建的 PR/MR 追踪，支持多平台。

```sql
CREATE TABLE merge_requests (
  id                 TEXT PRIMARY KEY,        -- 'mr_...'
  project_id         TEXT NOT NULL REFERENCES projects(id),
  provider           TEXT NOT NULL,           -- 'github' | 'gitlab' | 'gitea'
  remote_mr_number   INTEGER NOT NULL,        -- PR/MR 编号
  remote_mr_url      TEXT NOT NULL,           -- GitHub PR URL / GitLab MR URL
  title              TEXT NOT NULL,
  description        TEXT,
  source_branch      TEXT NOT NULL,
  target_branch      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',  -- open / merged / closed
  remote_state       TEXT,                    -- 平台原始状态
  merge_sha          TEXT,
  created_by         TEXT REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_synced_at     INTEGER,
  UNIQUE(project_id, provider, remote_mr_number)
);
```

#### `project_branches`（已有，无需修改）

分支追踪表与平台无关，保持现有设计。

### 5.3 `projects` 表扩展

Phase 1 已有字段复用：

| 字段 | 用途 |
|------|------|
| `repoProvider` | `'none'` / `'local_git'` / `'github'` / `'gitlab'` / `'gitea'` |
| `repoUrl` | 远端 clone URL（外部仓库）或 bare repo 路径（内置 Git） |
| `repoDefaultBranch` | `'main'` 或 `'master'` |
| `repoTokenSecretRef` | 指向 `git_connections.id` |
| `workspaceMode` | `'local'` / `'git'` |
| `currentBranch` | workspace 当前分支 |
| `githubRepoId` | GitHub repo numeric ID（Phase 1 已有） |
| `githubFullName` | `'owner/repo'`（Phase 1 已有） |

Phase 2 新增泛化字段：

```sql
ALTER TABLE projects ADD COLUMN remote_repo_id TEXT;      -- 平台仓库 ID（string 化）
ALTER TABLE projects ADD COLUMN remote_full_name TEXT;     -- 'owner/repo' 或 'group/project'
```

### 5.4 Phase 1→2 迁移策略

```sql
-- 数据迁移：github_connections → git_connections
INSERT INTO git_connections (id, user_id, provider, remote_user_id, remote_username, ...)
  SELECT id, user_id, 'github', CAST(github_user_id AS TEXT), github_username, ...
  FROM github_connections;

-- 数据迁移：pull_requests → merge_requests
INSERT INTO merge_requests (id, project_id, provider, remote_mr_number, ...)
  SELECT id, project_id, 'github', github_pr_number, ...
  FROM pull_requests;

-- projects 字段迁移
UPDATE projects SET remote_repo_id = CAST(github_repo_id AS TEXT),
                    remote_full_name = github_full_name
  WHERE github_repo_id IS NOT NULL;
```

---

## 6. 服务层设计

### 6.1 Layer 1 — 内置 Git 服务

详见 `docs/LocalGit.md`。核心服务：

```
LocalGitService（已设计，见 LocalGit.md）
  ├─ initRepo(project)                          # 创建项目时自动 git init
  ├─ commitCheckpoint(project, meta)             # session 结束/手动 checkpoint
  ├─ restoreCheckpoint(project, sha)             # 回滚到指定 commit
  ├─ getLog(project, opts)                       # commit 历史
  └─ getDiff(project, sha)                       # diff 查看
```

### 6.2 Layer 2 — 外部 Provider 服务

#### GitHubAdapter（Phase 1 已实现）

当前 `server/src/github/GitHubService.js` 将重构为 `GitProviderService` 接口的 GitHub 实现：

```
server/src/git/providers/
  ├─ GitProviderService.js        # 抽象接口定义
  ├─ registry.js                  # Provider 注册中心
  ├─ GitHubAdapter.js             # ← 重构自 GitHubService.js
  ├─ GitLabAdapter.js             # Phase 2
  └─ GiteaAdapter.js              # Phase 2
```

接口方法到现有代码的映射：

| GitProviderService 方法 | 现有 GitHubService 方法 |
|------------------------|------------------------|
| `exchangeCode()` | `exchangeOAuthCode()` |
| `getAuthenticatedUser()` | `getAuthenticatedUser()` |
| `listUserRepos()` | `listUserRepos()` |
| `getRepo()` | `getRepo()` |
| `createPR()` | `createPullRequest()` |
| `getPR()` | `getPullRequest()` |
| `listPRs()` | `listPullRequests()` |
| `revokeToken()` | `revokeToken()` |

#### GitOperationService（平台无关，已实现）

`server/src/github/GitOperationService.js` 已经是平台无关的，仅通过 `ExecAdapter` 执行 git 命令。将移至 `server/src/git/GitOperationService.js`。

#### GitConnectionService（泛化）

`server/src/github/GitConnectionService.js` 将泛化为支持多 Provider：

```
GitConnectionService
  ├─ initiateOAuth(userId, providerName) → { authUrl, state }
  │   # 从 platform_settings 读取 provider config
  │   # 调用 Provider.buildAuthUrl()
  │
  ├─ completeOAuth(code, state) → connection record
  │   # 从 state 表查 provider name
  │   # 调用 Provider.exchangeCode()
  │   # 调用 Provider.getAuthenticatedUser()
  │
  ├─ getConnection(userId, providerName?) → connection | null
  ├─ getDecryptedToken(userId, providerName) → plaintext token
  │   # 如有 refresh_token 且 token 即将过期，自动调 Provider.refreshAccessToken()
  │
  ├─ disconnect(userId, providerName) → void
  └─ listConnections(userId) → [connection]   # 列出该用户所有平台连接
```

#### MergeRequestService（泛化自 PullRequestService）

```
MergeRequestService
  ├─ create(project, { title, body, sourceBranch, targetBranch }) → MR record
  │   # 读取 project.repoProvider → getProvider(name)
  │   # 调用 GitOperationService.pushBranch
  │   # 调用 Provider.createPR
  │   # 写入 merge_requests 表
  │
  ├─ sync(project, mrId) → updated MR record
  ├─ list(projectId) → [MR]
  └─ get(mrId) → MR
```

### 6.3 Git 认证注入策略（不变）

```
1. 控制面解密 git_connections.access_token_enc → plaintext token
2. 构造 credential helper 脚本:
   GIT_ASKPASS=/tmp/xe-credential-<random>.sh
   脚本内容: echo "$GIT_ASKPASS_TOKEN"
3. 通过 ExecAdapter.exec 执行 git push/pull，注入 env:
   GIT_ASKPASS=... GIT_ASKPASS_TOKEN=<token>
4. 命令完成后删除临时凭据文件
```

对 BoxLite/K8s Runtime：凭据通过 ExecAdapter.exec 的 env 参数传入，不持久化到 workspace。

---

## 7. API 端点

### 7.1 Git 连接（通用，替代 `/github/connect`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/git/connections` | 列出当前用户所有 Git 平台连接 |
| GET | `/api/v1/git/connection?provider=github` | 获取指定平台连接状态 |
| POST | `/api/v1/git/connect` | 发起 OAuth `{ provider: 'github' }`，返回 `{ auth_url, state }` |
| GET | `/api/v1/git/callback?code=&state=` | OAuth 回调（Server 处理） |
| DELETE | `/api/v1/git/connection?provider=github` | 断开指定平台连接 |
| GET | `/api/v1/git/repos?provider=github` | 列出指定平台用户可见仓库 |
| GET | `/api/v1/git/repos/:owner/:repo?provider=github` | 获取单个仓库详情 |
| GET | `/api/v1/git/providers` | 列出 Admin 已配置的所有 Git Provider |

### 7.2 项目导入（通用）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/projects/import-git` | 从任意 Git 平台导入仓库 |

请求体：
```json
{
  "provider": "github",
  "repo_full_name": "owner/repo",
  "name": "My Project",
  "branch": "main",
  "auto_create_branch": true,
  "work_branch_name": "xensemble/dev"
}
```

### 7.3 项目 Git 操作（保持不变）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/projects/:id/git/clone-status` | 轮询 clone 进度 |
| GET | `/api/v1/projects/:id/git/status` | git status |
| GET | `/api/v1/projects/:id/git/diff` | git diff |
| GET | `/api/v1/projects/:id/git/log` | commit 历史 |
| POST | `/api/v1/projects/:id/git/commit` | 提交变更 |
| POST | `/api/v1/projects/:id/git/push` | 推送当前分支 |
| POST | `/api/v1/projects/:id/git/pull` | 拉取最新代码（`pull --rebase`，保持分支线性；冲突时返回 409 `pull_conflict`，由前端引导强制拉取：stash → rebase → 恢复） |

### 7.4 分支管理（保持不变）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/projects/:id/branches` | 列出分支 |
| POST | `/api/v1/projects/:id/branches` | 创建分支 |
| POST | `/api/v1/projects/:id/branches/switch` | 切换分支 |
| DELETE | `/api/v1/projects/:id/branches/:name` | 删除分支 |
| POST | `/api/v1/projects/:id/branches/merge` | 合并分支 |

### 7.5 PR/MR 管理（通用化）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/projects/:id/merge-requests` | 列出 PR/MR |
| POST | `/api/v1/projects/:id/merge-requests` | 创建 PR/MR |
| GET | `/api/v1/projects/:id/merge-requests/:mrId` | 获取详情 |
| POST | `/api/v1/projects/:id/merge-requests/:mrId/sync` | 同步远端状态 |

### 7.6 向后兼容

Phase 1 已有的 `/api/v1/github/*` 路由保持可用，内部代理到新的通用路由：

```js
// 兼容层：/github/* → /git/* + provider=github
fastify.get('/api/v1/github/connection', async (req, reply) => {
  req.query.provider = 'github';
  return gitConnectionHandler(req, reply);
});
```

---

## 8. 文件结构

### 8.1 Server（Phase 2 目标结构）

```
server/src/git/
  ├─ providers/
  │   ├─ GitProviderService.js       # 抽象接口
  │   ├─ registry.js                 # Provider 注册中心
  │   ├─ GitHubAdapter.js            # ← 重构自 github/GitHubService.js
  │   ├─ GitLabAdapter.js            # Phase 2
  │   └─ GiteaAdapter.js             # Phase 2
  ├─ GitConnectionService.js         # ← 泛化自 github/GitConnectionService.js
  ├─ GitOperationService.js          # ← 移动自 github/GitOperationService.js（无改动）
  ├─ MergeRequestService.js          # ← 泛化自 github/PullRequestService.js
  ├─ gitCredentialHelper.js          # ← 移动自 github/gitCredentialHelper.js（无改动）
  └─ LocalGitService.js              # ← 来自 LocalGit.md 设计
  
server/src/github/                   # Phase 1 代码保留，标记为 deprecated
  ├─ GitHubService.js                # → 最终由 GitHubAdapter 替代
  ├─ GitConnectionService.js
  ├─ GitOperationService.js
  ├─ PullRequestService.js
  └─ gitCredentialHelper.js

server/src/routes/
  ├─ github.js                       # Phase 1 保留（向后兼容）
  └─ git.js                          # 新的通用 Git 路由
```

### 8.2 Desktop Client

```
desktop/src/renderer/
  ├─ components/
  │   ├─ git/                         # Phase 2 通用组件
  │   │   ├─ GitProviderConnectButton.jsx   # 选择平台 + 连接
  │   │   ├─ RepoImportDialog.jsx           # 通用导入（平台选择器）
  │   │   ├─ BranchSelector.jsx             # 不变
  │   │   ├─ GitStatusBar.jsx               # 不变
  │   │   ├─ CreateMRDialog.jsx             # 通用 PR/MR 创建
  │   │   └─ MRListPanel.jsx                # 通用 PR/MR 列表
  │   ├─ github/                      # Phase 1 保留
  │   │   └─ ...
  ├─ hooks/
  │   ├─ useGitProvider.js            # Phase 2 通用 hook
  │   ├─ useGitHub.js                 # Phase 1 保留
  │   └─ ...
  └─ lib/
      ├─ gitApi.js                    # Phase 2 通用 API
      └─ githubApi.js                 # Phase 1 保留
```

---

## 9. 内置 Git 详细设计

### 9.1 与 LocalGit.md 的关系

`docs/LocalGit.md` 定义了单分支、无远端的本地 Git 版本跟踪方案。本节在其基础上扩展为支持：

- **多分支**：用户/Agent 可创建 feature branch
- **内置 bare repo**：作为平台级"远端"，支持跨 session 共享
- **与外部 Provider 共存**：导入外部仓库后，内置 Git 的 checkpoint 机制继续工作

### 9.2 内置 Bare Repo（平台远端）

```
<data_dir>/repos/<project_id>.git    # bare repo（所有 session 的共享"远端"）
<workspace_root>/                     # working copy（session 实际使用）
  ├─ .git/                           # 标准 Git 目录
  ├─ .gitremote origin → bare repo or external URL
  └─ ...
```

**工作流程：**
1. 创建项目 → `git init --bare <data_dir>/repos/<project_id>.git`
2. 创建 workspace → `git clone <bare_repo_path> <workspace_path>`
3. Agent 开发 → 在 workspace 中 commit
4. Auto-checkpoint → commit + `git push origin`（推到 bare repo）
5. 如果连接了外部 Provider → 可选 `git push external <branch>`

对于**已连接外部 Provider** 的项目，bare repo 可选跳过——workspace 直接 `git remote add origin <external_url>`。

### 9.3 项目创建时的 Git 初始化

| 场景 | repoProvider | remote origin |
|------|-------------|---------------|
| 新建空项目 | `local_git` | 内置 bare repo |
| 导入 GitHub 仓库 | `github` | 外部 GitHub URL |
| 导入 GitLab 仓库 | `gitlab` | 外部 GitLab URL |

所有场景下，`.xensemble/` 目录均 scaffold（见 §12）。

---

## 10. Desktop UI 设计

### 10.1 Git Provider 连接入口

**位置**：Settings → **Git Providers** Tab

- 展示所有 Admin 配置的 Provider 列表（GitHub、GitLab、Gitea 等）
- 每个 Provider 显示连接状态
- **未连接**：展示 "Connect" 按钮
- **已连接**：展示用户头像 + 用户名 + "Disconnect" 按钮

### 10.2 仓库导入

**入口**：Sidebar 项目列表区 "+" 按钮

导入弹窗增加 **Provider 选择**：

1. **选择来源**：下拉选择已连接的 Git Provider（或"空白项目"创建内置 Git 项目）
2. **仓库选择**：搜索框 + 仓库列表
3. **配置**：项目名称、基础分支、工作分支名
4. **确认**：Import 按钮

### 10.3 分支管理（不变）

保持现有设计：Branch selector 下拉 + ahead/behind + dirty/clean 指示器。

### 10.4 Git 状态栏（不变）

保持现有设计：底部 git 状态条 + Commit/Push/Pull/Create PR 按钮。

### 10.5 PR/MR 创建弹窗

- 标题动态显示：连接 GitHub 时显示 "Create Pull Request"，连接 GitLab 时显示 "Create Merge Request"
- 其余不变：源分支、目标分支、标题、描述、Diff 预览

---

## 11. 安全设计

| 层面 | 措施 |
|------|------|
| **Token 存储** | 所有平台 access token 加密存储（`auth.encryptSecrets`），与现有 Secrets Vault 一致。 |
| **Refresh Token** | GitLab/Bitbucket 的 refresh token 同样加密存储，自动刷新逻辑在 `getDecryptedToken` 中。 |
| **Token 传输** | Token 不通过 API 返回给客户端；不注入 Agent 环境变量；仅在控制面内部使用。 |
| **Git 认证** | push/pull 使用临时 `GIT_ASKPASS` credential，命令完成后清理。 |
| **权限校验** | 所有 git 操作 API 校验用户 `active` + project 归属。 |
| **OAuth state** | CSRF state token 绑定 user_id + provider，5 分钟过期。 |
| **Scope 最小化** | 每个平台请求最小必需 scope：GitHub `repo`，GitLab `api`。 |
| **审计** | 所有 git 操作（clone/push/PR 创建）通过 `recordEvent` 记录。 |

---

## 12. Workspace 目录结构

导入或创建的仓库以**真实 Git 仓库**形式存在于 workspace 中，同时包含一个 `.xensemble/` 目录用于存储平台元数据。

### 12.1 目录布局

```
<workspace_root>/                     # = projects.serverPath
├── .git/                             # 标准 Git 目录
├── .gitignore                        # 仓库原有 + 追加 .xensemble/ 条目
├── .xensemble/                       # XEnsemble 平台元数据目录
│   ├── config.json                   # 项目级配置
│   ├── rules/                        # Agent 规则文件
│   │   ├── default.md                # 默认规则（平台 scaffold）
│   │   └── *.md                      # 用户自定义规则
│   ├── memory/                       # Agent 记忆 / 上下文持久化
│   │   ├── sessions/                 # 按 session 归档
│   │   │   └── <session_id>.json
│   │   └── project.json              # 项目级长期记忆
│   ├── prompts/                      # 自定义 prompt 模板
│   │   └── *.md
│   ├── workflows/                    # 自动化工作流定义（后期）
│   │   └── *.json
│   └── cache/                        # 临时缓存（不提交）
│       └── *.json
├── src/                              # 仓库源代码
└── ...
```

### 12.2 `.xensemble/config.json`

```json
{
  "version": 1,
  "project_id": "proj_abc123",
  "repo": {
    "provider": "github",
    "full_name": "owner/repo",
    "default_branch": "main"
  },
  "settings": {
    "auto_commit_on_exit": true,
    "work_branch_prefix": "xensemble/"
  }
}
```

对于纯内置 Git 项目：
```json
{
  "version": 1,
  "project_id": "proj_abc123",
  "repo": {
    "provider": "local_git",
    "default_branch": "main"
  },
  "settings": {
    "auto_commit_on_exit": true,
    "work_branch_prefix": "xensemble/"
  }
}
```

---

## 13. 与 Agent 的协同

### 13.1 Agent 感知 Git 分支

当 Agent session 启动时，spawn 环境注入：

```
XENSEMBLE_GIT_BRANCH=xensemble/dev       # 当前工作分支
XENSEMBLE_GIT_BASE_BRANCH=main           # 基础分支
XENSEMBLE_REPO_URL=owner/repo            # 仓库标识（外部仓库时有值）
XENSEMBLE_REPO_PROVIDER=github           # 平台标识
```

### 13.2 Agent 自动 Commit（默认开启）

Agent session 退出时，平台**自动执行**：

```bash
cd <workspace>
git add -A
git diff --cached --quiet || git commit -m "chore(xensemble): session <session_id> auto-checkpoint"
```

- **默认开启**，通过项目设置 `auto_commit_on_exit: true` 控制。
- 仅在有实际变更时 commit。
- commit message 格式固定，包含 session ID 便于追溯。
- 自动 commit 不触发 push——保证用户对远端推送的最终控制权。

实现位置：`sessionManager.onExit` 回调中。

### 13.3 Agent 不直接 push

Agent 进程不拥有 Git token，**不能**直接 push 到远端。Push 操作必须由用户通过 Desktop UI 或 API 显式触发。

---

## 14. 迁移路径

### Phase 1 — GitHub OAuth + 导入 + 分支 + PR ✅（已完成）

1. ✅ 数据模型：`github_connections`、`github_oauth_states`、`project_branches`、`pull_requests` 表
2. ✅ Server 服务：`GitHubService`、`GitConnectionService`、`GitOperationService`、`PullRequestService`
3. ✅ API 路由：`/api/v1/github/*`、项目级 git/branch/PR 路由
4. ✅ Desktop UI：GitHub 连接、导入、分支管理、Git 状态栏、PR 创建/列表
5. ✅ `.xensemble/` scaffold

### Phase 1.5 — 内置 Git + Provider 抽象重构

1. **内置 Git**：实现 `LocalGitService`（对齐 `LocalGit.md`），项目创建即 `git init`。
2. **Provider 抽象**：
   - 创建 `GitProviderService` 接口 + `registry.js`
   - 将 `GitHubService` 重构为 `GitHubAdapter`（实现 `GitProviderService`）
   - 泛化 `GitConnectionService`（支持 provider 参数）
   - 泛化 `PullRequestService` → `MergeRequestService`
3. **通用路由**：注册 `/api/v1/git/*`，保留 `/api/v1/github/*` 向后兼容
4. **DB 迁移**：`github_connections` → `git_connections`，`pull_requests` → `merge_requests`
5. **Desktop UI**：Settings → Git Providers 面板，导入弹窗增加 Provider 选择

### Phase 2 — GitLab / Gitea Provider

1. 实现 `GitLabAdapter`：OAuth (`/oauth/authorize` + `/oauth/token`)、API v4、Merge Request
2. 实现 `GiteaAdapter`：OAuth + API v1（与 GitHub API 高度兼容）
3. Token 自动刷新：GitLab refresh token 过期处理
4. Desktop UI：Provider 选择器、MR 术语适配
5. **企业部署**：Admin 配置自建 GitLab/Gitea 实例

### Phase 3（可选）— GitHub App 增强

1. 支持 GitHub App installation 方式（仓库级细粒度权限）
2. 接收 Webhook 事件（PR review、merge、push）
3. PR 状态自动同步（无需手动刷新）
4. Bot 身份（commit/PR 显示为 `xensemble[bot]`）

### Phase 4 — 高级 Git 功能

1. 冲突解决 UI（Desktop 端可视化 merge conflict 处理）
2. Git blame / history 可视化
3. Code Review 集成（在 Desktop 中查看 PR review 状态和评论）
4. 可选内嵌 Gitea/Forgejo 实例（替代 bare repo，提供完整 Web UI）

---

## 15. 与执行面的集成

### 15.1 Local Runtime

- `LocalExecAdapter.exec` 已支持在 workspace 目录执行命令。
- Git 操作调用 `exec('git', ['clone', ...], { cwd, env: { GIT_ASKPASS: ... } })`。
- 内置 bare repo 路径 jail 由 `LocalFsAdapter` 保证。

### 15.2 BoxLite / K8s Runtime

- Git 命令通过对应 `ExecAdapter.exec` 在 sandbox/pod 内执行。
- Credential 通过 env 注入，不持久化到 volume/镜像。

---

## 16. 异步操作与进度

### 16.1 Clone 进度（轮询模式）

Clone 为异步执行，Desktop Client 以 **2s 间隔** 轮询：

```http
GET /api/v1/projects/:id/git/clone-status
```

响应：
```json
{
  "clone_status": "cloning",
  "phase": "receiving",
  "progress": 65,
  "message": "Receiving objects: 65% (1200/1846)",
  "error": null
}
```

`clone_status` 变为 `ready` 或 `error` 后停止轮询，完成后初始化 `.xensemble/` 目录。

### 16.2 Push/Pull

同步 API + 超时（30s）。超时返回 `408 Request Timeout`，客户端可重试。

---

## 17. 相关文档

- 系统架构：`docs/Architecture.md`
- 本地 Git 版本跟踪：`docs/LocalGit.md`
- 客户端 API：`docs/ApiClient.md`
- 仓库快照/检查点：`RepositoryEnvironmentService.js`
- UI 规范：`DESIGN.md` → `docs/Designs.md`
- Agent 说明：`docs/agents.md`

---

## 附录 A：OAuth App 创建完整指南

### A.1 GitHub OAuth App

**前置条件**：GitHub 账号（个人或组织 owner/admin）

1. 登录 GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
   - 直达链接：<https://github.com/settings/applications/new>
2. 填写：
   - Application name: `XEnsemble`
   - Homepage URL: `https://your-xensemble-domain.com`
   - Authorization callback URL: `https://your-domain.com/api/v1/git/callback`
3. 获取 Client ID + Client Secret
4. 配置到 XEnsemble Admin Settings → Git Providers → GitHub

**Scope**：`repo`（私有仓库读写）、`user:email`（可选）

### A.2 GitLab OAuth Application

1. GitLab → Preferences → Applications（或 Admin Area → Applications）
2. Name: `XEnsemble`，Redirect URI: `https://your-domain.com/api/v1/git/callback`
3. Scopes: `api`，Confidential: ✅
4. 获取 Application ID + Secret
5. 配置到 XEnsemble Admin Settings → Git Providers → GitLab

### A.3 Gitea/Forgejo OAuth2

1. Gitea → Site Administration → Applications → Create OAuth2 Application
2. Name: `XEnsemble`，Redirect URI: `https://your-domain.com/api/v1/git/callback`
3. 获取 Client ID + Client Secret
4. 配置到 XEnsemble Admin Settings → Git Providers → Gitea

### A.4 安全建议

- **不要**将 Client Secret 提交到代码仓库
- 定期轮换 Client Secret
- 生产环境使用 HTTPS callback URL
- GitLab/Bitbucket 的 refresh token 同样需要安全存储

---

## 附录 B：各平台 OAuth 对比

| 平台 | OAuth 支持 | Token 过期 | Refresh Token | 最小 Scope | PR 术语 |
|------|-----------|-----------|--------------|-----------|---------|
| **GitHub** | ✅ OAuth App | 不过期 | 无 | `repo` | Pull Request |
| **GitLab** | ✅ OAuth Application | 2h | ✅ | `api` | Merge Request |
| **Gitea/Forgejo** | ✅ OAuth2 Provider | 不过期 | 无 | 无 scope（全权限） | Pull Request |
| **Bitbucket** | ✅ OAuth Consumer | 2h | ✅ | `repository:write` | Pull Request |
| **Azure DevOps** | ✅ OAuth | 1h | ✅ | `vso.code_write` | Pull Request |

---

*版本：v2 草案（2026-06）— 多平台 Provider + 内置 Git*  
*维护：Git 工作流行为变更须 PR + 更新本文。*
