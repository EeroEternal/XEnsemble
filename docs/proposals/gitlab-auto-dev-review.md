# GitLab 自动开发与自动评审合入 — 可行性评估与实现方案

> 状态：proposal（待评审）
> 范围：GitLab 仓库的两个循环任务全自动化——①开发任务（改码 → commit → push → 开 MR）；
> ②评审任务（走查 open MR → 评审意见 → 合入）。CI/CD 自动部署本期暂缓（产品裁决）。
> 关联：`docs/Designs.md` § LoopTask、`server/src/loopTasks/runner.js`、`server/src/git/MergeRequestService.js`

## 1. 结论

**能实现。** 服务端 GitLab 能力 100% 齐备（Git 面板的人工流程天天在用同一套服务），
缺的只是「循环任务 Agent 会话 → 服务端 Git 能力」的触发通道，外加一个 GitLab 特有的
审批身份约束。两期落地，总工作量约 **3-5 人日**，全程不需要把任何凭据下发进沙箱。

## 2. 现状盘点

### 2.1 已具备（直接复用，零开发）

| 能力 | 代码位置 | 说明 |
|---|---|---|
| 服务端带凭据 git 操作 | `server/src/git/providers/GitLabAdapter.js`（fetch/push 经 `GitOperationService`） | `buildCredentialEnv` 以 GIT_ASKPASS 按单条命令注入 token，不落盘、不进沙箱 |
| **一次调用 = 推分支 + 开 MR** | `server/src/git/MergeRequestService.js` `create()` | 幂等（本地+远端双重去重）、fetch/rebase 源分支到目标、`pushBranch`、竞态兜底、`mr.created` 审计事件；冲突抛 `rebase_conflict` |
| MR 读取 | `list/syncAll/listMrFiles` | 评审任务的「列 open MR / 读 diff」 |
| 评审动作 | `approvePR / mergePR / addComment` | `GitLabAdapter.mergePR` 已支持 `squash` + `should_remove_source_branch` 参数 |
| 无人值守执行 | `server/src/loopTasks/runner.js` | 交互式拉起 + prompt 注入确认 + 轨迹级完成判定 + 最终回复提取（`extractRunResult`） |
| MCP 注入任务会话 | `server/src/session/createAgentSession.js`（`injectMcpConfigForSession`） | 对 `source=loop_task` 会话同样生效（GitHub preset 已验证该链路） |
| 私有部署 apiBase | `MergeRequestService.repoApiBase()` | 按仓库 host 推断，自建 GitLab 实例已处理 |

### 2.2 缺口（3 个）

1. **沙箱内无 push 凭据**：workspace 的 origin URL 已脱敏（`stripCredentialFromUrl`），
   askpass 只在服务端按单条命令注入 → agent 在沙箱里自己 `git push` 必然 auth fail。
2. **Agent 无 MR API 通道**：agent box 镜像无 `gh` CLI；`mcpPresets.js` 无 GitLab preset；
   平台未内置任何 MR 工具。
3. **审批身份约束（GitLab 特有）**：GitLab 默认禁止 MR 作者 approve 自己的 MR；
   而系统 token 缓存按 `userId:provider` 一人一号（`GitConnectionService.tokenCacheKey`），
   开发与评审任务共用同一 GitLab 身份 → approve 步骤会被 403 拒绝。

## 3. GitLab 审批身份约束的对策

| 对策 | 说明 | 采纳 |
|---|---|---|
| a. 跳过 approve，直接 merge | GitLab Free 默认 approvals required = 0，merge 不被阻断；评审意见通过 MR comment + run.result 落痕 | ✅ Phase 2 起步方案 |
| b. 实例开启 self-approval | 需要 GitLab 管理员改实例设置，不属于平台代码改动 | 备选 |
| c. 评审任务用独立 bot 账号 PAT | 真四眼原则；需要平台支持任务级多凭据（tokenCache 目前一人一号） | 后续增强，本期不做 |

## 4. 实现方案

### Phase 1：开发任务全自动（约 1-2 人日）

机制：**runner 收口钩子（协议驱动）**——token 不进沙箱。

1. 模板 prompt 要求 agent 在最终回复**末尾**输出结构化块：

   ```
   ---XENSEMBLE-MR---
   branch: agent/task-20260218-login-fix
   target: main
   title: fix: 登录态过期未清理轮询
   description: 变更点 / 自测结果 / 风险与回滚
   ```

2. runner 在 `finalize(status === 'succeeded')` 后解析协议块 → 调
   `MergeRequestService.create(project, { title, body, sourceBranch, targetBranch }, task.userId)`。
   create 内部完成 rebase / push / 去重 / 创建 / 审计。
3. 结果处理：
   - 无协议块或分支相对基线无新提交 → 正常收口，跳过开 MR（合规结束，不算失败）；
   - `rebase_conflict` → run 保持 succeeded，result 注明「MR 未开出，需人工处理冲突」；
   - 成功 → MR web_url 回写 `run.result`，SSE 通知。
4. 协议块解析直接读 trajectory（`trajectory.getAllSteps` 全量文本），**不要**从
   `extractRunResult` 的 16KB 截断结果里解析（长回复尾部会被截掉）。

