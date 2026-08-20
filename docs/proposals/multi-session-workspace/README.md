# 多 Session 方案横向对比

## 方案总览

| 方案 | 核心思路 | VM 数 / 工作区 |
|---|---|---|
| [方案一](./方案一-一agent一VM.md) | 一 agent 一 VM，按 (project, agentId) 创建独立 runtime | N agent |
| [方案二](./方案二-运行时装CLI.md) | 一 workspace 一 VM (box-base)，运行时 npm install 装 agent CLI | 1 |
| [方案三](./方案三-全agent预装fat镜像.md) | 一 workspace 一 fat VM，全 agent 预装在镜像里 | 1 |
| [方案四](./方案四-VM暖池.md) | VM 暖池，取 VM -> 装 CLI -> mount workspace -> 回池 | 池大小 |
| [方案五](./方案五-Docker-in-VM.md) | base VM 内跑 Docker daemon，每 agent 一个容器 | 1 |

## 横向对比

| | 方案一 | 方案二 | 方案三 | 方案四 | 方案五 |
|---|---|---|---|---|---|
| VM 数 | N agent | 1 | 1 | 池大小 | 1 |
| RAM/工作区 | 6GB x N | 6GB | 6GB | 6GB x 池 | ~8GB |
| 启动速度 | 5-10s | 0-60s | **0s** | 15-60s | 秒级 |
| 进程隔离 | **VM 级** | 无 | 无 | **VM 级** | 容器级 |
| 改动量 | 中 | **最小** | **最小** | 大 | 大 |
| agent 依赖冲突 | 无 | 有风险 | **高风险** | 无 | 无 |
| 镜像维护 | N 个 | 1 个 base | 1 个大镜像 | 1 个 base | base + N 个 |
| Git worktree | 需要 | 需要 | 需要 | 可选 | 可选 |

## 最终选择：方案一

经过逐行代码复查，方案一的真实改动量远小于初始评估：
- 初始 review 报 14 个 blocker，复查后确认 8 个误报，真实改动集中在 `RuntimeService.js` 一个文件
- 20+ 被动调用者（git/FS/deploy）不需要改动（走快速路径，用 `storedSpecs.image`）
- `maxRuntimes` 配额未强制，不构成阻碍
- 核心改动：`ensureProjectRuntime` 在有 `agentId` 时按 `(projectId, agentId)` 查/建 runtime，不复用 default

方案一提供 VM 级进程隔离，适合多 agent 安全要求高的场景。详见 [方案一文档](./方案一-一agent一VM.md)。

## 其他方案（备选）

| 方案 | 核心思路 | 未选原因 |
|---|---|---|
| [方案二](./方案二-运行时装CLI.md) | 一 workspace 一 VM + 运行时 npm install | 无进程隔离，agent 依赖冲突风险 |
| [方案三](./方案三-全agent预装fat镜像.md) | 全 agent 预装 fat 镜像 | 镜像大，依赖冲突高风险 |
| [方案四](./方案四-VM暖池.md) | VM 暖池 | 池管理复杂，改动量大 |
| [方案五](./方案五-Docker-in-VM.md) | Docker-in-VM | runtime 层改动大，Docker daemon 开销 |

## Git Worktree

所有方案都建议配合 git worktree 解决多 agent 并发操作同一 git 仓库的冲突问题：

- git worktree 是 git 自带功能（`git worktree add`，git 2.5+）
- 一个 `.git` 仓库创建多个工作目录，每个可 checkout 到不同分支
- `.git/objects`（commit、tree、blob）只有一份，不重复占磁盘
- 在 worktree A 里 `git commit`，worktree B 里 `git log` 立刻能看到（共享 object store）

```
workspace/                    # host 目录
├── .bare/                    # bare repo (共享 object store)
├── worktree-agent-a/        # git worktree, checkout feature-a
│   └── (agent A 的 VM mount 这里)
└── worktree-agent-b/        # git worktree, checkout feature-b
    └── (agent B 的 VM mount 这里)
```

## 服务器资源

- 服务器内存：1.5TB
- 每 VM 默认配置：6GB RAM / 4 CPU / 20GB 磁盘
- Idle 阈值：30 分钟（`SESSION_IDLE_HIBERNATE_MS=1800000`），超过后 hibernate 释放 RAM

| 并发 active session 数 | 内存消耗 | 是否可行 |
|---|---|---|
| 50 | 300GB | 没问题 |
| 100 | 600GB | 没问题 |
| 200 | 1.2TB | 勉强 |
| 300+ | 1.8TB+ | 炸 |

缓解方向：
1. 降低单 VM 内存（轻量 agent 2GB 够用，`agents.vmResources` 已支持 per-agent 配置）
2. 缩短 idle 阈值（30 分钟 -> 10 分钟）
3. 配额限制（已有 session quota）
4. 共享 VM 方案（同 agent 的多个 session 共享一个 VM）
