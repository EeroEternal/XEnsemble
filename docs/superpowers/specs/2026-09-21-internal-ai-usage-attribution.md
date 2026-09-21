# 内置 AI 功能的用量归属、计量与展示设计

> 状态：**设计稿(未实现)** · 日期:2026-09-21
> 关联:[Architecture.md](../../Architecture.md) §5.5 LLM Gateway、[LlmProxy.md](../LlmProxy.md)、[UserManagement.md](../../UserManagement.md)

## 1. 背景与问题

平台内置了一批由服务端直接调用大模型实现的 AI 功能(部署栈分析、部署验证、MR/PR 信息生成、会话标题、对话摘要、技能提取/分类等)。这些调用目前存在三个缺口:

1. **无用量统计**:`llm_usage` 表的注释明确「会话标题/摘要等内部调用一期不计入」——内置 AI 的 token 消耗完全不可见;
2. **无网关路由**:各调用点用 `LLM_ANALYZE_*` 环境变量**直连 provider**(默认 deepseek),绕过 UniGateway 与智能路由,模型/密钥分散在 5 处独立实现里;
3. **无用户归属**:产品要求「项目内 token 用量都归属到用户」,而内置调用没有记录发起者,即使计入用量也无法归属。

## 2. 现状盘点:内置 AI 调用点矩阵

全部共用 `LLM_ANALYZE_API_KEY` / `LLM_ANALYZE_API_URL` / `LLM_ANALYZE_MODEL` 环境变量,但存在 **5 处独立实现**:

| # | 实现位置 | 功能(feature) | 触发入口 | 归属来源(userId 从哪来) |
|---|---------|----------------|---------|--------------------------|
| 1 | `llm/analyzeClient.js`(`chat`/`chatJson`) | `session_title` 会话标题、`conversation_summary` 上下文摘要、`trajectory_report` 轨迹报告、`skill_extract`/`skill_classify` 技能管线 | SessionManager 后台、`skillPipeline`、`trajectoryReport` | 有 `sessionId` → 查 `sessions.user_id`;技能管线经 session/project → 归属 owner |
| 2 | `deployments/analyzeDeploy.js`(自建 fetch) | `deploy_analyze` 部署栈分析 + LLM plan(含内置 ReAct fallback,一次功能可能多次请求) | `routes/workspace.js`(HTTP,`request.user.id` 可得)、`quickPreview.js` | HTTP 上下文直接取 |
| 3 | `deployments/analyzeVerify.js`(自建 fetch) | `deploy_verify` 部署验证分析 | deployments 流程(verify 阶段) | 经 `deployments` → project → owner;或调用链透传 |
| 4 | `routes/projectGit.js:309`(自建 fetch) | `git_pr_fill` commit message / MR·PR 标题描述生成 | HTTP 路由(`request.user.id` 可得) | HTTP 上下文直接取 |
| 5 | `deployments/quickPreview.js`(复制了一份 `chatCompletionsUrl` + fetch) | `quick_preview` 快速预览生成(`analyzeOpencode` 的 opencode 探索同链路) | `routes/workspace.js` | HTTP 上下文直接取 |

### 既有可复用基础设施(不新建平行体系)

| 组件 | 位置 | 复用方式 |
|------|------|---------|
| `llm_usage` 事实表 | `db/schema.js`(0028/0030/0034/0035 演进) | 直接扩展列(§4.3) |
| usage 解析 | `llm/usageExtractor.js`(OpenAI/Anthropic 双协议) | internalClient 直接调用 |
| 写入模式 | `proxy.js` 成功响应 fire-and-forget insert | internalClient 照抄该模式 |
| 价格/成本 | `llm/modelCatalog.json` + `admin/routingCost.js` | deepseek-chat 已在目录中;成本仍查询时按 model join 计算,不落库 |
| 聚合服务 | `admin/UsageService.js`、`UserAdminService`、`routingCost` | 聚合 SQL 加 `source`/`feature` 维度 |
| 用户端 API | `GET /api/v1/usage/me?days=`(`routes/user.js`) | 响应结构扩展(§4.6) |
| 前端展示 | `UsageAdmin.jsx`(管理端)、`MyUsagePanel.jsx` + `UserUsageDialog.jsx`(用户端) | 分组/图例扩展(§4.6) |

## 3. 目标与非目标

### 目标

