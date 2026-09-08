# 多仓库 Project（Monorepo Multi-Root）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 XEnsemble 项目层支持导入多个独立 Git 仓库（典型场景：frontend / backend 分离），每个仓库在 Sandbox 内挂载到独立根目录；Git 操作、Preview 路由、文件浏览、Session 启动、Changes 面板全链路适配多根。

**Architecture:**
- **数据层**：`projects` 表保留 1 条主 repo 记录（向后兼容），新增 `project_repos` 一对多子表，存每个 repo 的 `repo_url` / `role` / `sub_path`（仓内根名）/ `branch` / `is_primary`。
- **挂载策略**：BoxLite sandbox 内每个 repo 一个独立 mount（如 `/workspace/frontend`、`/workspace/backend`），`specs.mounts[]` 数组。Host 侧每个 repo 一个 worktree：`/var/lib/xensemble/workspaces/{userId}/{projectId}.wt/{runtimeId}/{subPath}/`。
- **Git 操作**：`GitOperationService` 接受 `repoId` 参数，按 repo 路由到对应 worktree。`getStatus` / `commitAll` / `pushBranch` / `getDiff` 等需要感知 repo。
- **Preview**：Deployment `spec` 新增 `previews: [{repoId, name, port, path}]` 数组，Gateway 按 path 前缀路由到对应容器端口。
- **前端**：Workspace 面板从单根文件树 → 多根（每 repo 一棵树，类似 VS Code multi-root）；Changes 面板加 repo 标签页；导入弹窗多选勾选仓库（同前缀锁定组）；Preview 多 tab。Session 启动流程保持不变。

**Tech Stack:** Node.js 20+, Fastify, Drizzle ORM (PostgreSQL), `node:test` / `node:assert`, React, BoxLite/blink SDK, GitOperationService (扩展), Fastify reverse-proxy.

---

## 评审修订记录（2026-09-08）

对照代码库逐条核实后修订，主要修正：

1. **迁移机制**：本项目迁移由 drizzle-kit 管理 `server/drizzle/`（`server/src/db/migrate.js:5,14-23` 只读该目录，`runMigrations(db)` 不接受路径参数）。原 `src/db/migrations/004_multi_repo.sql` + `runMigrations(path)` 写法永远不会被执行 → Task 1 已改为 `npm run db:generate` 生成迁移。
2. **测试不会跑**：`server/package.json` test script 显式枚举测试 glob，不含 `src/repos/`、`src/routes/*.test.js`、`src/preview/`、`test/e2e/` → 修改文件表已加入 package.json 更新任务。
3. **单 repo 兼容性**：`BoxLiteRuntimeProvider.workspacePath()` 固定 `/workspace`（:127-130），`buildWorkspaceVolume` 另挂 `.git → /workspace.git` gitVolume（:137-155；skills 载体 :86-94 依赖之）。单 repo 必须 100% 走原逻辑，guest_path 不得变 `/workspace/<subPath>` → Task 4 已修（测试断言与实现同步修正）。
4. **存量项目回退**：`WorkspaceFileTree` 无 `rootHint` prop（:288 签名）；存量项目无 `project_repos` 行会命中空列表分支导致文件树消失 → Task 12 改为回退 legacy 单根树；workspace FS API（`routes/workspace.js` / `useWorkspaceFiles`）多根适配补入修改文件表；存量 projects 回填迁移一并补入。
5. **Preview 路由**：`resolvePreviewByPath` 未匹配不得静默回退第一个 preview（绝对路径资源会打错应用）→ Task 10 已修（返回 null，由 gateway 回退 isPrimary 或 404）；并注明子路径路由要求各前端配 base。
6. **UI 强制规则**：原生 `<select>` 改 `SelectMenu`；弹窗首项聚焦移到首个文本输入；硬编码英文文案改 `t()` → Task 12/14 已修。
7. **文件路径修正**：无 `server/src/routes/deployments.js`（部署路由在 `deployments/twoStage.js` 的 `registerAutoDeployRoutes`，server.js:55,200）；无 `NewWorkspaceDialog.jsx`（创建流程在 `OnboardingWizard.jsx`）；`MultiRootFileTree` 统一放 `web/src/components/` 顶层。
8. **待决策**：Session 向导"选 repos"（repoIds）与 RuntimeService 按 `project_repos` 全量挂载矛盾、无后端落点——建议 Phase 9 先做全量挂载、向导去掉选择步骤，或将 selectedRepos 持久化到 session 并传入 `ensureReady`；注意 `ensureProjectRuntime` 有短 TTL attach 缓存（RuntimeService.js:34），repo 变更需失效缓存。
9. **杂项**：`BARE_REPO_ROOT` 未定义（Task 3 已修）；worktree 分支名 `runtimeId.slice(-4)` 有碰撞风险，建议用完整 runtimeId；`addRepo` 唯一索引冲突应映射 409；`setPrimary` 两次 update 需事务包裹；测试脚手架禁止引入 `@fastify/jwt`（实际认证为 jsonwebtoken + `fastify.authenticate` 装饰器，测试需复用 `server/src/test/db.js` 现有装配模式）；变更区中 `server/src/deployments/twoStage.js`（多语言运行时预装）与本方案无关，提交时请分开提交。
10. **（2026-09-08 用户决策）移除 Session 向导，仓库选择收敛到导入阶段**：
    - **不修改现有 Agent 选择流程和界面**（Sessions.jsx 启动弹窗 / OnboardingWizard 的 agent 选择一律不动）。原 Phase 9 `MultiRepoSessionWizard`（三步选 workspace/agent/repos）**整体删除**，`web/src/pages/Sessions.jsx` 从修改文件表移除。
    - **勾选交互**（用户新方案，替代"前缀合并 + 下拉"）：所有仓库平铺展示、**不做前缀合并**；仓库行左侧新增 checkbox，**点击仓库行即勾选**；勾选后按 **full_name 前缀**（`group/subgroup/repo` → 前缀 `group/subgroup`）识别层级：**勾选第一个仓库后锁定该前缀组**——同组（同前缀）其余仓库可继续勾选，不同前缀仓库禁用；**取消全部勾选后重新开放**。纯函数放 `web/src/lib/repoSelection.js`，改造现有 `web/src/components/git/RepoImportDialog.jsx`（不新增独立弹窗）。
    - **勾选用途**：勾选多个仓库就导入多个仓库（一次调用 import-git `repos[]`，创建 1 个 project + N 条 `project_repos`，各自独立 worktree 挂载），目的是前后端分离项目同时导入前后端代码并在 Preview 多 tab 展示。层级约束保证一次导入的仓库属于同一个业务组。
    - **挂载策略定案**：Session 启动不做仓库选择，RuntimeService 按 `project_repos` 全量挂载（原第 8 条"待决策"就此定案）；`ensureProjectRuntime` 短 TTL attach 缓存（RuntimeService.js:34）需在 project_repos 变更（增删/勾选）时失效。

---

## 0. 文件结构总览

### 新增文件

| 文件 | 职责 |
|------|------|
| `server/src/db/migrations/004_multi_repo.sql` | 新增 `project_repos` 表 + 索引 |
| `server/src/repos/ProjectRepoService.js` | CRUD：增删改查 `project_repos`，同步到 runtime specs |
| `server/src/repos/ProjectRepoService.test.js` | 单元测试 |
| `server/src/repos/resolveRepoWorktree.js` | 解析 repo → host worktree 路径 + gitDir |
| `server/src/repos/multiRepoClone.js` | 多 repo 并发 clone 编排，bare mirror 创建 |
| `server/src/repos/multiRepoClone.test.js` | 单元测试 |
| `server/src/routes/repos.js` | `POST/GET/DELETE /api/v1/projects/:id/repos` |
| `server/src/routes/import-multi-git.js` | 扩展 `import-git` 接受 `repos: [{url, role, subPath, branch}]` |
| `server/src/preview/MultiRepoDeploymentSpec.js` | Deployment spec 多 preview 配置解析 |
| `server/src/preview/MultiRepoDeploymentSpec.test.js` | 单元测试 |
| `web/src/components/MultiRootFileTree.jsx` | 多根文件树组件（放在 `web/src/components/` 顶层，与 `WorkspaceFileTree.jsx` 同级） |
| `web/src/components/MultiRootFileTree.test.jsx` | 单元测试 |
| `web/src/components/RepoTabs.jsx` | 仓库切换标签栏（通用 tabs，可用于多场景） |
| `web/src/components/RepoTabs.test.jsx` | 单元测试 |
| `web/src/lib/repoSelection.js` | 仓库勾选层级约束纯函数：`prefixOf(fullName)` / `computeSelectionState(repos, selectedIds)` |
| `web/src/lib/repoSelection.test.js` | 单元测试 |
| `web/src/components/git/MultiRepoChangesPanel.jsx` | Changes 面板分 repo tab |
| `web/src/components/git/MultiRepoChangesPanel.test.jsx` | 单元测试 |
| `web/src/components/MultiRepoPreviewPanel.jsx` | Preview 多 tab |
| `web/src/components/MultiRepoPreviewPanel.test.jsx` | 单元测试 |
| `web/src/hooks/useProjectRepos.js` | 拉取 project_repos 列表 + CRUD hook |
| `web/src/__tests__/useProjectRepos.test.js` | 单元测试 |
| `web/src/lib/reposApi.js` | 前端 API 封装 |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `server/src/db/schema.js` | 新增 `projectRepos` 表定义 + drizzle relations |
| `server/src/workspace.js` | `worktreeDir` 接受 `subPath`（每个 repo 一个 worktree 子目录）；新增 `repoWorktreePath` |
| `server/src/runtime/BoxLiteRuntimeProvider.js` | `buildWorkspaceVolume` 改为 `buildRepoVolumes`，返回多 mount 数组；`ensureReady` 按 `project_repos` 拉起多 worktree |
| `server/src/runtime/LocalRuntimeProvider.js` | 同上，host 侧多根 layout |
| `server/src/runtime/RuntimeService.js` | `ensureProjectRuntime` 拉取 `project_repos` 并下发到 Provider |
| `server/src/runtime/interfaces.js` | `RuntimeProvider` 接口说明多挂载支持 |
| `server/src/git/LocalGitService.js` | `initRepo` 改为多 repo 版 `initMultiRepo`；`commitCheckpoint` 接受 `repoId` |
| `server/src/github/GitOperationService.js` | 构造接受 `repoId`；`_execGit` 路由到对应 worktree；新增 `getMultiRepoStatus` / `commitAllMulti` |
| `server/src/routes/git.js` | `/api/v1/projects/import-git` 接受 `repos` 数组；`/api/v1/projects/:id/git/status` 加 `repo_id` query |
| `server/src/routes/workspace.js` + `web/src/hooks/useWorkspaceFiles.js` | workspace FS API 多根适配：路径前缀 `<subPath>/...`、`resolveSafePath` jail 放行子路径前缀（文件树/编辑器/保存全链路，`WorkspaceFileTree` 无 rootHint，数据源在此） |
| `server/package.json` | test script 追加 `src/repos/*.test.js`、`src/routes/*.test.js`、`src/preview/*.test.js`、`test/e2e/*.test.js`（现 script 显式枚举 glob，不加则 CI 静默跳过） |
| `server/src/deployments/twoStage.js` | Deployment spec 支持 `previews[]` 多 preview 配置（部署路由注册在 twoStage 的 `registerAutoDeployRoutes`，**无 routes/deployments.js**） |
| `server/src/preview/gateway.js` | Gateway 按 path 前缀路由到多 container port |
| `server/src/server.js` | 注册 `registerRepoRoutes`；preview gateway 路由表加载 |
| `web/src/components/WorkspacePanel.jsx` | 用 `MultiRootFileTree` 替换原 `WorkspaceFileTree` |
| `web/src/components/git/RepoImportDialog.jsx` | 仓库列表多选勾选：行左侧 checkbox、点击行即勾选；勾选后按 full_name 前缀锁定组（同前缀可勾、跨前缀禁用，取消全部解锁）；勾选结果组 `repos[]` 一次调 `import-git`（**不新增独立弹窗，改造现有导入弹窗**） |
| `web/src/components/OnboardingWizard.jsx` | 支持 URL 导入多个 repo（**无 NewWorkspaceDialog.jsx**，工作区创建流程在 OnboardingWizard） |
| `web/src/components/SourceControlPanel.jsx` | 用 `MultiRepoChangesPanel` 包装 |
| `web/src/components/PreviewPanel.jsx` | 用 `MultiRepoPreviewPanel` 包装 |
| `shared/i18n/en/workspace.json (add 'import.*' keys to existing namespace)` | 新增多 repo 文案（前端） |
| `shared/i18n/zh/workspace.json (add 'import.*' keys to existing namespace)` | 同上 |
| `docs/Architecture.md` | 追加"多仓库项目"章节 |
| `docs/Concepts.md` | 更新 Project 概念定义 |

