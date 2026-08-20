# 方案一：一 workspace 按 agent 维度创建多个 runtime（VM）

## 核心思路

当前：`project.defaultRuntimeId` -> 1 个 runtime -> 1 个 blink session（VM）
改为：`(project, agentId)` -> N 个 runtime -> N 个 blink session（VM）

同一 agent 复用已有 VM（不重建）；不同 agent 各自一个 VM，workspace 目录共享。

## 为什么可行

1. `sessions.runtimeId` 字段已存在（`schema.js:90`），只是当前所有 session 指向同一个 runtime
2. `ensureProjectRuntime` 已支持 `opts.runtimeId` 参数（`RuntimeService.js:98`）
3. blink VM 启动秒级，idle 可 hibernate 释放 RAM（已有 `stopSession` + `provider.hibernate`）
4. workspace volume 是 per-project 的 host 目录（`BoxLiteRuntimeProvider.buildWorkspaceVolume`），多个 VM mount 同一个 host 目录，文件天然共享
5. 被动调用者（git status / file tree 等 20+ 处）不传 `agentId`，走 `defaultRuntimeId` 快速路径，使用 `storedSpecs.image`（已存储的 agent 镜像），不触发 VM 重建

## 复查结论

经过逐行代码验证，初始 review 报的 14 个 blocker 中有 8 个误报：

| 初始 blocker | 结论 | 证据 |
|---|---|---|
| 20+ 调用者不传 agentId 会失败 | **误报** | 被动调用者走 `isAttachOnlyRuntimeCall` 快速路径，用 `storedSpecs.image`，不触发 `imageMismatch` |
| imageMismatch/box-base 覆盖 agent VM | **误报** | `RuntimeService.js:161-162`：无 agentId 时用 `storedSpecs.image`，非 box-base |
| `defaultRuntimeId` 是标量无法表示多 VM | **误报** | 保留作为被动调用者的提示，不 ready 时 fallback 到 `storedSpecs.image` 唤醒 |
| `isAttachOnlyRuntimeCall` 快速路径歧义 | **误报** | 快速路径只读不写，任意 ready runtime 均可服务 |
| `maxRuntimes` 默认 1 会拦截 | **误报** | `PolicyService.js:10-14` 的 `DIMENSION_LIMIT` 只有 projects/sessions/previews，runtimes 未强制 |
| `role='default'` 概念矛盾 | **误报** | 保留 role 列兼容，新 runtime 用 `role='agent'`，不影响逻辑 |
| `backfillRuntimes.js` 需重写 | **误报** | 迁移脚本已运行过，不影响新逻辑 |
| `formatRuntime` 缺 agentId | **低优先** | 仅影响 API 返回，加一个字段即可 |

## 真实需要解决的问题

### 核心问题：session start for 新 agent 会摧毁已有 agent 的 VM

当前 `ensureProjectRuntime(project, { agentId: 'claude-code' })` 流程：
1. `targetRuntimeId = opts.runtimeId || project.defaultRuntimeId` -> 用 default runtime（属于另一个 agent）
2. `resolveBoxImage({ agentId: 'claude-code' })` -> claude-code 镜像
3. `storedImage` 是旧 agent 的镜像 -> `imageMismatch = true`
4. `recreateForImage = imageMismatch && opts.agentId = true` -> **删除旧 VM + 重建**

### singleflight 并发 provision 不同 agent 会冲突

`RuntimeService.js:73-74`：
```js
function runtimeKey(projectId, runtimeId) {
    return `${projectId}:${runtimeId || 'default'}`;
}
```

两个不同 agent 的 session 同时启动时，`runtimeId` 都为 null，key 都是 `"projectId:default:provision"`，`singleflight` 合并成一个调用，第二个 agent 拿到第一个 agent 的 VM。

## 最终改动范围

### 1. DB 层（`schema.js`）

`runtimes` 表新增 `agentId` 列 + `(projectId, agentId)` 唯一约束：

