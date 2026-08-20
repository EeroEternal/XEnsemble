# 方案五：Docker-in-VM

## 核心思路

base VM 内装 Docker daemon，每个 agent 作为 Docker 容器运行，使用已有的 per-agent OCI 镜像。

```
workspace ── 1 个 VM (docker-base)
              ├── docker run agent-claude-code  (container A)
              ├── docker run agent-kimi-code   (container B)
              └── docker run agent-opencode     (container C)
```

## 改动范围

### 镜像构建

- 新建 `docker-base` 镜像：box-base + Docker daemon
- 复用已有的 per-agent OCI 镜像（`agent-claude-code`、`agent-kimi-code` 等）

### Runtime 层

- `BoxLiteRuntimeProvider.ensureReady`：始终用 `docker-base` 镜像，不按 agent 切换
- `BoxLiteExecAdapter.spawn`：改为 `docker run` 而非直接 exec
  - 容器内 mount workspace（或 worktree）
  - 容器内注入环境变量
  - 容器内运行 agent CLI
- `BoxLiteFsAdapter`：路径改为容器内路径

### Docker 容器管理

- 每个 session = 一个 Docker container
- 容器生命周期跟随 session（session stop -> docker stop）
- 容器间通过 Docker 网络隔离/互通

### Session resume

- `docker start` 重启已停止的容器
- agent 进程的 `--resume` / `--continue` 参数不变

### Git Worktree 配合

- 每个 container 可独立 mount worktree 目录
- 容器间文件系统天然隔离

## 评估

| 维度 | 评估 |
|---|---|
| 资源 | 1 VM (~8GB，含 Docker daemon) + N container（轻量） |
| 启动速度 | container 秒级启动，已有镜像可直接 run |
| 进程隔离 | **容器级隔离**，进程/文件系统/网络都隔离 |
| Git | 每个 container 可独立 mount worktree |
| 镜像管理 | 复用已有 per-agent 镜像，无需新建 |
| 缺点 | 需改 runtime 层（spawn 改为 docker run）；Docker daemon 开销；VM 内网络/存储复杂度上升 |

## 改动量

大。`BoxLiteExecAdapter.spawn` 要改成 `docker run`，FS adapter 要改成容器内路径，网络要做容器间互通。

## 技术细节

### Docker-in-VM 的约束

- blink/boxlite VM 需要支持嵌套虚拟化或 Docker 的运行时依赖
- Docker daemon 占用 ~200MB RAM
- VM 需要更大磁盘（存放容器镜像层）
- Docker daemon 启动需要时间（VM 首次启动 +10s）

### 容器网络

- 容器间默认 bridge 网络，可互通
- 容器出网通过 VM 的网络栈
- Preview/dev server 需要端口映射（container -> VM -> host）

### 容器存储

- workspace 作为 bind mount 挂载到容器
- agent state 目录也需挂载（或使用 named volume）
- 容器销毁后非挂载数据丢失