1. **统一入口**:5 处独立实现收敛为一个 internal LLM client;新增内置 AI 功能只此一条路;
2. **完整计量**:每次内置调用成功后,token 用量写入 `llm_usage`(与 agent 会话流量同表同口径);
3. **用户归属**:每行用量都有 `userId`(NOT NULL 约束保持成立),并能区分「哪个功能」产生的;
4. **展示**:用户端「我的用量」与管理端用量页都能区分智能体流量与内置功能流量,并按功能细分。

### 非目标

- **不让内置调用走 UniGateway / 智能路由**(本期):`xel_*` session token 与 per-agent binding 均以 session/agent 为锚点,internal 调用是控制面自身发起、无 session 生命周期;让 server 自己 HTTP 代理到自己(server → `/api/v1/llm` → gateway → provider)是自我回环,徒增故障面。智能路由的粘性/难度评估对单轮短 prompt 价值有限。预留 `LLM_ANALYZE_API_URL` 指向 gateway 的切换能力即可(见 §4.5);
- **不纳入 proxy 的每分钟限流**(`llm/quota.js`):那是面向 agent 会话洪流的闸门;internal 调用低频且在服务端自己手中,额度可控;
- **不改 BYOK 流量**:用户自配 key 的会话流量本就不经 proxy、不计入,维持现状。

## 4. 方案设计

### 4.1 统一调用入口:internalClient(演进 `analyzeClient.js`)

以现有 `llm/analyzeClient.js` 为基座扩展(不新建文件,避免双客户端并存):

```js
// server/src/llm/analyzeClient.js 扩展后的签名
async function chat({
    system, user, options,
    // ── 新增:计量与归属三元组(userId 必填,缺失抛 LlmAttributionError)──
    feature,        // 枚举见 §4.3,写 llm_usage.feature
    userId,         // 归属用户(必填;所有现存调用点均可获得,见 §4.2)
    sessionId,      // 可选:关联会话(标题/摘要/技能管线)
    projectId,      // 可选:关联项目
})
```

内部流程(与 `proxy.js` 计量路径对齐):

```
组装 body(现有逻辑不变)
  → fetch provider(env 配置不变)
  → 成功:extractUsage(data) → fire-and-forget insert llm_usage
  → 失败(4xx/5xx/超时):可选写 events 审计(llm_internal_fail,含 feature/userId/status),不写 llm_usage
       (与 proxy 口径一致:usage 只在成功响应上出现)
```

`chatJson` 自动继承(内部调 `chat`)。**改造矩阵**:#2 `analyzeDeploy`、#3 `analyzeVerify`、#4 `projectGit`、#5 `quickPreview` 的自建 fetch 全部删除,改为 require internalClient(顺带消灭 4 份重复的 timeout/JSON-mode/thinking-模型名单逻辑——散落的 `LLM_JSON_MODE`、`LLM_NO_THINKING_MODELS`、`LLM_ANALYZE_REASONING_EFFORT` 处理统一收进 client 的 options)。

### 4.2 归属模型:userId 必填,无兜底

**设计结论(2026-09-21 代码验证修订)**:所有 8 个调用点都能拿到确定的 userId,**不存在无主调用场景**,因此不做任何系统用户兜底——`userId` 是 client 的必填参数,缺失即抛 `LlmAttributionError`,让未来新调用点的漏传在开发期暴露,而不是静默错记。

| 场景 | userId 来源 | 代码证据 |
|------|------------|---------|
| HTTP 路由 4 处(deploy 分析、verify、PR 填充、快速预览) | `request.user.id` 直接透传 | `twoStage.js:4816` 等路由体已持有 |
| 后台 4 处(标题、摘要、轨迹、技能) | 调用链上**已经查着** `sessions.userId` | `titleService.js:67`、`skillPipeline.js:84` |

为什么不可能出现解析失败(三条已验证的前提):

1. `sessions.user_id` 为 NOT NULL(schema.js:118)→ 有 sessionId 必有 owner;
2. 会话删除是软删(`status='exited'`,DB 行保留)→ 调用时按 sessionId 解析永远成功;
3. 用户删除实为挂起(`suspendUser`,行保留,无 `DELETE FROM users`)→ `llm_usage.user_id` 的 FK 永远可满足,在途调用不受影响。

归属解析发生在调用发起前,usage 插行使用的是已解析的 userId,与会话后续状态变化无关。**若未来出现真正无主的系统级 AI 功能(当前不存在),届时显式决策归属口径,不预设隐藏兜底。**