```js
const runtimes = pgTable('runtimes', {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id),
    agentId: text('agent_id'),                    // 新增
    provider: text('provider').notNull().default('boxlite'),
    runtimeRef: text('runtime_ref'),
    role: text('role').notNull().default('default'),
    status: text('status').default('ready'),
    endpoint: text('endpoint'),
    specs: text('specs'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
    agentUnique: uniqueIndex('runtimes_project_agent_idx').on(table.projectId, table.agentId),
}));
```

### 2. Runtime 层（`RuntimeService.js`）-- 核心改动

#### 2a. `ensureProjectRuntime` 增加 agent runtime 查找

```js
async function ensureProjectRuntime(project, opts = {}) {
    let targetRuntimeId = opts.runtimeId;

    // 主动调用者（session start/resume）：按 (projectId, agentId) 查找/创建 runtime
    // 不复用 default runtime，避免 imageMismatch 摧毁其他 agent 的 VM
    if (!targetRuntimeId && opts.agentId) {
        const existing = await db.select().from(schema.runtimes)
            .where(and(
                eq(schema.runtimes.projectId, project.id),
                eq(schema.runtimes.agentId, opts.agentId),
            ));
        if (existing.length > 0) {
            targetRuntimeId = existing[0].id;
        } else {
            const created = await getOrCreateRuntimeForAgent(project, opts.agentId);
            targetRuntimeId = created.runtime.id;
        }
    }

    // 被动调用者 fallback：用 defaultRuntimeId
    if (!targetRuntimeId) {
        targetRuntimeId = project.defaultRuntimeId;
    }

    // 快速路径（被动调用者）：只读不写，storedSpecs.image 保持不变
    if (isAttachOnlyRuntimeCall(opts) && targetRuntimeId) {
        // ... 原有逻辑不变
    }

    return singleflight(runtimeFlightKey(project.id, targetRuntimeId, opts), async () => {
        // ... 原有 provisioning 逻辑不变
    });
}
```

#### 2b. `getOrCreateDefaultRuntime` -> `getOrCreateRuntimeForAgent`

```js
async function getOrCreateRuntimeForAgent(project, agentId) {
    // 查找已有 runtime
    const existing = await db.select().from(schema.runtimes)
        .where(and(
            eq(schema.runtimes.projectId, project.id),
            eq(schema.runtimes.agentId, agentId),
        ));
    if (existing.length > 0) {
        return {
            runtime: existing[0],
            workspacePath: existing[0].endpoint || project.serverPath,
            recoverable: false,
        };
    }

    // 创建新 runtime（metadata only，不 provision VM）
    const runtimeId = `rt_${crypto.randomBytes(6).toString('hex')}`;
    const workspacePath = workspace.createProjectDirectory(project.userId, project.id);
    const now = Date.now();

    try {
        await db.insert(schema.runtimes).values({
            id: runtimeId,
            projectId: project.id,
            agentId,                                    // 绑定 agent
            provider: PROVIDER,
            runtimeRef: PROVIDER === 'boxlite' ? runtimeId : 'local',
            role: 'agent',                              // 区别于旧的 'default'
            status: 'ready',
            endpoint: workspacePath,
            specs: null,                                // provision 后由 ensureReady 填充
            createdAt: now,
            updatedAt: now,
        });
    } catch (err) {
        // 唯一约束冲突：并发调用已创建，重新查询
        const rows = await db.select().from(schema.runtimes)
            .where(and(
                eq(schema.runtimes.projectId, project.id),
                eq(schema.runtimes.agentId, agentId),
            ));
        if (rows.length > 0) {
            return {
                runtime: rows[0],
                workspacePath: rows[0].endpoint || project.serverPath,
                recoverable: false,
            };
        }
        throw err;
    }

    // 若项目无 defaultRuntimeId，设为首个 runtime（被动调用者 fallback 用）
    if (!project.defaultRuntimeId) {
        await db.update(schema.projects).set({
            defaultRuntimeId: runtimeId,
            serverPath: workspacePath,
        }).where(eq(schema.projects.id, project.id));
    }

    return {
        runtime: {
            id: runtimeId, projectId: project.id, agentId,
            provider: PROVIDER,
            runtimeRef: PROVIDER === 'boxlite' ? runtimeId : 'local',
            role: 'agent', status: 'ready',
            endpoint: workspacePath, specs: null,
        },
        workspacePath,
        recoverable: false,
    };
}
```