---

## Phase 1 — 数据模型与基础服务

### Task 1: 数据库 schema 与迁移

**Files:**
- Modify: `server/src/db/schema.js`
- Create: `server/src/db/migrations/004_multi_repo.sql`

- [ ] **Step 1.1: 在 `server/src/db/schema.js` 添加 `projectRepos` 表**

在 `projects` 表定义后插入：

```js
const projectRepos = pgTable('project_repos', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),          // 'frontend' | 'backend' | 'shared' | 'infra' | 'custom'
  subPath: text('sub_path').notNull(),   // 'frontend' | 'backend' | 'shared-lib'
  repoProvider: text('repo_provider').notNull(),  // github | gitlab | gitea | url | local_git
  repoUrl: text('repo_url').notNull(),
  repoDefaultBranch: text('repo_default_branch').notNull().default('main'),
  repoInstallationRef: text('repo_installation_ref'),
  repoTokenSecretRef: text('repo_token_secret_ref'),
  isPrimary: boolean('is_primary').notNull().default(false),
  currentBranch: text('current_branch'),
  cloneStatus: text('clone_status').notNull().default('pending'),
  cloneError: text('clone_error'),
  remoteRepoId: text('remote_repo_id'),
  remoteFullName: text('remote_full_name'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => ({
  byProject: index('project_repos_project_id_idx').on(t.projectId),
  bySubPath: index('project_repos_project_subpath_idx').on(t.projectId, t.subPath),
  uniqSubPath: uniqueIndex('project_repos_project_subpath_uniq').on(t.projectId, t.subPath),
}));
```

并在 `module.exports` 末尾追加 `projectRepos`。

- [ ] **Step 1.2: 用 drizzle-kit 生成迁移（禁止手写 SQL 文件）**

> 评审修订：本项目迁移由 drizzle-kit 管理 `server/drizzle/`（`meta/_journal.json` 驱动），
> `runMigrations(db)` 只读该目录且不接收路径参数（`server/src/db/migrate.js:5,14-23`）。
> 手写 `src/db/migrations/*.sql` 不会被执行。正确做法：

```bash
cd server && npm run db:generate   # 由 schema.js 生成 server/drizzle/0023_project_repos.sql + meta journal
```

> 同时在生成物中追加**存量回填**语句（drizzle-kit 生成后手工把回填 SQL 合入该迁移文件）：
> 为每条已有 `projects` 记录生成一条 `is_primary = TRUE` 的 `project_repos` 行，
> `sub_path` 取项目名 slug，保证存量项目进入多仓库模型（否则前端会命中空列表分支）。

- [ ] **Step 1.3: 运行 migration 验证**

```bash
cd server && npm run db:migrate   # scripts/db-migrate.js → runMigrations(db)
```

期望：`project_repos` 表存在，且存量 `projects` 均有对应 primary 行；`__drizzle_migrations` 新增一条记录。

- [ ] **Step 1.4: 提交**

```bash
git add server/src/db/schema.js server/src/db/migrations/004_multi_repo.sql
git commit -m "feat(db): 多仓库项目 — 新增 project_repos 表与 migration"
```

---

### Task 2: ProjectRepoService 基础 CRUD

**Files:**
- Create: `server/src/repos/ProjectRepoService.js`
- Create: `server/src/repos/ProjectRepoService.test.js`

- [ ] **Step 2.1: 写失败测试**

`server/src/repos/ProjectRepoService.test.js`：

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapTestDb } = require('../test/db');

let ctx;
let db;
let schema;
let ProjectRepoService;

before(async () => {
  ctx = await bootstrapTestDb([
    '../db/index',
    './ProjectRepoService',
  ], __dirname);
  ({ db, schema } = ctx);
  ({ ProjectRepoService } = ctx.reloaded['./ProjectRepoService']);
});

after(async () => {
  if (ctx) await ctx.teardown();
});

test('addRepo 创建新记录并写 createdAt', async () => {
  const svc = new ProjectRepoService();
  const projectId = 'proj_test_1';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const repo = await svc.addRepo({
    projectId, role: 'frontend', subPath: 'frontend',
    repoProvider: 'url', repoUrl: 'https://github.com/x/y.git',
    repoDefaultBranch: 'main', isPrimary: true,
  });
  assert.equal(repo.role, 'frontend');
  assert.equal(repo.subPath, 'frontend');
  assert.equal(repo.isPrimary, true);
  assert.ok(repo.id.startsWith('pr_'));
  assert.ok(repo.createdAt > 0);
});

test('listByProject 按 createdAt 升序返回', async () => {
  const svc = new ProjectRepoService();
  const projectId = 'proj_test_2';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  await svc.addRepo({ projectId, role: 'backend', subPath: 'api', repoProvider: 'url', repoUrl: 'https://x.com/a.git', repoDefaultBranch: 'main', isPrimary: true });
  await new Promise(r => setTimeout(r, 5));
  await svc.addRepo({ projectId, role: 'frontend', subPath: 'web', repoProvider: 'url', repoUrl: 'https://x.com/b.git', repoDefaultBranch: 'main', isPrimary: false });
  const list = await svc.listByProject(projectId);
  assert.equal(list.length, 2);
  assert.equal(list[0].role, 'backend');
  assert.equal(list[1].role, 'frontend');
});

test('setPrimary 取消其他 repo 的 isPrimary', async () => {
  const svc = new ProjectRepoService();
  const projectId = 'proj_test_3';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r1 = await svc.addRepo({ projectId, role: 'frontend', subPath: 'web', repoProvider: 'url', repoUrl: 'https://x.com/a.git', repoDefaultBranch: 'main', isPrimary: true });
  const r2 = await svc.addRepo({ projectId, role: 'backend', subPath: 'api', repoProvider: 'url', repoUrl: 'https://x.com/b.git', repoDefaultBranch: 'main', isPrimary: false });
  await svc.setPrimary(projectId, r2.id);
  const list = await svc.listByProject(projectId);
  const r1After = list.find(r => r.id === r1.id);
  const r2After = list.find(r => r.id === r2.id);
  assert.equal(r1After.isPrimary, false);
  assert.equal(r2After.isPrimary, true);
});

test('removeRepo 删除记录', async () => {
  const svc = new ProjectRepoService();
  const projectId = 'proj_test_4';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  const r = await svc.addRepo({ projectId, role: 'frontend', subPath: 'web', repoProvider: 'url', repoUrl: 'https://x.com/a.git', repoDefaultBranch: 'main', isPrimary: true });
  await svc.removeRepo(r.id);
  const list = await svc.listByProject(projectId);
  assert.equal(list.length, 0);
});
```

- [ ] **Step 2.2: 运行测试确认失败**

```bash
cd server && npm test -- src/repos/ProjectRepoService.test.js
```

期望：4 个 test fail（`./ProjectRepoService` 模块无法 require）。

- [ ] **Step 2.3: 实现 ProjectRepoService**

`server/src/repos/ProjectRepoService.js`：

```js
const crypto = require('crypto');
const { eq, and, asc } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

class ProjectRepoService {
  async addRepo(input) {
    const { projectId, role, subPath, repoProvider, repoUrl, repoDefaultBranch, isPrimary } = input;
    if (!projectId || !role || !subPath || !repoProvider || !repoUrl) {
      throw new Error('projectId, role, subPath, repoProvider, repoUrl are required');
    }
    if (isPrimary) {
      await db.update(schema.projectRepos)
        .set({ isPrimary: false, updatedAt: Date.now() })
        .where(eq(schema.projectRepos.projectId, projectId));
    }
    const now = Date.now();
    const row = {
      id: newId('pr'),
      projectId,
      role,
      subPath,
      repoProvider,
      repoUrl,
      repoDefaultBranch: repoDefaultBranch || 'main',
      repoInstallationRef: input.repoInstallationRef || null,
      repoTokenSecretRef: input.repoTokenSecretRef || null,
      isPrimary: !!isPrimary,
      currentBranch: input.currentBranch || null,
      cloneStatus: 'pending',
      cloneError: null,
      remoteRepoId: input.remoteRepoId || null,
      remoteFullName: input.remoteFullName || null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.projectRepos).values(row);
    return row;
  }