改动点：`loopTasks/runner.js` 钩子、新文件 `loopTasks/mrProtocol.js`（解析器 + 单测）、
i18n 模板 prompt 更新（替换「gh CLI 降级」段落为协议块约定）。

**为什么不把凭据注入沙箱**（备选方案被否原因）：agent 可读取自身 env（`cat /proc/self/environ`），
token 泄露面不可控；服务端钩子零泄露，且幂等/去重/审计逻辑全部复用既有实现。

### Phase 2：评审任务全自动

> **已落地（路线 A）：GitLab MCP preset**——`mcpPresets.js` 新增 `gitlab` preset
> （`@zereight/mcp-gitlab@2.1.65` 钉版本，npx 运行；用户配置 PAT + 自建实例
> API URL）。启用后所有会话（含循环任务）获得完整 MR 工具，`mr_review_merge`
> 模板 prompt 已对齐（工具优先 → CLI → 匿名 API → 本地分支四级降级，
> GitLab 作者自批限制已在 prompt 内注明跳过 approve 直接 merge）。
> 路线 B（平台内置 MCP 桥，token 不出服务端 + 服务端硬护栏）保留为多租户
> 规模化时的升级路径；路线 C（runner 注入 + 收口协议）留作私有仓库读路径的兜底。

机制（路线 B 原设计，保留备查）：**平台内置 MR 工具桥**（MCP stdio server + 会话级桥接 token）。

> **最小实现（推荐先行）：runner 注入 + 收口协议执行**——runner 本身在服务端，
> 触发时调 `MergeRequestService.list()` 把 open MR 列表（编号/标题/源分支，可附
> 尺寸截断后的 diff）直接拼进任务 prompt 注入沙箱；收口时解析最终回复里的协议块
> （`MERGE: !iid` / `REJECT: !iid 原因`）由 runner 服务端代执行 `mergePR`/
> `addComment`。不建新进程/内部路由/桥接 token，凭据全程不出服务端；限制是
> 上下文一次性给全（超大 diff 需截断），Agent 不能按需再拉。约 1 人日。
> 下述 MCP 工具桥作为按需升级路径保留。

1. server 新增内部路由 `/internal/mr-bridge/*`：列 open MR / 取 MR 文件 diff /
   发评论 / merge。鉴权用 spawn 时经 env 注入的短时会话 token（仿 `llm/sessionToken`），
   作用域绑定该会话 + 项目，过期即失效。
2. 新增内置 MCP stdio 脚本（`server/mcp/xensemble-mr/`），注册为 builtin preset，
   随任务会话自动注入——用户零配置、不填任何 token。
3. agent 获得工具：`list_open_mrs` / `get_mr_files` / `comment_mr` / `merge_mr`。
4. `merge_mr` 内置服务端护栏：只允许合 `agent/*` 分支的 MR；merge 走
   `MergeRequestService.mergePR` 并**透传 squash / removeSourceBranch**
   （adapter 已支持参数，service 目前没传，小改）。
5. 评审护栏（prompt 与工具双层）：禁区路径（`.gitlab-ci.yml`、锁文件、认证/部署脚本）
   的 MR 不合；本地 lint/测试跑不过不合；存疑转人工；评审台账落 MR comment + run.result。
   approve 按 §3 对策 a 暂不调用（`approvePR` 服务端已就绪，未来接 bot 账号即可启用）。

**备选快速路径**：`mcpPresets.js` 增加 GitLab 官方 MCP server preset（用户填 PAT）。
实现最快，但 token 进沙箱、每用户手工配置、自部署 apiBase 适配需验证——仅作为
Phase 2 前的临时手段，不作为目标方案。

### 显式不做（本期）

- CI/CD 自动测试部署（产品裁决暂缓；`auto_cicd` 模板保留，测试/构建部分仍可用）；
- bot 账号多凭据（tokenCache 按 `userId:provider` 一人一号，改造影响面大，按需立项）。

## 5. 工作量与验收

| 里程碑 | 内容 | 工作量 |
|---|---|---|
| Phase 1 | 收口钩子 + 协议解析 + prompt 更新 + 单测 | 1-2 人日 |
| Phase 2 | mr-bridge 路由 + 内置 MCP preset + mergePR 参数透传 + 单测 | 2-3 人日 |

验收：真实 GitLab 项目（gitlab.com 或自建实例）接入 → 两个任务 Run now →
端到端核对：开发任务产生 MR（含描述与审计事件）；评审任务在 MR 上留评审台账并合入
（squash + 删源分支）；冲突 / 无变更 / 禁区路径三类用例均按预期跳过或转人工。

## 6. 风险与边界

- **同一身份既开发又评审**：GitLab 侧无技术阻拦（merge 不需要 approve），但流程上
  「自己合自己」缺乏独立制衡——护栏全靠 prompt + 服务端禁区规则；上 bot 账号前建议
  对 `agent/*` 分支的合并保持保守（diff 上限、禁区清单、存疑转人工）。
- **协议块被 agent 忽略**：prompt 已强约束 + 解析失败只是降级（不开 MR），不会误开。
- **长任务**：评审任务逐 MR 走查可能超 60min 默认超时（`LOOP_TASK_TIMEOUT_MS` 可调）。