#### 2c. `singleflight` key 加 agentId

```js
function runtimeFlightKey(projectId, runtimeId, opts = {}) {
    // runtimeId 为 null 时（新 runtime），用 agentId 区分，避免不同 agent 的 provision 合并
    const base = runtimeId
        ? runtimeKey(projectId, runtimeId)
        : `${projectId}:${opts.agentId || 'default'}`;
    if (opts.agentId || opts.forceRecreate || opts.image) return `${base}:provision`;
    return `${base}:attach`;
}
```

### 3. BoxLite session name fallback（`BoxLiteRuntimeProvider.js:141`）

```js
// 原：const name = runtimeId || `p_${project.id}`;
const name = runtimeId || `p_${project.id}_${opts.agentId || 'default'}`;
```

### 4. `formatRuntime` 加 agentId（`RuntimeService.js:350-362`）

```js
function formatRuntime(row) {
    if (!row) return null;
    return {
        id: row.id,
        project_id: row.projectId,
        agent_id: row.agentId || null,       // 新增
        provider: row.provider,
        runtime_ref: row.runtimeRef,
        role: row.role,
        status: row.status,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
    };
}
```

## 不需要改动的部分

| 模块 | 原因 |
|---|---|
| `LocalGitService.js`（18+ 处调用） | 被动调用者走快速路径，用 `storedSpecs.image`，不触发重建 |
| `GitOperationService.js`（4 处） | 同上 |
| `server.js` workspace FS（10+ 处） | 同上 |
| `DeploymentService.js`（4 处） | 同上 |
| `workspace.js`（5 处） | 同上 |
| `idleHibernate.js` | 用 `session.runtimeId` 定位 VM，已正确 |
| `resumeSession.js` | 用 `session.runtimeId` 定位 VM（`16d3dfb` 已修复），不传 agentId |
| `recoverRunningSessions.js` | 用 `session.runtimeId`，已正确 |
| `deleteProject.js` | `DELETE WHERE projectId=?` 删全部 runtime，已正确 |
| `maxRuntimes` 配额 | `DIMENSION_LIMIT` 未包含 runtimes，未强制 |
| `backfillRuntimes.js` | 迁移脚本已运行过，不影响 |

## 被动调用者行为说明

被动调用者（git status、file tree、deploy 等）调用 `ensureProjectRuntime(project)` 不传 `agentId`：

1. `isAttachOnlyRuntimeCall` 返回 true
2. 用 `project.defaultRuntimeId` 查 DB
3. runtime `status === 'ready'` 且有 `runtimeRef` -> 返回缓存的 runtime
4. runtime 被 hibernate（`status !== 'ready'`）-> 穿透到 provisioning 路径
5. provisioning 用 `storedSpecs.image`（该 runtime 创建时的 agent 镜像）-> `imageMismatch = false` -> 不重建
6. `ensureReady` 调 `openSession` 唤醒已有 VM

结论：被动调用者自动使用 `defaultRuntimeId` 对应的 VM，不干扰其他 agent 的 VM。

## Git Worktree 配合

为解决多 agent 并发操作同一 git 仓库的冲突问题，需配合 git worktree：

```
workspace/                    # host 目录
├── repo.git/                 # bare repo (共享 object store)
├── worktree-agent-a/        # git worktree, checkout feature-a
│   └── (agent A 的 VM mount 这里)
└── worktree-agent-b/        # git worktree, checkout feature-b
    └── (agent B 的 VM mount 这里)
```

- 每个 session 的 VM mount **自己的 worktree 目录**
- 不同 worktree 可以在不同分支，互不影响
- `.git/objects` 共享，不重复占用磁盘
- `git add/commit/push` 各自独立