  async listByProject(projectId) {
    return db.select().from(schema.projectRepos)
      .where(eq(schema.projectRepos.projectId, projectId))
      .orderBy(asc(schema.projectRepos.createdAt));
  }

  async getById(id) {
    const rows = await db.select().from(schema.projectRepos)
      .where(eq(schema.projectRepos.id, id));
    return rows[0] || null;
  }

  async getBySubPath(projectId, subPath) {
    const rows = await db.select().from(schema.projectRepos)
      .where(and(
        eq(schema.projectRepos.projectId, projectId),
        eq(schema.projectRepos.subPath, subPath),
      ));
    return rows[0] || null;
  }

  async setPrimary(projectId, repoId) {
    const now = Date.now();
    await db.update(schema.projectRepos)
      .set({ isPrimary: false, updatedAt: now })
      .where(eq(schema.projectRepos.projectId, projectId));
    await db.update(schema.projectRepos)
      .set({ isPrimary: true, updatedAt: now })
      .where(and(
        eq(schema.projectRepos.id, repoId),
        eq(schema.projectRepos.projectId, projectId),
      ));
  }

  async updateCloneStatus(repoId, status, error = null) {
    await db.update(schema.projectRepos)
      .set({ cloneStatus: status, cloneError: error, updatedAt: Date.now() })
      .where(eq(schema.projectRepos.id, repoId));
  }

  async removeRepo(id) {
    await db.delete(schema.projectRepos).where(eq(schema.projectRepos.id, id));
  }
}

module.exports = { ProjectRepoService };
```

- [ ] **Step 2.4: 运行测试确认通过**

```bash
cd server && npm test -- src/repos/ProjectRepoService.test.js
```

期望：4 个 test 通过。

- [ ] **Step 2.5: 提交**

```bash
git add server/src/repos/ProjectRepoService.js server/src/repos/ProjectRepoService.test.js
git commit -m "feat(repos): ProjectRepoService — project_repos 表 CRUD"
```

---

### Task 3: 工作区多根路径解析

**Files:**
- Modify: `server/src/workspace.js`
- Create: `server/src/workspace.test.js`（若不存在追加测试）

- [ ] **Step 3.1: 写失败测试**

`server/src/workspace.test.js`（追加到现有文件或新建）：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { repoWorktreePath, projectReposDir } = require('./workspace');

test('repoWorktreePath 拼接 user/project/runtimeId/subPath', () => {
  const result = repoWorktreePath('u1', 'p1', 'rt_1', 'frontend');
  assert.match(result, /u1[\\/]p1\.wt[\\/]rt_1[\\/]frontend$/);
});

test('projectReposDir 返回 project 的 repos 子目录', () => {
  const result = projectReposDir('u1', 'p1');
  assert.match(result, /u1[\\/]p1\.repos$/);
});
```

- [ ] **Step 3.2: 运行测试确认失败**

```bash
cd server && npm test -- src/workspace.test.js
```

期望：`repoWorktreePath is not a function`。

- [ ] **Step 3.3: 实现新函数**

修改 `server/src/workspace.js`，在 `worktreeDir` 后追加：

```js
function repoWorktreePath(userId, projectId, runtimeId, subPath) {
    const base = worktreeDir(userId, projectId, runtimeId);
    return path.join(base, subPath);
}

function projectReposDir(userId, projectId) {
    return path.join(WORKSPACE_ROOT, userId, `${projectId}.repos`);
}

function projectBareRepoPath(userId, projectId, subPath) {
    // 评审修订：workspace.js 未导出 BARE_REPO_ROOT，原写法会 ReferenceError
    const bareRoot = process.env.BARE_REPO_ROOT || '/var/lib/xensemble/repos';
    return path.join(bareRoot, userId, `${projectId}__${subPath}.git`);
}
```

并在 `module.exports` 追加这三个函数。

- [ ] **Step 3.4: 运行测试确认通过**

```bash
cd server && npm test -- src/workspace.test.js
```

期望：2 个 test 通过。

- [ ] **Step 3.5: 提交**

```bash
git add server/src/workspace.js server/src/workspace.test.js
git commit -m "feat(workspace): 多根路径解析 repoWorktreePath/projectReposDir/projectBareRepoPath"
```

---

## Phase 2 — Runtime 挂载多 Repo

### Task 4: BoxLiteRuntimeProvider 支持多 repo mount

**Files:**
- Modify: `server/src/runtime/BoxLiteRuntimeProvider.js`

- [ ] **Step 4.1: 写失败测试**

新建 `server/src/runtime/BoxLiteRuntimeProvider.multirepo.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { BoxLiteRuntimeProvider } = require('./BoxLiteRuntimeProvider');

test('buildRepoVolumes 返回与 repos 数量对应的 mount 数组', () => {
  const provider = new BoxLiteRuntimeProvider();
  const project = { userId: 'u1', id: 'p1' };
  const repos = [
    { subPath: 'frontend', role: 'frontend' },
    { subPath: 'backend', role: 'backend' },
  ];
  const volumes = provider.buildRepoVolumes(project, '/tmp/wt', repos);
  assert.equal(volumes.length, 2);
  assert.equal(volumes[0].guest_path, '/workspace/frontend');
  assert.equal(volumes[1].guest_path, '/workspace/backend');
  assert.match(volumes[0].host_path, /frontend$/);
});

test('buildRepoVolumes 单 repo 时必须回退 buildWorkspaceVolume（guest=/workspace，向后兼容）', () => {
  const provider = new BoxLiteRuntimeProvider();
  const project = { userId: 'u1', id: 'p1' };
  const repos = [{ subPath: 'frontend', role: 'frontend' }];
  const volumes = provider.buildRepoVolumes(project, '/tmp/wt', repos);
  // 评审修订：单 repo 必须保持 /workspace 根挂载（agent cwd、preview 端口探测、twoStage 均依赖），
  // 并沿用原 gitVolume（.git → /workspace.git）语义，禁止 guest_path=/workspace/<subPath>
  assert.equal(volumes[0].guest_path, '/workspace');
});
```

- [ ] **Step 4.2: 运行测试确认失败**

```bash
cd server && npm test -- src/runtime/BoxLiteRuntimeProvider.multirepo.test.js
```

期望：`buildRepoVolumes is not a function`。

- [ ] **Step 4.3: 实现 buildRepoVolumes**

在 `BoxLiteRuntimeProvider.js` 找到 `buildWorkspaceVolume`，在其后追加：

```js
/**
 * 为多仓库 project 构建多 mount volume 数组。
 * 与 buildWorkspaceVolume 同语义，但每个 repo 一个独立 mount，guest_path = /workspace/<subPath>。
 * 单 repo 时（repos.length <= 1）必须原样回退 buildWorkspaceVolume（评审修订）：
 * guest_path 必须是 /workspace 而非 /workspace/<subPath>（agent cwd / preview 探测 / twoStage 依赖根挂载）；
 * .git 需按原 gitVolume（/workspace.git）语义为每个 repo 单独挂载
 * （resolveSkillCarrierGuestRoot 依赖 gitVolume.guest_path，BoxLiteRuntimeProvider.js:86-94,137-155）。
 */
buildRepoVolumes(project, worktreeBasePath, repos) {
    // 评审修订：单 repo 也必须回退原逻辑（guest=/workspace + gitVolume），仅 >=2 repos 才多挂载
    if (!repos || repos.length <= 1) {
        return [this.buildWorkspaceVolume(project, worktreeBasePath)];
    }
    const mainDir = this.hostWorkspacePath(project);
    return repos.map((repo) => {
        const subPath = repo.subPath;
        const wtPath = worktreeBasePath
            ? path.join(worktreeBasePath, subPath)
            : path.join(mainDir, subPath);
        const guestPath = `${this.workspacePath()}/${subPath}`;
        return {
            host_path: wtPath,
            guest_path: guestPath,
            read_only: false,
            mountKey: buildWorkspaceMountKey(wtPath, guestPath),
            subPath,
            role: repo.role || null,
        };
    });
}
```

并在 `_ensureWorktree` 旁新增 `_ensureRepoWorktree`：

```js
async _ensureRepoWorktree(project, runtimeId, repo) {
    const wtRoot = workspace.worktreeDir(project.userId, project.id, runtimeId);
    const wtDir = path.join(wtRoot, repo.subPath);
    const mainDir = path.join(this.hostWorkspacePath(project), repo.subPath);
    fs.mkdirSync(path.dirname(wtDir), { recursive: true });
    fs.mkdirSync(mainDir, { recursive: true });
    if (fs.existsSync(path.join(wtDir, '.git'))) return wtDir;
    const mainGitDir = path.join(mainDir, '.git');
    if (!fs.existsSync(mainGitDir)) return null;
    const branchName = `agentharness/session-${runtimeId.slice(-4)}-${repo.subPath}`;
    const baseBranch = repo.repoDefaultBranch || 'main';
    try {
        await execFileAsync('git', ['-C', mainDir, 'fetch', 'origin', baseBranch]);
    } catch { /* offline */ }
    try {
        await execFileAsync('git', ['-C', mainDir, 'worktree', 'add', '-b', branchName, wtDir, `origin/${baseBranch}`]);
        return wtDir;
    } catch {
        try {
            await execFileAsync('git', ['-C', mainDir, 'worktree', 'add', '-b', branchName, wtDir]);
            return wtDir;
        } catch {
            try {
                await execFileAsync('git', ['-C', mainDir, 'worktree', 'add', '--detach', wtDir]);
                return wtDir;
            } catch { return null; }
        }
    }
}

async _removeRepoWorktree(project, runtimeId, repo) {
    const wtDir = workspace.repoWorktreePath(project.userId, project.id, runtimeId, repo.subPath);
    const mainDir = path.join(this.hostWorkspacePath(project), repo.subPath);
    if (fs.existsSync(wtDir)) {
        try {
            await execFileAsync('git', ['-C', mainDir, 'worktree', 'remove', '--force', wtDir]);
        } catch {
            try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }
}
```

- [ ] **Step 4.4: 运行测试确认通过**

```bash
cd server && npm test -- src/runtime/BoxLiteRuntimeProvider.multirepo.test.js
```

期望：2 个 test 通过。

- [ ] **Step 4.5: 提交**

