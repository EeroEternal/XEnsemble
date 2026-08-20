# 方案二：一 workspace 一 VM + 运行时装 agent CLI

## 核心思路

用 `box-base:bookworm` 镜像启动一个 VM（已有 Node/git/curl），新 agent session 启动时在 VM 内执行 `npm install -g` 或 `curl | bash` 安装 agent CLI。`agentLifecycle.js` 已有全部 14 个 agent 的安装命令。

```
workspace ── 1 个 VM (box-base)
              ├── session A: claude-code  (已装, 直接 spawn)
              ├── session B: kimi-code   (首次装 ~30s, 然后 spawn)
              └── session C: opencode    (首次装 ~15s, 然后 spawn)
```

## 为什么可行

1. `box-base:bookworm` 镜像已有 Node 22、git、curl、gh 等基础工具
2. `agentLifecycle.js` 已定义全部 14 个 agent 的 install/uninstall/update 命令
3. Local runtime 模式（`RUNTIME_PROVIDER=local`）本来就是宿主机安装 agent CLI 的逻辑，此方案是将其移入 VM 内
4. 同一 VM 内多个 agent 进程可同时运行，各自独立的环境变量

## 改动范围

### Runtime 层（`RuntimeService.js`）

- `ensureProjectRuntime` 不再传 `agentId`（不解析 per-agent 镜像）
- 始终使用 `box-base:bookworm` 镜像
- `storedSpecs.image` 永远是 base 镜像，`imageMismatch=false`，不触发 VM 重建

### Session 启动（`server.js`）

- `ensureProjectRuntime` 返回 VM 后，在 VM 内执行 agent install 命令
- 检查 agent CLI 是否已存在（`probeAgentCommand`），不存在才 install
- install 完成后 spawn agent 进程

### Agent 安装逻辑（新增）

- 复用 `agentLifecycle.js` 的 `install` 命令
- 通过 `runtime.exec.exec` 在 VM 内执行
- 首次安装 15-60s（npm install -g 或 curl | bash）
- 已安装则跳过（probe 命令检测 `command -v <cmd>`）

### Session resume（`resumeSession.js`）

- 不需要重新安装（CLI 已在 VM 的全局环境中）
- 直接 spawn agent + resume args

### Git Worktree 配合

- 与方案一相同，每个 session 的 VM mount 自己的 worktree 目录

## 评估

| 维度 | 评估 |
|---|---|
| 资源 | **1 VM / workspace**，6GB，最优 |
| 启动速度 | 同 agent 已装过 = 0s；新 agent 首次 = 15-60s（npm/curl 安装） |
| 进程隔离 | 无。同一 VM 内进程互相可见（ps、kill） |
| 环境变量 | 隔离（per-process 注入） |
| Git | 共享 working tree，需 worktree |
| 镜像管理 | 只维护 1 个 base 镜像，agent 版本由 install 命令控制 |
| 缺点 | agent 依赖可能冲突（如不同 Node 版本要求）；install 失败需重试 |

## 改动量

最小。`ensureProjectRuntime` 不传 `agentId`（不解析 per-agent 镜像），session 启动前在 VM 内执行 `agentLifecycle.js` 的 install 命令。

## agent 依赖冲突风险

当前 14 个 agent 的 Node 版本要求：

| agent | minNodeVersion |
|---|---|
| kimi-code | 22 |
| claude-code | 22 |
| commandcode | 20 |
| openclaw | 22 |
| opencode | - |
| glm-agent | 18 |
| qoder | 20 |
| qwen-code | 22 |

box-base 镜像装的是 Node 22，向下兼容 18/20。大部分 agent 是 `npm install -g`，不会互相冲突（各自在 `node_modules` 下独立目录）。主要风险是少数 agent 可能有 native 依赖冲突。