worktree 改动范围（独立于 runtime 改动，可后续迭代）：
- workspace 创建时 init bare repo + 主 worktree
- session 启动时 `git worktree add` 创建独立工作目录
- `BoxLiteRuntimeProvider.buildWorkspaceVolume` 改为 per-session worktree 路径
- session 删除时 `git worktree remove`

## 资源开销

| 场景 | VM 数量 | RAM |
|---|---|---|
| 1 agent 1 session | 1 | 6GB |
| 1 agent 3 session | 1（共享） | 6GB |
| 3 agent 各 1 session | 3 | 18GB（idle 的可 hibernate 释放） |

服务器 1.5TB 内存，可支撑 ~200 个并发 active VM。idle 超过 30 分钟自动 hibernate 释放 RAM。

## 功能评估

### 可行
- 多 agent 同时编辑不同文件 -> 文件系统层天然共享，各自独立工作
- 各 session 独立的对话历史、state 目录、环境变量
- 同 agent 的多个 session 共享一个 VM（不重建）

### 需 worktree 解决
- Git 工作目录共享：Agent A 的 `git checkout` 会影响 Agent B
- 构建产物冲突：`node_modules`、`dist/` 等共享
- 文件级写入冲突：两个 agent 同时编辑同一文件

## 性能影响

| 维度 | 单 session（当前） | 多 session（方案） |
|---|---|---|
| RAM | 6GB / agent | 6GB x N agent（idle 可 hibernate 释放） |
| CPU | 4 核 / agent | 4 核 x N（KVM idle VM 消耗极低） |
| 磁盘 | 1 个 rootfs 镜像 | N 个 rootfs 镜像（base layer 共享，增量小） |
| VM 启动 | 首次 5-10s | 同上，同 agent 复用已有 VM 则 0s |
| 被动调用者延迟 | 无变化 | 无变化（走快速路径缓存） |

## 安全性影响

| 维度 | 评估 |
|---|---|
| 进程隔离 | 每个 VM 独立内核、独立进程空间。Agent A 无法访问 Agent B 的进程/内存。安全 |
| 环境变量 | API key、token 按 session 注入，per-VM 隔离。安全 |
| 网络 | 每个 VM 独立网络栈，allow_net 策略 per-VM。安全 |
| 文件访问 | 所有 VM 对 workspace 有完整读写权限。有风险（worktree 可缓解） |
| Git 凭证 | `.git/config` 在共享目录中，低风险（worktree 可消除） |

## 可靠性影响

| 维度 | 评估 |
|---|---|
| VM 故障隔离 | 单个 VM 崩溃不影响其他 VM。好 |
| Session resume | 各 session 有独立 runtimeId/stateDirRef/streamRef，互不依赖。好 |
| 文件损坏风险 | 并发写同一文件可能损坏。worktree 方案可消除 |
| 资源耗尽 | 过多 VM 耗尽宿主机资源。可缩 idle 阈值 + 降单 VM 内存 |
| Git 状态一致性 | 并发 git 操作触发 index.lock 错误。worktree 可消除 |

## 实施顺序

1. **Phase 1：Runtime 层改动**（本方案核心）
   - `schema.js` 加 `agentId` 列 + 唯一约束
   - `RuntimeService.js` 重构 `ensureProjectRuntime` + `getOrCreateRuntimeForAgent`
   - `singleflight` key 修复
   - `BoxLiteRuntimeProvider.js` session name fallback
   - `formatRuntime` 加 agentId
   - 验证：同一 workspace 创建不同 agent 的 session，各自 VM 独立，互不摧毁

2. **Phase 2：Git Worktree**（解决 git 并发）
   - workspace 创建时 init bare repo
   - session 启动时 `git worktree add`
   - VM mount 改为 per-session worktree 路径
   - session 删除时 `git worktree remove`
   - 验证：多 agent 各自分支独立 commit/push

3. **Phase 3：资源优化**（按需）
   - per-agent VM 内存配置（`agents.vmResources`，`a211dc1` 已支持）
   - 缩短 idle hibernate 阈值（30 分钟 -> 10 分钟）