```bash
git add server/src/runtime/BoxLiteRuntimeProvider.js server/src/runtime/BoxLiteRuntimeProvider.multirepo.test.js
git commit -m "feat(runtime): BoxLiteRuntimeProvider 支持多 repo mount 与多 worktree"
```

---

### Task 5: RuntimeService 拉取 project_repos 并下发

**Files:**
- Modify: `server/src/runtime/RuntimeService.js`

- [ ] **Step 5.1: 找到 `ensureProjectRuntime`**

```bash
cd /home/zxs/develop/xensemble
grep -n "ensureProjectRuntime\|projectRepos\|specs:" server/src/runtime/RuntimeService.js | head -30
```

- [ ] **Step 5.2: 修改 RuntimeService 拉取 repos**

在 `ensureProjectRuntime` 拉取 project row 后插入：

```js
const { ProjectRepoService } = require('../repos/ProjectRepoService');
const projectRepoService = new ProjectRepoService();
const repos = await projectRepoService.listByProject(project.id);
// 把 repos 透传给 runtime provider
const ready = await getRuntime().ensureReady(project, { ...opts, repos });
```

- [ ] **Step 5.3: 写测试验证透传**

新建 `server/src/runtime/RuntimeService.multirepo.test.js`：

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapTestDb } = require('../test/db');

let ctx;
let db;
let schema;
let ensureProjectRuntime;
let registry;
let runtime;

before(async () => {
  ctx = await bootstrapTestDb([
    '../db/index',
    '../repos/ProjectRepoService',
    './registry',
    './RuntimeService',
  ], __dirname);
  ({ db, schema } = ctx);
  ({ ensureProjectRuntime } = ctx.reloaded['./RuntimeService']);
  registry = ctx.reloaded['./registry'];
  runtime = registry.getRuntime();
});

after(async () => {
  if (ctx) await ctx.teardown();
});

test('ensureProjectRuntime 把 project_repos 透传给 provider', async () => {
  const projectId = 'proj_mr_1';
  await db.insert(schema.projects).values({
    id: projectId, userId: 'u1', name: 't', serverPath: '/tmp',
    createdAt: Date.now(),
  });
  await db.insert(schema.projectRepos).values({
    id: 'pr_1', projectId, role: 'frontend', subPath: 'web',
    repoProvider: 'url', repoUrl: 'https://x.com/y.git',
    repoDefaultBranch: 'main', isPrimary: true, cloneStatus: 'ready',
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  let capturedRepos = null;
  const original = runtime.ensureReady.bind(runtime);
  runtime.ensureReady = async (p, opts) => {
    capturedRepos = opts.repos;
    return { runtime: { id: 'rt_x' }, workspacePath: '/tmp' };
  };
  try {
    await ensureProjectRuntime({ id: projectId, userId: 'u1' });
  } finally {
    runtime.ensureReady = original;
  }
  assert.equal(capturedRepos?.length, 1);
  assert.equal(capturedRepos[0].subPath, 'web');
});
```

- [ ] **Step 5.4: 运行测试**

```bash
cd server && npm test -- src/runtime/RuntimeService.multirepo.test.js
```

期望：通过。

- [ ] **Step 5.5: 提交**

```bash
git add server/src/runtime/RuntimeService.js server/src/runtime/RuntimeService.multirepo.test.js
git commit -m "feat(runtime): RuntimeService 拉取 project_repos 并透传给 provider"
```

---

## Phase 3 — 多仓库 Git 操作

### Task 6: GitOperationService 接受 repoId

**Files:**
- Modify: `server/src/github/GitOperationService.js`

- [ ] **Step 6.1: 扩展构造接受 `repoId`**

修改 `GitOperationService` 构造：

```js
class GitOperationService {
    constructor(deps = {}) {
        this.exec = deps.exec ?? getRuntime().exec;
        this.fs = deps.fs ?? getRuntime().fs;
        this._runtimeId = deps.runtimeId || null;
        this._repoSubPath = deps.repoSubPath || null;  // 新增：仓库子路径
        ...
    }
    ...
}
```

修改 `_execGitOnce` 中 hostPath 计算：

```js
let hostPath = workspace.projectDir(project.userId, project.id);
if (this._repoSubPath) {
    // 多仓库模式：操作特定子路径
    hostPath = path.join(hostPath, this._repoSubPath);
    if (this._runtimeId) {
        // worktree 模式下取 runtimeId/<subPath>
        const mainDir = workspace.projectDir(project.userId, project.id);
        const wtPath = workspace.repoWorktreePath(project.userId, project.id, this._runtimeId, this._repoSubPath);
        if (fs.existsSync(path.join(wtPath, '.git'))) {
            hostPath = wtPath;
            const mainGitDir = path.join(mainDir, this._repoSubPath, '.git');
            gitDir = path.join(mainGitDir, 'worktrees', `${this._runtimeId}_${this._repoSubPath}`);
            workTree = wtPath;
        }
    }
}
```

- [ ] **Step 6.2: 写测试**

新建 `server/src/github/GitOperationService.multirepo.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { GitOperationService } = require('./GitOperationService');

test('GitOperationService 接受 repoSubPath 并在对应 worktree 操作', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmr-'));
  const projectRoot = path.join(tmp, 'u1', 'p1');
  const repoRoot = path.join(projectRoot, 'frontend');
  fs.mkdirSync(repoRoot, { recursive: true });
  // fake exec that just records cwd
  const calls = [];
  const fakeExec = async (cmd, args, env, opts) => {
    calls.push({ cwd: opts.cwd });
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const svc = new GitOperationService({ exec: fakeExec, runtimeId: 'rt_1', repoSubPath: 'frontend' });
  // stub workspace.projectDir / repoWorktreePath
  const workspace = require('../workspace');
  workspace.projectDir = () => projectRoot;
  workspace.repoWorktreePath = (u, p, r, s) => path.join(projectRoot + '.wt', r, s);
  fs.mkdirSync(path.join(projectRoot + '.wt', 'rt_1', 'frontend'), { recursive: true });
  // exec git rev-parse
  await svc._execGit({ userId: 'u1', id: 'p1' }, ['rev-parse', 'HEAD']);
  assert.match(calls[0].cwd, /wt[\\/]rt_1[\\/]frontend$/);
});
```

- [ ] **Step 6.3: 运行测试**

```bash
cd server && npm test -- src/github/GitOperationService.multirepo.test.js
```

期望：通过。

- [ ] **Step 6.4: 提交**

```bash
git add server/src/github/GitOperationService.js server/src/github/GitOperationService.multirepo.test.js
git commit -m "feat(git): GitOperationService 接受 repoSubPath 路由到对应 worktree"
```

---

### Task 7: 多仓库 status 聚合

**Files:**
- Create: `server/src/github/multiRepoStatus.js`

- [ ] **Step 7.1: 写测试**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getMultiRepoStatus } = require('./multiRepoStatus');

test('getMultiRepoStatus 聚合多个 repo status 并附 repo meta', async () => {
  const fakeSvc = (subPath) => ({
    getStatus: async () => ({
      branch: 'main', sha: 'abc', dirty: true, files: [{ path: 'x', status: 'M' }],
      ahead: 0, behind: 0,
    }),
  });
  const repos = [
    { id: 'pr_1', subPath: 'frontend', role: 'frontend', isPrimary: true },
    { id: 'pr_2', subPath: 'backend', role: 'backend', isPrimary: false },
  ];
  const result = await getMultiRepoStatus(repos, fakeSvc);
  assert.equal(result.length, 2);
  assert.equal(result[0].repoId, 'pr_1');
  assert.equal(result[0].subPath, 'frontend');
  assert.equal(result[0].status.dirty, true);
  assert.equal(result[1].repoId, 'pr_2');
});
```

- [ ] **Step 7.2: 实现 `multiRepoStatus.js`**

```js
async function getMultiRepoStatus(repos, svcFactory) {
  return Promise.all(repos.map(async (repo) => {
    const svc = svcFactory(repo.subPath);
    const status = await svc.getStatus();
    return {
      repoId: repo.id,
      subPath: repo.subPath,
      role: repo.role,
      isPrimary: !!repo.isPrimary,
      status,
    };
  }));
}

module.exports = { getMultiRepoStatus };
```

- [ ] **Step 7.3: 运行测试**

```bash
cd server && npm test -- src/github/multiRepoStatus.test.js
```

期望：通过。

- [ ] **Step 7.4: 提交**

```bash
git add server/src/github/multiRepoStatus.js server/src/github/multiRepoStatus.test.js
git commit -m "feat(git): multiRepoStatus 聚合多仓库 git status"
```

---

## Phase 4 — 多仓库导入接口

### Task 8: import-git 接受 repos 数组

**Files:**
- Modify: `server/src/routes/git.js`

- [ ] **Step 8.1: 扩展 schema 验证**

在 `POST /api/v1/projects/import-git` 入口的 body 解析处增加：

```js
// 单 repo 兼容模式：原 body 直接转 repos 数组（repo_url 与 repo_full_name 两种现有导入方式都要兼容）
let reposInput = body.repos;
if (!reposInput) {
    // 旧字段兼容
    if (body.repo_url || body.repo_full_name) {
        reposInput = [{
            role: 'primary',
            sub_path: (body.name || 'project').toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
            repo_provider: providerName,
            repo_url: body.repo_url || null,
            repo_full_name: body.repo_full_name || null, // 评审补充：provider 模式单仓库导入同样走新路径
            branch: body.branch || null,
            is_primary: true,
        }];
    }
}
if (!Array.isArray(reposInput) || reposInput.length === 0) {
    return reply.code(400).send({ error: 'repos array is required', code: 'repos_required' });
}
```

- [ ] **Step 8.2: 写入 project_repos 并并发 clone**

替换 `import-git` 中 `gitOperationService.cloneRepo(project, ...)` 段：

```js
const { ProjectRepoService } = require('../repos/ProjectRepoService');
const { multiRepoClone } = require('../repos/multiRepoClone');
const projectRepoService = new ProjectRepoService();

// 1) 写 project_repos
const repos = [];
for (let i = 0; i < reposInput.length; i++) {
    const r = reposInput[i];
    const subPath = String(r.sub_path || r.subPath).trim();
    if (!subPath) {
        return reply.code(400).send({ error: 'sub_path is required for each repo', code: 'sub_path_required' });
    }
    // 评审补充（2026-09-08）：每项支持两种来源——
    //   provider 模式：repo_full_name（Task 14 勾选导入，复用连接 token 解析 cloneUrl）
    //   URL 模式：repo_url（纯 URL 导入）
    let repoUrl = r.repo_url;
    if (!repoUrl && r.repo_full_name) {
        if (!connection) {
            return reply.code(400).send({ error: 'provider account not connected', code: 'provider_account_not_connected' });
        }
        const provider = getProvider(r.repo_provider || providerName);
        const { getProviderConfig } = require('../git/GitConnectionService');
        const config = await getProviderConfig(r.repo_provider || providerName);
        const info = await provider.getRepo(token, r.repo_full_name, { apiBase: config?.apiBase });
        repoUrl = info.cloneUrl;
    }
    if (!repoUrl) {
        return reply.code(400).send({ error: 'repo_url or repo_full_name required for each repo', code: 'repo_url_required' });
    }
    const repo = await projectRepoService.addRepo({
        projectId,
        role: r.role || 'custom',
        subPath,
        repoProvider: r.repo_provider || providerName,
        repoUrl,
        repoDefaultBranch: r.branch || r.repo_default_branch || 'main',
        isPrimary: !!r.is_primary,
        remoteRepoId: r.remote_repo_id || null,
        remoteFullName: r.remote_full_name || r.repo_full_name || null,
        repoInstallationRef: connection?.id || null,
        repoTokenSecretRef: connection?.id || null,
    });
    repos.push(repo);
}

// 2) 并发 clone 各 repo
(async () => {
    await multiRepoClone(project, repos, {
        getToken: async () => token,
        defaultBranch: baseBranch,
    });
})();
```

- [ ] **Step 8.3: 实现 multiRepoClone**

新建 `server/src/repos/multiRepoClone.js`：

```js
const path = require('path');
const { getRuntime } = require('../runtime/registry');
const workspace = require('../workspace');
const { hostGit } = require('../git/hostGit');
const { GitOperationService } = require('../github/GitOperationService');
const { ProjectRepoService } = require('./ProjectRepoService');

async function cloneOneRepo(project, repo, opts) {
    const svc = new ProjectRepoService();
    const projectDir = workspace.projectDir(project.userId, project.id);
    const repoPath = path.join(projectDir, repo.subPath);
    // 评审补充：与 import-git 单仓库 clone 一致，私有仓库经 gitCredentialHelper /
    // repoTokenSecretRef 注入 token（opts.token / opts.injectToken），不落地明文
    const opSvc = new GitOperationService({ repoSubPath: repo.subPath });
    try {
        await opSvc.cloneRepo({
            ...project,
            serverPath: repoPath,
            repoTokenSecretRef: repo.repoTokenSecretRef || project.repoTokenSecretRef,
        }, {
            repoUrl: repo.repoUrl,
            branch: repo.repoDefaultBranch,
            token: opts.token,
        });
        await svc.updateCloneStatus(repo.id, 'ready', null);
    } catch (err) {
        await svc.updateCloneStatus(repo.id, 'failed', err.message);
    }
}

async function multiRepoClone(project, repos, opts) {
    await Promise.all(repos.map((r) => cloneOneRepo(project, r, opts)));
}

module.exports = { multiRepoClone };
```

- [ ] **Step 8.4: 写测试**

新建 `server/src/routes/git.multirepo.test.js`：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRepoUrl } = require('./git'); // re-export

test('resolveRepoUrl 多 segment (gitlab 子组) 仍正确解析', () => {
    const r = resolveRepoUrl('https://gitlab.com/group/subgroup/repo.git');
    assert.equal(r.fullName, 'group/subgroup/repo');
    assert.equal(r.owner, 'group/subgroup');
    assert.equal(r.repoName, 'repo');
});
```

- [ ] **Step 8.5: 提交**

```bash
git add server/src/routes/git.js server/src/repos/multiRepoClone.js server/src/routes/git.multirepo.test.js
git commit -m "feat(import): import-git 支持 repos 数组；多仓库并发 clone"
```

---

## Phase 5 — Routes & Repo 增删管理

### Task 9: project_repos CRUD REST API

**Files:**
- Create: `server/src/routes/repos.js`

- [ ] **Step 9.1: 实现 CRUD 路由**

```js
const { eq, and } = require('drizzle-orm');
const crypto = require('crypto');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { ProjectRepoService } = require('../repos/ProjectRepoService');
const { getProjectForUser } = require('../projects/getProjectForUser');
const { t } = require('../i18n');

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function registerRepoRoutes(fastify) {
    const svc = new ProjectRepoService();

    fastify.get('/api/v1/projects/:id/repos', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        return { repos: await svc.listByProject(project.id) };
    });

    fastify.post('/api/v1/projects/:id/repos', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const body = request.body || {};
        if (!body.sub_path || !body.repo_url) {
            return reply.code(400).send({ error: 'sub_path and repo_url required', code: 'invalid_input' });
        }
        const repo = await svc.addRepo({
            projectId: project.id,
            role: body.role || 'custom',
            subPath: body.sub_path,
            repoProvider: body.repo_provider || 'url',
            repoUrl: body.repo_url,
            repoDefaultBranch: body.repo_default_branch || 'main',
            isPrimary: !!body.is_primary,
        });
        // 触发 clone
        const { multiRepoClone } = require('../repos/multiRepoClone');
        multiRepoClone(project, [repo], {}).catch((e) => console.error('[repos] clone failed:', e));
        return reply.code(202).send({ repo });
    });

    fastify.delete('/api/v1/projects/:id/repos/:repoId', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const repo = await svc.getById(request.params.repoId);
        if (!repo || repo.projectId !== project.id) {
            return reply.code(404).send({ error: t('errors:repo_not_found', {}, request.locale || 'en'), code: 'repo_not_found' });
        }
        await svc.removeRepo(repo.id);
        // 清理 host 上的 worktree
        const fs = require('fs');
        const path = require('path');
        const workspace = require('../workspace');
        const repoPath = path.join(workspace.projectDir(project.userId, project.id), repo.subPath);
        try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch { /* best-effort */ }
        return { ok: true };
    });

    fastify.post('/api/v1/projects/:id/repos/:repoId/primary', {
        preValidation: [fastify.authenticate, fastify.requireActive],
    }, async (request, reply) => {
        const project = await getProjectForUser(request.user.id, request.params.id);
        if (!project) return reply.code(404).send({ error: t('errors:project_not_found', {}, request.locale || 'en'), code: 'project_not_found' });
        const repo = await svc.getById(request.params.repoId);
        if (!repo || repo.projectId !== project.id) {
            return reply.code(404).send({ error: t('errors:repo_not_found', {}, request.locale || 'en'), code: 'repo_not_found' });
        }
        await svc.setPrimary(project.id, repo.id);
        return { ok: true };
    });
}

