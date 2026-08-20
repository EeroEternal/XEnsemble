# 方案四：VM 暖池（warm pool）

## 核心思路

预启动 N 个 base VM 放入池中。session 启动时从池中取一个，装 agent CLI + mount workspace。session 停止后 VM 清理回池。

```
warm pool: [VM1, VM2, VM3, ...] (base image, 已开机)

session start -> 取 VM2 -> install claude-code -> mount workspace -> spawn
session stop  -> hibernate VM2 -> 清理 agent -> 回池
```

## 改动范围

### 新建 Pool Manager

- 预启动 N 个 base VM（`box-base:bookworm`）
- 维护池状态：idle / in-use / cleaning
- 分配策略：优先分配之前装过同 agent 的 VM（缓存 install）
- 回收策略：session 停止后清理 agent 环境，回池

### Runtime 层（`RuntimeService.js`）

- `ensureProjectRuntime` 不再绑定 project -> runtime
- 改为从池中取 VM，动态关联到 session
- session 结束后解绑

### Session 启动

- 从池取 warm VM
- 执行 agent install（若该 VM 之前装过同 agent 则跳过）
- mount workspace（或 worktree）
- spawn agent 进程

### Session 停止

- hibernate VM 或清理后回池
- 保留或清理 agent CLI（取决于池策略）

### Pool 配置

- `POOL_SIZE`：最大并发 VM 数
- `POOL_MIN_IDLE`：最小空闲数（保证快速响应）
- `POOL_WARM_IMAGE`：预装镜像

## 评估

| 维度 | 评估 |
|---|---|
| 资源 | **池大小 = 最大并发数**，可控 |
| 启动速度 | warm VM 秒级可用 + agent install 15-60s |
| 进程隔离 | VM 级完全隔离 |
| Git | 每个 VM 独立 mount，可用 worktree |
| 镜像管理 | 只需 base 镜像 |
| 缺点 | 池管理复杂（分配/回收/清理）；agent install 每次都要做（除非缓存） |

## 改动量

大。需要新建 pool manager、VM 生命周期管理、agent 环境清理逻辑。

## 适用场景

- 用户量大，需要严格限制并发资源
- 类似 serverless / FaaS 模型
- 对启动速度要求不高（可接受 15-60s install）
