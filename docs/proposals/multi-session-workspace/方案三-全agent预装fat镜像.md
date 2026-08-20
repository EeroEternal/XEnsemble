# 方案三：一 workspace 一 fat VM（全 agent 预装）

## 核心思路

构建一个"全家桶"镜像，把所有 14 个 agent CLI 都预装进去。每个 session 只是同一个 VM 里 spawn 一个新进程。

```
workspace ── 1 个 VM (agent-all-in-one)
              ├── session A: claude-code  (直接 spawn)
              ├── session B: kimi-code    (直接 spawn)
              └── session C: opencode     (直接 spawn)
```

## 改动范围

### 镜像构建

- 基于 `box-base:bookworm`，在 Dockerfile 中批量安装所有 14 个 agent CLI
- 生成一个 `xensemble/agent-all-in-one:latest` 镜像
- 任一 agent 更新需重建整个镜像

### Runtime 层（`RuntimeService.js`）

- `resolveBoxImage` 永远返回 `agent-all-in-one` 镜像
- 不传 `agentId`，不解析 per-agent 镜像
- `storedSpecs.image` 永远是 all-in-one，不触发 VM 重建

### Session 启动

- `ensureProjectRuntime` 返回 VM 后，直接 spawn agent 进程
- 无需安装步骤，所有 CLI 已预装

### Git Worktree 配合

- 与方案一/二相同，每个 session 的 VM mount 自己的 worktree 目录

## 评估

| 维度 | 评估 |
|---|---|
| 资源 | **1 VM / workspace**，6GB，最优 |
| 启动速度 | **最快**，所有 agent 0s 启动 |
| 进程隔离 | 无 |
| Git | 共享 working tree，需 worktree |
| 镜像管理 | 1 个大镜像（~2-3GB），任一 agent 更新都要重建整个镜像 |
| 缺点 | 镜像大、agent 间依赖冲突风险高（如 Node 版本要求不同：glm-agent 要 18，qwen-code 要 22） |

## 改动量

最小。只需构建一个 all-in-one 镜像，`resolveBoxImage` 永远返回它。

## 镜像大小估算

每个 agent CLI 的安装大小（粗略）：

| agent | 安装方式 | 大小估算 |
|---|---|---|
| kimi-code | npm -g | ~50MB |
| claude-code | npm -g | ~80MB |
| opencode | npm -g | ~180MB |
| cline | npm -g | ~50MB |
| codebuddy | npm -g | ~50MB |
| droid | curl | ~30MB |
| ... | ... | ... |
| **合计** | | ~1-2GB（含 node_modules 依赖） |

加上 base 镜像 ~800MB，总镜像约 2-3GB。

## 依赖冲突风险

- Node 版本：box-base 用 Node 22，部分 agent 要求 18/20，大部分向下兼容
- 全局 npm 包冲突：不同 agent 的 npm 包同名不同版本可能导致冲突
- 系统级依赖：部分 agent 可能需要不同的系统库版本