module.exports = { registerRepoRoutes };
```

- [ ] **Step 9.2: 在 `server.js` 注册路由**

```js
const { registerRepoRoutes } = require('./routes/repos');
registerRepoRoutes(fastify);
```

- [ ] **Step 9.3: 写集成测试**

新建 `server/src/routes/repos.test.js`：

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapTestDb } = require('../test/db');

let ctx;
let db;
let schema;
let fastify;
let token;

before(async () => {
  ctx = await bootstrapTestDb([
    '../db/index',
    '../repos/ProjectRepoService',
    '../auth/index',
    '../server',
  ], __dirname);
  ({ db, schema } = ctx);
  // Build a minimal fastify with auth + registerRepoRoutes
  const Fastify = require('fastify');
  fastify = Fastify({ logger: false });
  await fastify.register(require('@fastify/jwt'), { secret: 'test-secret' });
  fastify.decorate('authenticate', async (req, reply) => {
    try { await req.jwtVerify(); } catch (e) { reply.code(401).send({ error: 'unauthorized' }); }
  });
  fastify.decorate('requireActive', async (req, reply) => {
    if (!req.user?.id) return reply.code(401).send({ error: 'unauthorized' });
  });
  // stub i18n t
  const { t } = require('../i18n');
  // provide a noop t
  fastify.decorateRequest('locale', 'en');
  const { registerRepoRoutes } = ctx.reloaded['../routes/repos'] || require('../routes/repos');
  registerRepoRoutes(fastify);
  await fastify.ready();

  // sign a JWT
  const { generateAccessToken } = require('../auth');
  token = generateAccessToken({ id: 'u1', username: 'u1', role: 'user', status: 'active' });
});

after(async () => {
  if (fastify) await fastify.close();
  if (ctx) await ctx.teardown();
});

test('GET /api/v1/projects/:id/repos 返回空列表', async () => {
  await db.insert(schema.projects).values({ id: 'p1', userId: 'u1', name: 'p', serverPath: '/tmp', createdAt: Date.now() });
  const res = await fastify.inject({
    method: 'GET', url: '/api/v1/projects/p1/repos',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.repos, []);
});
```

- [ ] **Step 9.4: 提交**

```bash
git add server/src/routes/repos.js server/src/routes/repos.test.js server/src/server.js
git commit -m "feat(api): /api/v1/projects/:id/repos CRUD 接口"
```

---

## Phase 6 — 多仓库 Preview 路由

### Task 10: Deployment spec 支持 previews[]

**Files:**
- Modify: `server/src/deployments/DeploymentService.js`
- Create: `server/src/preview/MultiRepoDeploymentSpec.js`

- [ ] **Step 10.1: 实现 MultiRepoDeploymentSpec**

```js
function buildMultiRepoSpec(repos, baseSpec = {}) {
    // 旧 spec.preview 兼容
    if (!Array.isArray(baseSpec.previews) || baseSpec.previews.length === 0) {
        if (baseSpec.preview) {
            return { ...baseSpec, previews: [{ name: 'default', ...baseSpec.preview }] };
        }
        return { ...baseSpec, previews: [] };
    }
    return baseSpec;
}

function resolvePreviewByPath(previews, requestPath) {
    // 按 name 长度倒序匹配，前缀最长优先
    const sorted = [...previews].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));
    for (const p of sorted) {
        const prefix = `/${p.name}`;
        if (requestPath === prefix || requestPath.startsWith(prefix + '/')) {
            return p;
        }
    }
    // 评审修订：未匹配前缀时不得静默回退第一个 preview（/assets/... 等绝对路径会打到错误应用）。
    // 返回 null，由 gateway 决定：回退到 isPrimary repo 的 preview，或 404。
    return null;
}

module.exports = { buildMultiRepoSpec, resolvePreviewByPath };
```

- [ ] **Step 10.2: 写测试**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMultiRepoSpec, resolvePreviewByPath } = require('./MultiRepoDeploymentSpec');