### 4.3 数据模型:`llm_usage` 扩展(迁移 0043)

```sql
-- 0043_llm_usage_internal.sql
ALTER TABLE llm_usage ADD COLUMN source  text;  -- 'session'(agent 会话流量)| 'internal'(内置 AI)
ALTER TABLE llm_usage ADD COLUMN feature text;  -- 内置功能标识,internal 行必填
-- 无 NOT NULL:存量行与 proxy 路径不回填,查询用 COALESCE(source,'session')
```

`feature` 枚举(开放式 text,代码内常量表收敛,避免 migration 频繁改枚举):

```
session_title | conversation_summary | trajectory_report
skill_extract | skill_classify
deploy_analyze | deploy_verify | quick_preview | git_pr_fill
```

> 无系统用户兜底(见 §4.2):`userId` 必填由 client 强制,迁移仅两列,不动 `users` 表。
>
> 注意:`_journal.json` 的 `when` 必须保持对 0042 的单调递增(参见 unread-count 500 的事故教训);drizzle 生成 SQL 后同步检查 meta 快照。

不新建独立表的理由:内置用量与会话用量同构(同一批 token 字段、同一套按用户/时间聚合的报表),分表会让管理端成本报表、用户端额度视图全部需要 UNION;一列 `source` 的区分成本远低于两张表。

### 4.4 计量写入细节

对齐 `proxy.js` L997-1014 的既有模式:

- **时机**:`res.ok` 且 JSON 解析成功后;`extractUsage` 拿不到 usage(provider 未返回)则不插行(与 proxy 一致,区分「0 token」与「未上报」);
- **方式**:`void db.insert(...)` fire-and-forget,**不阻塞**功能主流程、失败仅 `console.warn`(计量永远不能拖垮业务);
- **字段映射**:`model` = 实际请求 model;`requestedModel`/`trigger`/`seq`/`difficulty` 为 null(无路由);`latencyMs` client 内自带计时;`statusCode` = res.status;
- **多次请求的功能**(deploy ReAct fallback、opencode 探索):每次 LLM 请求一行,feature 相同——事实表本就按请求粒度,聚合时自然累加。

### 4.5 与网关路由的关系(本期直连,预留切换)

- internal 调用继续直连 provider,`LLM_ANALYZE_*` 三个 env 语义不变——**零部署配置变更**;
- `LLM_ANALYZE_API_URL` 天然可指向 UniGateway 的 `/v1/chat/completions`(gateway 侧为 internal 建一个 `service_id = __internal__` binding),未来若要纳入统一模型池/成本优化,仅改 env,client 代码不动;
- client 的 baseUrl 拼接沿用 `chatCompletionsUrl()`(收敛进 client 后 5 处复制消失)。


### 4.6 聚合与展示

**后端**(`admin/UsageService.js` + `routes/user.js` 的 `/usage/me`):

- 聚合查询的维度从 `agent` 扩展为 `source`(+ internal 行的 `feature`);
- `/usage/me` 响应扩展示例(向后兼容,新增字段):

```jsonc
{
  "days": 14,
  "totals": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 },
  "byAgent": [],
  "bySource": {
    "session":  { "totalTokens": 0, "costUsd": 0 },
    "internal": { "totalTokens": 0, "costUsd": 0 }
  },
  "internalByFeature": [
    { "feature": "deploy_analyze", "requests": 12, "totalTokens": 0, "costUsd": 0 },
    { "feature": "git_pr_fill",    "requests": 30, "totalTokens": 0, "costUsd": 0 }
  ],
  "daily": []
}
```

**前端**:

- `MyUsagePanel.jsx`:总量区拆「智能体会话 / 内置功能」两块;内置功能用横向条形/列表按 feature 展示(feature → i18n 显示名,走 `shared/i18n` 现有 usage 相关命名空间,新增 key 中英双语);
- `UsageAdmin.jsx` / `UserUsageDialog.jsx`:管理端表格加「来源」列与 feature 筛选;每行用量都归属真实用户,无系统账号混排;
- 迷你柱状图/成本合并逻辑(`routingCost`)不动——internal 模型已在 `modelCatalog.json`,成本自动纳入。

### 4.7 存储差异与可识别性(内置 vs Agent 对话)

实现后两者**同表**(`llm_usage`)、同 token 字段口径(成本/聚合报表全复用),靠 4 个维度区分:

| 字段 | Agent 对话行 | 内置 AI 行 |
|---|---|---|
| `source`(新增) | `'session'` | **`'internal'`**(主识别键) |
| `feature`(新增) | `null` | `'deploy_analyze'` / `'git_pr_fill'` / … |
| `agentId` | JWT claims 的 aid | `null`(无 agent 实体) |
| `requestedModel`/`trigger`/`seq`/`difficulty` | 智能路由观测值 | 全 `null`(不走路由) |
| `sessionId` | 必有 | 标题/摘要/技能有(归属会话);deploy/PR 填充一般无 |

提取与按功能分析即普通 SQL(`WHERE source='internal'` + `GROUP BY feature`,成本 join `modelCatalog` 同现有口径)。

**为什么必须显式 `source` 列而非空值推断**:标题/摘要/技能类内置调用本身携带 sessionId(就是用户会话),靠 `sessionId IS NULL` 猜会把它们误判为 agent 对话——同一会话内「agent 对话用量」与「标题生成用量」将无法区分。显式打标是唯一无歧义方案。

**内容不落库**(与 agent 流量一致):只存 token 计数,不存 prompt/响应正文。未来若需内容级分析(评估 prompt 质量/回答准确性),在 client 单点加采样即可——对比现状 5 处散落 fetch 是质变;现状下内置调用在库中**零痕迹**,根本无从提取,这正是本方案要解决的缺口。

### 4.8 可观测性(顺带补齐)

- 每次内置调用成败打结构化日志:`feature`、`userId`、`model`、`latencyMs`、`statusCode`;
- 失败写 `events` 审计(`llm_internal_fail`),管理端排障可查「PR 填充为什么没出来」。

## 5. 实施步骤(建议三个独立可合入的 PR)

| 阶段 | 内容 | 涉及 |
|------|------|------|
| **P0 计量打通** | 迁移 0043(两列 + 系统用户);analyzeClient 扩展(签名/计时/extractUsage/insert);analyzeDeploy、analyzeVerify、projectGit、quickPreview 改走 client 并透传 userId;单测 | `db/schema.js` + 迁移、`llm/analyzeClient.js`、4 个调用点 |
| **P1 后台归属补全** | titleService、conversationSummaryService、trajectoryReport、skillExtractor/skillClassifier 传 `sessionId`/userId 解析;`feature` 常量表 | session/skills 各服务 |
| **P2 展示** | UsageService 聚合扩展、`/usage/me` 新字段、MyUsagePanel / UsageAdmin / UserUsageDialog 改版、i18n key | server 聚合 + web 三组件 + `shared/i18n` |

## 6. 测试与验收

- **单测**:internalClient 的 usage 抽取/插行(成功、provider 无 usage、HTTP 失败不插行);`feature`/`userId` 透传断言;
- **回归**:现有 `analyzeClient.test.js`、`usageExtractor.test.js`、proxy/usage 相关套件全绿;
- **验收口径**:
  1. 触发一次 PR 描述生成 → `llm_usage` 新增一行 `source='internal'`、`feature='git_pr_fill'`、userId=操作者;
  2. 触发一次会话标题生成 → 行归属 session 的 user;
  3. `/usage/me` 能看到 internal 分类;`UsageAdmin` 按用户筛选能看到内置功能用量;
  4. 断网 provider 时功能报错但服务不崩、无 usage 行、有 fail 审计。

## 7. 开放问题(实现前确认)

1. ~~`deploy_verify` 的触发方是否总能拿到发起用户?~~ **已解决(2026-09-21 代码验证)**:verify 唯一触发入口是 `POST /api/v1/projects/:projectId/auto-deploy`(`twoStage.js:4800`,`authenticate`+`requireActive`),路由体直接持有 `request.user.id` 并传入 `runAutoTwoStageDeploy`;全库无 cron/webhook/loopTask 触发 verify 的路径。**不存在定时触发场景,userId 一路透传即可**;
2. ~~系统用户是否需要排除在报表之外?~~ **已消解(2026-09-21 设计修订)**:无主调用场景经论证不存在(§4.2 三条前提),`user_system` 兜底连同该口径问题一并移除;
3. 未来若 internal 也要限额度(防滥用 PR 填充脚本刷 token),可在 client 加每用户每日次数上限——本期不做,字段已足够支撑(按 feature+userId 聚合即可实现)。