test('buildMultiRepoSpec 旧 spec.preview 转 previews[]', () => {
    const r = buildMultiRepoSpec([], { preview: { port: 3000 } });
    assert.equal(r.previews.length, 1);
    assert.equal(r.previews[0].port, 3000);
});

test('resolvePreviewByPath 按前缀最长匹配', () => {
    const previews = [
        { name: 'frontend', port: 3000 },
        { name: 'frontend/admin', port: 3001 },
    ];
    assert.equal(resolvePreviewByPath(previews, '/frontend/admin/users').name, 'frontend/admin');
    assert.equal(resolvePreviewByPath(previews, '/frontend/dashboard').name, 'frontend');
});

test('resolvePreviewByPath 未匹配返回 null（不静默回退）', () => {
    const previews = [{ name: 'frontend', port: 3000 }];
    assert.equal(resolvePreviewByPath(previews, '/backend/api'), null);
});
```

- [ ] **Step 10.3: 修改 preview gateway**

在 `server/src/preview/gateway.js`（如不存在则用 `server/src/server.js` 的 preview handler）按 `request.params['*']` 走 `resolvePreviewByPath` 路由到对应 container port：

```js
const { resolvePreviewByPath } = require('./MultiRepoDeploymentSpec');
// 找到 deployment → spec.previews → resolvePreviewByPath → 反代
```

> 评审补充：子路径路由要求各前端应用以 base 构建（如 Vite `base: '/frontend/'`），否则静态资源 404、
> dev server HMR WebSocket 也会因前缀失配；未匹配路径由 gateway 回退到 isPrimary repo 的 preview 或 404。

- [ ] **Step 10.4: 提交**

```bash
git add server/src/preview/MultiRepoDeploymentSpec.js server/src/preview/MultiRepoDeploymentSpec.test.js server/src/preview/gateway.js server/src/deployments/DeploymentService.js
git commit -m "feat(preview): 多仓库 deployment spec — previews[] 与 path 路由"
```

---

## Phase 7 — 前端多根 Workspace

### Task 11: useProjectRepos hook

**Files:**
- Create: `web/src/hooks/useProjectRepos.js`

- [ ] **Step 11.1: 实现 hook**

```js
import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '../lib/api';

export function useProjectRepos(projectId) {
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/v1/projects/${projectId}/repos`);
      setRepos(res.repos || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { reload(); }, [reload]);

  const addRepo = useCallback(async (input) => {
    const res = await apiFetch(`/api/v1/projects/${projectId}/repos`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    await reload();
    return res.repo;
  }, [projectId, reload]);

  const removeRepo = useCallback(async (repoId) => {
    await apiFetch(`/api/v1/projects/${projectId}/repos/${repoId}`, { method: 'DELETE' });
    await reload();
  }, [projectId, reload]);

  const setPrimary = useCallback(async (repoId) => {
    await apiFetch(`/api/v1/projects/${projectId}/repos/${repoId}/primary`, { method: 'POST' });
    await reload();
  }, [projectId, reload]);

  return { repos, loading, error, reload, addRepo, removeRepo, setPrimary };
}
```

- [ ] **Step 11.2: 写测试**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useProjectRepos } from './useProjectRepos';

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../lib/api';

describe('useProjectRepos', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reload 拉取 repos 列表', async () => {
    apiFetch.mockResolvedValueOnce({ repos: [{ id: 'pr_1', subPath: 'web', role: 'frontend' }] });
    const { result } = renderHook(() => useProjectRepos('p1'));
    await waitFor(() => expect(result.current.repos).toHaveLength(1));
    expect(result.current.repos[0].subPath).toBe('web');
  });

  it('addRepo POST 后 reload', async () => {
    apiFetch.mockResolvedValueOnce({ repos: [] });
    apiFetch.mockResolvedValueOnce({ repo: { id: 'pr_2', subPath: 'api' } });
    apiFetch.mockResolvedValueOnce({ repos: [{ id: 'pr_1' }, { id: 'pr_2' }] });
    const { result } = renderHook(() => useProjectRepos('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.addRepo({ sub_path: 'api', repo_url: 'https://x.com/y.git' }); });
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/projects/p1/repos', expect.objectContaining({ method: 'POST' }));
  });
});
```

- [ ] **Step 11.3: 提交**

```bash
git add web/src/hooks/useProjectRepos.js web/src/__tests__/useProjectRepos.test.js
git commit -m "feat(web): useProjectRepos hook — 拉取/增删/设主仓库"
```

---

### Task 12: MultiRootFileTree 组件

**Files:**
- Create: `web/src/components/workspace/MultiRootFileTree.jsx`

- [ ] **Step 12.1: 实现组件骨架**

```jsx
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectRepos } from '../hooks/useProjectRepos';
import { WorkspaceFileTree } from '../WorkspaceFileTree';

// 评审修订：组件统一放在 components/ 顶层（与 WorkspaceFileTree 同级）；用户可见文案一律 t()

export function MultiRootFileTree({ projectId, activeSessionId }) {
  const { t } = useTranslation('workspace');
  const { repos, loading, error } = useProjectRepos(projectId);
  const [activeRepoId, setActiveRepoId] = useState(null);

  // 评审修订：存量单仓库项目无 project_repos 行（回填前）必须回退 legacy 单根树，
  // 否则现有用户文件树消失
  if (repos.length === 0) {
    return <WorkspaceFileTree projectId={projectId} sessionId={activeSessionId} />;
  }

  // 评审修订：i18n 强制规则，禁止硬编码英文
  if (loading) return <div className="p-4 text-gray-400">{t('import.loadingRepos', { defaultValue: 'Loading repos…' })}</div>;
  if (error) return <div className="p-4 text-red-400">{t('import.loadFailed', { defaultValue: 'Failed to load repos' })}: {error.message}</div>;

  // 单 repo：直接显示原 FileTree。
  // 评审修订：WorkspaceFileTree 现有 props 不含 rootHint（见 :288 签名），
  // 子路径数据源过滤需先完成 workspace FS API 多根适配（见修改文件表 routes/workspace.js 行）
  if (repos.length === 1) {
    return <WorkspaceFileTree projectId={projectId} sessionId={activeSessionId} />;
  }

  // 多 repo：标签栏 + 标签内容
  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-gray-700 bg-[#252A33]">
        {repos.map((r) => (
          <button
            key={r.id}
            onClick={() => setActiveRepoId(r.id)}
            className={`px-3 py-2 text-sm ${activeRepoId === r.id || (!activeRepoId && r.isPrimary)
              ? 'bg-[#2E3440] text-white border-b-2 border-blue-400'
              : 'text-gray-400 hover:text-white'}`}
            data-testid={`repo-tab-${r.subPath}`}
          >
            {r.subPath}
            {r.isPrimary && <span className="ml-1 text-xs text-blue-400">●</span>}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {repos.map((r) => (
          (activeRepoId === r.id || (!activeRepoId && r.isPrimary)) && (
            <WorkspaceFileTree
              key={r.id}
              projectId={projectId}
              sessionId={activeSessionId}
              rootHint={r.subPath}
            />
          )
        ))}
      </div>
    </div>
  );
}

function RepoImportTrigger({ projectId }) {
  return <a href={`/projects/${projectId}/repos/import`} className="text-blue-400 underline">Add a repo</a>;
}
```

- [ ] **Step 12.2: 写测试**

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MultiRootFileTree } from './MultiRootFileTree';

vi.mock('../hooks/useProjectRepos', () => ({
  useProjectRepos: vi.fn(),
}));
vi.mock('./WorkspaceFileTree', () => ({
  default: () => <div data-testid="workspace-file-tree" />,
}));

import { useProjectRepos } from '../hooks/useProjectRepos';

describe('MultiRootFileTree', () => {
  it('单 repo：直接渲染 WorkspaceFileTree', () => {
    useProjectRepos.mockReturnValue({
      repos: [{ id: 'pr_1', subPath: 'web', isPrimary: true, role: 'frontend' }],
      loading: false, error: null,
    });
    render(<MultiRootFileTree projectId="p1" />);
    expect(screen.getByTestId('workspace-file-tree')).toBeInTheDocument();
  });

  it('多 repo：渲染 tabs + 主 repo 默认选中', () => {
    useProjectRepos.mockReturnValue({
      repos: [
        { id: 'pr_1', subPath: 'web', isPrimary: true, role: 'frontend' },
        { id: 'pr_2', subPath: 'api', isPrimary: false, role: 'backend' },
      ],
      loading: false, error: null,
    });
    render(<MultiRootFileTree projectId="p1" />);
    expect(screen.getByTestId('repo-tab-web')).toBeInTheDocument();
    expect(screen.getByTestId('repo-tab-api')).toBeInTheDocument();
  });
});
```

- [ ] **Step 12.3: 提交**

```bash
git add web/src/components/workspace/MultiRootFileTree.jsx web/src/components/workspace/MultiRootFileTree.test.jsx
git commit -m "feat(web): MultiRootFileTree — 多根文件树，单 repo 走原 FileTree"
```

---

### Task 13: WorkspacePanel 接入 MultiRootFileTree

**Files:**
- Modify: `web/src/components/workspace/WorkspacePanel.jsx`

- [ ] **Step 13.1: 替换 WorkspaceFileTree 引用**

找到 `web/src/components/WorkspacePanel.jsx` 中 `<WorkspaceFileTree ... />` 的使用，替换为：

```jsx
import { MultiRootFileTree } from './MultiRootFileTree';
// ...
<MultiRootFileTree projectId={projectId} activeSessionId={activeSessionId} />
```

- [ ] **Step 13.2: 验证 lint**

```bash
cd web && npm run lint
```

期望：无新报错。

- [ ] **Step 13.3: 提交**

```bash
git add web/src/components/workspace/WorkspacePanel.jsx
git commit -m "feat(web): WorkspacePanel 切换到 MultiRootFileTree"
```

---

### Task 14: RepoImportDialog 多选勾选（层级约束）

> 评审修订（2026-09-08 用户决策）：**不新增 MultiRepoImportDialog / MultiRepoSessionWizard**。
> 仓库选择收敛到现有 `web/src/components/git/RepoImportDialog.jsx`（Sessions.jsx 已在用），
> 列表行加 checkbox 实现多选 + 同前缀锁定组；勾选结果一次调用 import-git `repos[]`。

**Files:**
- Create: `web/src/lib/repoSelection.js` + `web/src/lib/repoSelection.test.js`
- Modify: `web/src/components/git/RepoImportDialog.jsx`

- [ ] **Step 14.1: 写失败测试**

`web/src/lib/repoSelection.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { prefixOf, computeSelectionState, toggleRepo } from './repoSelection';

const REPOS = [
  { id: '1', full_name: 'a/b/c' },
  { id: '2', full_name: 'a/b/d' },
  { id: '3', full_name: 'a/e' },
  { id: '4', full_name: 'g/h' },
];

describe('prefixOf', () => {
  it('取最后一段前的路径为前缀', () => {
    expect(prefixOf('a/b/c')).toBe('a/b');   // group/subgroup/repo
    expect(prefixOf('a/e')).toBe('a');
    expect(prefixOf('g/h')).toBe('g');
    expect(prefixOf('solo')).toBe('');       // 无层级
  });
});

describe('computeSelectionState', () => {
  it('未勾选时全部可勾', () => {
    expect(computeSelectionState(REPOS, []).every((s) => s.enabled)).toBe(true);
  });
  it('勾选 a/b/c 后锁定前缀组 a/b：a/b/d 可勾，a/e 与 g/h 禁用', () => {
    const states = computeSelectionState(REPOS, ['1']);
    expect(states.find((s) => s.id === '1').enabled).toBe(true);  // 已勾选
    expect(states.find((s) => s.id === '2').enabled).toBe(true);  // a/b/d 同前缀
    expect(states.find((s) => s.id === '3').enabled).toBe(false); // a/e 前缀 a ≠ a/b
    expect(states.find((s) => s.id === '4').enabled).toBe(false); // g/h 前缀 g ≠ a/b
  });
  it('取消全部勾选后重新开放所有仓库', () => {
    expect(computeSelectionState(REPOS, []).every((s) => s.enabled)).toBe(true);
  });
});

describe('toggleRepo', () => {
  it('勾选/取消互斥', () => {
    expect(toggleRepo([], { id: '1' })).toEqual(['1']);
    expect(toggleRepo(['1'], { id: '1' })).toEqual([]);
  });
});
```

- [ ] **Step 14.2: 运行测试确认失败 → 实现纯函数**

```bash
cd web && npx vitest run src/lib/repoSelection.test.js
```

`web/src/lib/repoSelection.js`：

```js
// 仓库勾选层级约束（评审修订 2026-09-08）：所有仓库平铺展示，勾选第一个后锁定其前缀组。
// 前缀 = full_name 去掉最后一段（group/subgroup/repo → group/subgroup）。

export function prefixOf(fullName) {
  const s = String(fullName || '');
  const idx = s.lastIndexOf('/');
  return idx > 0 ? s.slice(0, idx) : '';
}

// 勾选状态机：selectedIds 为空 → 全部可勾；
// 否则取首个勾选仓库的前缀为 lockedPrefix，同前缀可勾、其余 disabled。
export function computeSelectionState(repos, selectedIds) {
  const first = repos.find((r) => selectedIds.includes(r.id));
  const lockedPrefix = first ? prefixOf(first.full_name) : null;
  return repos.map((r) => ({
    ...r,
    enabled: lockedPrefix === null || prefixOf(r.full_name) === lockedPrefix,
  }));
}

export function toggleRepo(selectedIds, repo) {
  return selectedIds.includes(repo.id)
    ? selectedIds.filter((id) => id !== repo.id)
    : [...selectedIds, repo.id];
}
```

- [ ] **Step 14.3: 改造 RepoImportDialog**

`web/src/components/git/RepoImportDialog.jsx`（在现有单选逻辑上增量改造，不动登录/URL 导入/克隆轮询）：

```jsx
import { prefixOf, computeSelectionState, toggleRepo } from '../../lib/repoSelection';

// 新增状态：多选集合（评审修订：勾选后锁定前缀组）
const [selectedIds, setSelectedIds] = useState([]);
const selection = useMemo(() => computeSelectionState(repos, selectedIds), [repos, selectedIds]);
const selectedRepos = selection.filter((r) => selectedIds.includes(r.id));

const handleToggle = (repo) => {
  // 跨前缀仓库不可勾选（enabled=false 时点击无效）
  if (!repo.enabled) return;
  setSelectedIds(toggleRepo(selectedIds, repo));
};
```

仓库列表渲染（browse 模式，替换现有单选的 `onClick={() => setSelectedFullName(repo.full_name)}`）：

```jsx
<ul className="divide-y divide-zinc-200">
  {filteredRepos.map((repo) => {
    const state = selection.find((s) => s.id === repo.id || s.full_name === repo.full_name);
    const checked = selectedIds.includes(repo.id || repo.full_name);
    return (
      <li key={repo.id || repo.full_name}>
        <button
          type="button"
          disabled={!state.enabled}
          onClick={() => handleToggle({ ...repo, id: repo.id || repo.full_name, enabled: state.enabled })}
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
            checked ? 'bg-zinc-100' : 'hover:bg-zinc-50'
          } ${!state.enabled ? 'cursor-not-allowed opacity-40' : ''}`}
        >
          <input
            type="checkbox"
            checked={checked}
            disabled={!state.enabled}
            onChange={() => handleToggle({ ...repo, id: repo.id || repo.full_name, enabled: state.enabled })}
            className="rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
          />
          <span className="min-w-0 truncate font-medium text-zinc-900">{repo.full_name}</span>
          <span className="shrink-0 text-xs text-zinc-500">
            {repo.private ? 'Private' : 'Public'}{repo.language ? ` · ${repo.language}` : ''}
          </span>
        </button>
      </li>
    );
  })}
</ul>
```

提交分支（`handleImport`，单选保持原逻辑，多选一次导入）：

```jsx
const handleImport = async () => {
  if (selectedIds.length === 0) return;
  setImporting(true);
  try {
    if (selectedIds.length === 1) {
      // 单仓库：走原逻辑（向后兼容，创建单 repo project）
      const repo = selectedRepos[0];
      const result = await gitApi.importRepo({
        provider, repo_full_name: repo.full_name,
        name: name.trim() || repo.name,
        branch: branch.trim() || repo.default_branch || 'main',
        auto_create_branch: autoCreateBranch,
        work_branch_name: workBranchName.trim() || generateWorkBranchName(''),
      });
      setImportedProjectId(result.id);
    } else {
      // 多仓库：一次 import-git repos[] → 1 个 project + N 条 project_repos（后端 Task 8）
      const result = await gitApi.importRepo({
        provider,
        repos: selectedRepos.map((r) => ({
          repo_full_name: r.full_name,
          role: 'custom',                                  // 默认 role，可后续在 project_repos 调整
          sub_path: r.name,                                // 默认取仓库名（full_name 末段），重复由后端校验唯一索引
          branch: r.default_branch || 'main',
        })),
      });
      setImportedProjectId(result.id);
    }
    setCloneStatus(result.status || 'cloning');
    showToast('success', 'Import started. Cloning repositories…');
  } catch (err) {
    showToast('error', err.message);
    setImporting(false);
  }
};
```

> 说明：`selectedFullName` 单选状态保留用于 name/branch 表单默认值（取 `selectedRepos[0]`）。
> 勾选约束提示文案与"Import N repositories"按钮文案走 i18n（`git:import.repos` 等），禁止硬编码。
> 弹窗首项聚焦仍落在首个文本输入（此处无首行输入，聚焦仓库搜索框即可）。

- [ ] **Step 14.4: 运行前端测试 + lint**

```bash
cd web && npx vitest run src/lib/repoSelection.test.js && npm run lint
```

期望：repoSelection 测试通过；lint 无新报错。

- [ ] **Step 14.5: 提交**

```bash
git add web/src/lib/repoSelection.js web/src/lib/repoSelection.test.js web/src/components/git/RepoImportDialog.jsx
git commit -m "feat(web): RepoImportDialog 多选勾选 — 同前缀锁定组，多仓库一次导入"
```

---

## Phase 8 — Changes & Preview 多 repo 适配

### Task 15: MultiRepoChangesPanel

**Files:**
- Create: `web/src/components/git/MultiRepoChangesPanel.jsx`

- [ ] **Step 15.1: 实现**

```jsx
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectRepos } from '../../hooks/useProjectRepos';
import { apiFetch } from '../../lib/api';
import { SourceControlPanel } from './SourceControlPanel';

export function MultiRepoChangesPanel({ projectId, sessionId }) {
  const { t } = useTranslation(['workspace']);
  const { repos } = useProjectRepos(projectId);
  const [activeRepoId, setActiveRepoId] = useState(null);

  if (repos.length <= 1) {
    return <SourceControlPanel projectId={projectId} sessionId={sessionId} />;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-gray-700">
        {repos.map((r) => (
          <button
            key={r.id}
            onClick={() => setActiveRepoId(r.id)}
            className={`px-3 py-1 text-xs ${activeRepoId === r.id || (!activeRepoId && r.isPrimary) ? 'bg-[#2E3440] text-white' : 'text-gray-400'}`}
            data-testid={`changes-repo-${r.subPath}`}
          >
            {r.subPath}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {repos.map((r) => (
          (activeRepoId === r.id || (!activeRepoId && r.isPrimary)) && (
            <SourceControlPanel
              key={r.id}
              projectId={projectId}
              sessionId={sessionId}
              repoId={r.id}
              repoSubPath={r.subPath}
            />
          )
        ))}
      </div>
    </div>
  );
}
```

并在 `server/src/routes/git.js` 的 `getStatus` 路由接受 `repo_id`：

```js
fastify.get('/api/v1/projects/:id/git/status', {
    preValidation: [fastify.authenticate, fastify.requireActive],
}, async (request, reply) => {
    const project = await getProjectForUser(request.user.id, request.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found', code: 'project_not_found' });
    const { repo_id } = request.query || {};
    let svc;
    if (repo_id) {
        const { ProjectRepoService } = require('../repos/ProjectRepoService');
        const r = await new ProjectRepoService().getById(repo_id);
        svc = new GitOperationService({ repoSubPath: r?.subPath, runtimeId: ... });
    } else {
        svc = new GitOperationService();
    }
    return svc.getStatus(project);
});
```

- [ ] **Step 15.2: 提交**

```bash
git add web/src/components/git/MultiRepoChangesPanel.jsx server/src/routes/git.js
git commit -m "feat(git): MultiRepoChangesPanel + status 支持 repo_id"
```

---

### Task 16: MultiRepoPreviewPanel

**Files:**
- Create: `web/src/components/MultiRepoPreviewPanel.jsx`

- [ ] **Step 16.1: 实现**

```jsx
import React, { useState } from 'react';
import { PreviewPanel } from './PreviewPanel';

export function MultiRepoPreviewPanel({ projectId, deployment }) {
  const previews = deployment?.spec?.previews || [];
  const [active, setActive] = useState(0);

  if (previews.length <= 1) {
    return <PreviewPanel projectId={projectId} deployment={deployment} />;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-gray-700">
        {previews.map((p, idx) => (
          <button
            key={p.name || idx}
            onClick={() => setActive(idx)}
            className={`px-3 py-1 text-xs ${active === idx ? 'bg-[#2E3440] text-white' : 'text-gray-400'}`}
            data-testid={`preview-tab-${p.name}`}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="flex-1">
        <PreviewPanel projectId={projectId} deployment={deployment} preview={previews[active]} />
      </div>
    </div>
  );
}
```

并在 `PreviewPanel` 内部 `iframe` src 改为：

```jsx
<iframe src={`/preview/${deployment.id}/${previews[active]?.name || ''}`} />
```

- [ ] **Step 16.2: 提交**

```bash
git add web/src/components/MultiRepoPreviewPanel.jsx web/src/components/PreviewPanel.jsx
git commit -m "feat(preview): MultiRepoPreviewPanel — 多 preview 切换"
```

---

## Phase 9 — Session 启动流程（保持不变）

> 决策（2026-09-08 用户明确要求）：**不修改现有 Agent 选择流程和界面**。
> 原 `MultiRepoSessionWizard`（三步选 workspace / agent / repos）**整体删除**；
> `web/src/pages/Sessions.jsx` 启动弹窗与 `OnboardingWizard.jsx` agent 选择**一律不动**。
> 仓库选择已在导入阶段（Task 14）完成并写入 `project_repos`；
> Session 启动时由 RuntimeService 按 `project_repos` **全量挂载**（修订记录 #10 定案，原 #8 待决策关闭）。
> `ensureProjectRuntime` 短 TTL attach 缓存（RuntimeService.js:34）需在 project_repos 变更时失效。

### Task 17: 回归验证（无代码任务）

**Files:** 无

- [ ] **Step 17.1: 单仓库 Session 启动回归**

启动现有 dev server，登录 → 启动 Session（选 workspace → 选 agent → 启动）：
- agent 选择弹窗/界面与改造前完全一致，无多仓库相关 UI
- 单 repo project 启动后 sandbox `/workspace` 根挂载不变（agent cwd 为 `/workspace`）

- [ ] **Step 17.2: 多仓库挂载验证**

1. 通过 Task 14 勾选导入 2 个同前缀仓库（如 frontend + backend）创建 project
2. 启动 Session，确认 sandbox 内出现 `/workspace/<subPath>` 多个挂载目录（Task 4 `buildRepoVolumes`）
3. Preview 多 tab 按 Task 10 `previews[]` + path 前缀路由工作

- [ ] **Step 17.3: 缓存失效验证**

在 `project_repos` 增删仓库（Task 9 CRUD）后启动 Session，确认沙箱挂载与最新 `project_repos` 一致
（`ensureProjectRuntime` 短 TTL attach 缓存需在 repo 变更时主动失效，见修订记录 #10）。

---

## Phase 10 — 文档与端到端验证

### Task 18: 文档更新

**Files:**
- Modify: `docs/Architecture.md`
- Modify: `docs/Concepts.md`
- Modify: `docs/ApiClient.md`

- [ ] **Step 18.1: 在 Architecture.md 追加"多仓库项目"章节**

```md
## X. 多仓库项目（Multi-Repo Project）

为支持前后端分离 / 多服务编排，项目层引入多仓库挂载：
- 数据层：`projects` + `project_repos` 一对多
- 挂载策略：BoxLite sandbox 多 mount，每 repo 一个 `/workspace/<subPath>`
- Git 操作：按 repoId 路由到对应 worktree
- Preview：deployment spec.previews[] 多 preview 入口，gateway 按 path 前缀路由
- 前端：MultiRootFileTree / MultiRepoChangesPanel / MultiRepoPreviewPanel
```

- [ ] **Step 18.2: 更新 Concepts.md**

将 Project 概念从"代码空间（DB 表为 projects）"更新为"Workspace 容器，可挂载 1..N 个独立 Git 仓库"。

- [ ] **Step 18.3: 提交**

```bash
git add docs/Architecture.md docs/Concepts.md docs/ApiClient.md
git commit -m "docs: 多仓库项目 — Architecture/Concepts/ApiClient"
```

---

### Task 19: 端到端测试

**Files:**
- Create: `server/test/e2e/multiRepo.test.js`

- [ ] **Step 19.1: 实现 E2E 测试**

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapTestDb } = require('../src/test/db');

let ctx;
let db;
let schema;
let fastify;
let token;

before(async () => {
  ctx = await bootstrapTestDb([
    '../src/db/index',
    '../src/repos/ProjectRepoService',
    '../src/auth/index',
  ], __dirname);
  ({ db, schema } = ctx);
  const Fastify = require('fastify');
  fastify = Fastify({ logger: false });
  await fastify.register(require('@fastify/jwt'), { secret: 'test-secret' });
  fastify.decorate('authenticate', async (req, reply) => {
    try { await req.jwtVerify(); } catch (e) { reply.code(401).send({ error: 'unauthorized' }); }
  });
  fastify.decorate('requireActive', async (req, reply) => {
    if (!req.user?.id) return reply.code(401).send({ error: 'unauthorized' });
  });
  fastify.decorateRequest('locale', 'en');
  const { registerRepoRoutes } = require('../src/routes/repos');
  const { registerGitRoutes } = require('../src/routes/git');
  registerRepoRoutes(fastify);
  registerGitRoutes(fastify);
  await fastify.ready();
  const { generateAccessToken } = require('../src/auth');
  token = generateAccessToken({ id: 'u1', username: 'u1', role: 'user', status: 'active' });
});

after(async () => {
  if (fastify) await fastify.close();
  if (ctx) await ctx.teardown();
});

test('E2E: 导入 2 repo → list 返回 2 条 → 删除 1 条', async () => {
  // 1) import-git with repos array
  const importRes = await fastify.inject({
    method: 'POST', url: '/api/v1/projects/import-git',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({
      name: 'fullstack',
      repos: [
        { role: 'frontend', sub_path: 'web', repo_url: 'https://github.com/x/web.git', is_primary: true },
        { role: 'backend', sub_path: 'api', repo_url: 'https://github.com/x/api.git', is_primary: false },
      ],
    }),
  });
  assert.equal(importRes.statusCode, 202);
  const { id: projectId } = JSON.parse(importRes.body);

  // 2) list returns 2
  const listRes = await fastify.inject({
    method: 'GET', url: `/api/v1/projects/${projectId}/repos`,
    headers: { authorization: `Bearer ${token}` },
  });
  const { repos } = JSON.parse(listRes.body);
  assert.equal(repos.length, 2);

  // 3) delete one
  const api = repos.find((r) => r.subPath === 'api');
  const del = await fastify.inject({
    method: 'DELETE', url: `/api/v1/projects/${projectId}/repos/${api.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.statusCode, 200);

  // 4) verify only 1 left
  const finalRes = await fastify.inject({
    method: 'GET', url: `/api/v1/projects/${projectId}/repos`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(JSON.parse(finalRes.body).repos.length, 1);
});
```

- [ ] **Step 19.2: 运行 E2E**

```bash
cd server && npm test -- test/e2e/multiRepo.test.js
```

期望：通过。

- [ ] **Step 19.3: 提交**

```bash
git add server/test/e2e/multiRepo.test.js
git commit -m "test: 多仓库 E2E — 导入/列出/删除"
```

---

### Task 20: 完整测试套件

- [ ] **Step 20.1: 运行所有后端测试**

```bash
cd server && npm test
```

期望：所有原有测试 + 新增多 repo 测试通过；如有失败，按 fix 流程处理。

- [ ] **Step 20.2: 运行所有前端 lint + test**

```bash
cd web && npm run lint && npm test
```

期望：所有 lint 警告解决；所有前端测试通过。

- [ ] **Step 20.3: 手动 E2E**

1. 启动 dev server：`cd server && npm run dev`
2. 浏览器登录 → 创 Workspace → 选"多 repo 导入"→ 加 2 个 repo URL
3. 启动 Session → 选择 kimi → 在终端看到 `/workspace/web` 和 `/workspace/api` 两个目录
4. 切 WorkspacePanel tabs 切换文件树
5. 切 ChangesPanel tabs 看不同 repo 的变更
6. 触发 Preview → 多 tab 切换

- [ ] **Step 20.4: 提交最终 fix（如有）**

```bash
git add -A
git commit -m "fix: 多仓库 E2E 完整套件通过"
```

---

## 自检清单

- [ ] 数据库 migration 已运行（`project_repos` 表存在）
- [ ] `useProjectRepos` hook 拉取/增删/设主功能通过测试
- [ ] `repoSelection` 纯函数：同前缀锁定组、取消全部解锁，测试通过
- [ ] `RepoImportDialog` 多选勾选：行 checkbox、点击行即勾选、跨前缀禁用；单选走原逻辑
- [ ] `MultiRootFileTree` 单 repo 走原 FileTree，多 repo 渲染 tabs
- [ ] `WorkspacePanel` 已切换到 `MultiRootFileTree`
- [ ] BoxLite `buildRepoVolumes` 输出多 mount，单 repo 兼容（guest=/workspace）
- [ ] `GitOperationService(repoSubPath)` 路由到正确 worktree
- [ ] import-git 接受 `repos` 数组（`repo_url` / `repo_full_name` 两种模式），并发 clone；单仓库导入兼容
- [ ] `/api/v1/projects/:id/repos` CRUD 通过集成测试
- [ ] Deployment spec.previews[] 与 gateway path 路由工作
- [ ] Session 启动流程/Agent 选择界面未被改动（回归验证通过）
- [ ] E2E 测试通过

---

## 验收标准

1. 创建一个 2-repo（frontend + backend）project，能完整跑通：导入（勾选同前缀仓库）→ Session 启动 → 文件浏览 → Changes → Preview
2. 现有 1-repo project 行为完全不变（向后兼容；单仓库导入 / Session 启动流程不动）
3. 所有原有测试 + 新增测试通过
4. 文档（Architecture/Concepts/ApiClient）已更新
