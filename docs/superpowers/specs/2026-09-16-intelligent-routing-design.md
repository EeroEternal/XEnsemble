# 智能路由（控制面）设计

> 状态：已评审草案  
> 日期：2026-09-16  
> 适用范围：`server/` 控制面 LLM 反代、UniGateway 执行、Agent Gateway 模式  
> 参考：[SmartGate](https://github.com/EeroEternal/SmartGate)、[llm-providers](https://github.com/EeroEternal/llm-providers)、[LlmProxy.md](../../LlmProxy.md)

---

## 1. 目标

在控制面为 Gateway 模式的 Agent 请求做 **缓存粘性 + 成本感知选路**，并把每次决策记入独立事实表，供在线 KPI 和离线反事实回放。

v1 必须落地：接入信号、粘性、触发条件、成本优化器、执行改写、`routing_decisions`、画像获取接口（读仓库内静态 JSON）。

v1 只留接口、不实现：**难度评估器**（返回 `null` 时不做能力门槛；优化器在 Agent 已勾选模型中选最便宜的一条）。

## 2. 非目标

- 按任务复杂度换模型（评估器实现、HyDRA 向量、Judge 小模型）
- Session / Admin 的 `auto | lock` 配置 UI（以后做；v1 评估器为 null 时不改逻辑模型，沿用请求体 `model`）
- BYOK 流量（不走 `/api/v1/llm`）
- 粘性绑到 GPU / 推理实例（UniGateway 不暴露 instance id）
- 运行时请求 GitHub、llm-providers HTTP 服务、或链上 Rust crate
- 引入 Redis；跨实例状态只进 PostgreSQL
- 上下文压缩 / Warm Layer / Delta 投递（不改写 messages；压缩触发见 §5.1，无协议字段，由控制面推断）

## 3. 分层与进程边界

四层都在控制面 `server/src/llm/`。UniGateway 仍只根据 `body.model` 和已有 binding 转发，不读 Session、不读用户、不做任务评估。

```
Agent
  → 控制面 /api/v1/llm（验 xel_）
      接入层：信号
      决策层：粘性 / 是否重评估 / 评估器(stub) / 优化器
      执行层：改写 Authorization + body.model = {provider}/{model}
      观测层：routing_decisions
  → UniGateway
  → 上游供应商
```

Agent 继续只连控制面公开 Router，不直连 UniGateway。

## 4. 模块

建议目录（实现时可微调文件名，职责不可合并进 `proxy.js` 巨石）：

| 模块 | 职责 |
|------|------|
| `llm/modelPortraits.js` | `fetchModelPortraits()`：读静态 JSON；签名稳定，以后可换 HTTP |
| `llm/modelPortraits.registry.json` | llm-providers ParaRouter 导出全文，提交进仓库 |
| `llm/router/signals.js` | 从请求 + DB 抽 session、前缀长度、上次缓存、是否压缩 |
| `llm/router/sticky.js` | PG 粘性读写、TTL、失败解除 |
| `llm/router/triggers.js` | 是否完整重评估 |
| `llm/router/evaluateDifficulty.js` | 接口；v1 返回 `null` |
| `llm/router/optimizer.js` | 候选过滤 + 缓存感知成本；无需求向量时不换逻辑模型 |
| `llm/router/execute.js` | 改写 `body.model`；与现有 opencode alias 改写顺序约定见 §8 |
| `llm/router/decisions.js` | `routing_decisions` 插入与响应回填 |
| `proxy.js` | 只编排：鉴权后调用上述模块，再 `forwardToGateway` |

## 5. 接入层

不做路由决策。每条 chat 路径请求采集：

| 信号 | 来源（唯一） |
|------|----------------|
| `session_id` | `xel_` JWT 的 `sid`。忽略请求体哈希。可选读取 `x-session-id`，与 `sid` 不一致时仍以 `sid` 为准并打 warn |
| 任务语义特征 | 交给评估器的原始输入（messages 长度、是否含 tool、轮次）；v1 评估器不用，仍采集进决策日志的摘要（例如 `msg_count`、`prompt_chars`），不存全文 |
| 缓存元数据 | 该 session 最近一次 `llm_usage.cached_tokens` 与 `prompt_tokens`；本轮前缀长度用 **messages 条数**（不含本轮最后一条 user），并另记 `prompt_chars` 供日志 |
| 压缩 | 见 §5.1。OpenAI / Anthropic 请求体 **没有** 压缩标志字段；Agent 也不会传 `compaction=true`。这是控制面根据 messages 历史 **自己推断**，与 `trajectory.buildRequestRecord` 的前缀比对同一套算法，不是读 trajectory 表里的某个参数 |

### 5.1 压缩推断（无协议参数）

标准 chat/messages 请求没有 `compacted` / `compaction` 一类字段。现网 Agent 压缩后只是改写 `messages`（变短或重写开头）。控制面因此用与 trajectory 相同的规则推断：

- 记下上一轮完整 `messages`（与 `trajectory.js` 的 `prevMessages` 同一来源即可，避免两套历史）。
- **严格追加**（本轮更长，且 `messages[0..prev.length)` 与上一轮逐条相等）→ 不是压缩。
- **否则**，且本 session 已有上一轮 → `compacted = true`（前缀被重写或截断，KV/prompt cache 视为失效）。
- **本 session 第一轮** → `compacted = false`（trajectory 也会写成 snapshot，但那是首包，不是压缩）。

不新增请求头或 body 字段。推断结果写入决策日志 `trigger=compaction`。

## 6. 粘性

- **作用域**：`session_id → (chosen_model, chosen_provider)`，不是只绑模型。
- **存储**：PostgreSQL 表 `session_route_sticky`（进程内 Map 仅作可选加速，重启/多实例以 PG 为准）。
- **TTL**：10 分钟无成功请求则过期；每次 **上游 2xx** 重置过期时间。
- **解除**：粘性供应商返回 4xx/5xx（限流、超时、连接失败）则清除粘性，下轮允许重评估。连续失败计数 N=2 触发 `provider_fail`（同一粘性目标连续两次失败）。

v1 不绑推理实例。`chosen_model` 送出时写成 `provider/model`，供 UniGateway 的 provider hint 使用。

## 7. 决策触发

完整评估（跑优化器）仅当：

1. **首轮**：该 session 无有效粘性。
2. **压缩后**：§5.1 `compacted === true`。压缩后视缓存状态归零再算成本。
3. **粘性供应商连续失败**：见 §6。
4. **任务性质显著转变**：评估器接口预留；v1 **永不触发**（`semantic_shift === false`）。

其余请求：`trigger = sticky`，直接复用粘性 `(model, provider)`，优化器不跑。

## 8. 难度评估器（仅接口）

```js
// 返回需求向量或 null。null = 无意见，禁止据此换逻辑模型。
async function evaluateDifficulty(signals) → DemandVector | null
```

v1 恒为 `null`。日志列 `demand` 为 SQL `null`。接评估器时再定义为 JSON 对象（如 `reasoning` / `code` / `tools` / `long_context` 分数），v1 不预先写假向量。

`null` 的语义是 **无能力门槛**：

- 不按 reasoning/tools/context 过滤模型
- 优化器在 Agent 已勾选模型中按单价选最便宜的一条（无勾选列表时才回退请求体 `model`）
- 禁止改成「会话默认 / claims.model」去覆盖 `/model` 与勾选列表
- 粘性未过期时仍复用上次 `(model, provider)`

## 9. 成本-质量优化器

### 9.1 逻辑模型

评估器返回 `null` 时（v1 总是如此）：**不按能力门槛过滤**，候选 = Agent 已勾选模型（`agent_gateway_config.model[]`）。剥掉 `anthropic.` / `provider/` 前缀后查画像。列表为空时才回退请求体 `model`（再空则 session token / Agent 主模型）。

评估器以后返回向量时，再按能力门槛从勾选列表里过滤。Session `lock` 仍是以后的配置项。

### 9.2 候选供应商

`fetchModelPortraits()` ∩ 该 Agent 已勾选模型 ∩ **当前 UniGateway 已绑定到该 Agent service 的 provider**。

v1 一个 Agent 仍只绑一家 provider 时，候选通常只有一家；优化器仍要跑通报价与日志。跨供应商 failover 的排序在 `resolveProviderRoute()` 中产出完整名单，执行层只采用 **已绑定** 的第一名。未绑定的更高名次记入 `candidates`，`skip_reason = provider_not_bound`。

### 9.3 成本

- 单价：每 1M token 的 cache_read（缓存输入）/ cache_write（缓存输出）/ input / output，先换成美元再比
- **不按请求 token 规模加权**；不读上一轮 `llm_usage`
- 同一 canonical 模型比供应商：`cache_read` → `cache_write` → `input` → `output`
- 跨模型选最便宜：`input` → `output` → `cache_read` → `cache_write`（避免有 cache 报价的更贵模型压过无 cache 报价的便宜模型）
- 某轴 `null` 视为该轴最贵（unknown ≠ 免费）；显式 `0` 才是该轴免费
- 无价候选不能赢过有价候选；未绑定候选不参与执行，只记 `skip_reason=provider_not_bound`

货币：画像带 `price_currency`。写死 PBOC 中间价（2026-09-16 `USD/CNY = 6.7628`），`USD` 汇率为 1。表外货币视为 unknown。`cost_estimate` 存美元单价四元组。

### 9.4 `resolveProviderRoute(agentId, model)`

返回按单价排列的 `{ provider, model, cost_estimate, bound }[]`。v1 传入 Agent 勾选模型 + 网关 `provider`（执行 id 用网关名，价格从画像任意 offering 取最便宜的一条）。画像 `provider_id`（如 zhipu）不得直接写入 `body.model`，否则 UniGateway 对不上 binding。

## 10. 执行层

在现有 `forwardToGateway` 之前：

1. 将 `body.model` 设为 `{chosen_provider}/{chosen_model}`（模型 id 用画像 canonical 名，不含聚合盘前缀）。
2. opencode alias 改写：若仍需要，在本改写 **之后** 再映射 alias→real，避免粘性 id 和上游 id 分叉。实现时以「送进 UniGateway 的最终 model 字符串」写入 `routing_decisions.chosen_*`。
3. 继续现有：覆盖 `Authorization` 为 per-agent gateway key、删除 `x-api-key`、注入 `thinking_budget`。
4. 上游失败：回填决策行、解除粘性。

健康：v1 不新增独立探活循环；用本次请求失败解除粘性即可。

## 11. 画像与 llm-providers

**不是调用线上服务。** llm-providers 是静态目录。v1：

1. 在 llm-providers 仓库执行  
   `cargo run -- export --format pararouter --output eero_llm_providers_registry.json`
2. 将该文件放入本仓库 `server/src/llm/modelPortraits.registry.json`（可改名，但必须进 git）
3. `fetchModelPortraits()` **只读这个文件**

查找：`server/src/llm/modelCatalog.json`，key 为 **provider + model**。值含 USD 单价（input / output / cache_read / cache_write）与 `capability`。同一 canonical/family 模型共用一套价格，暂不考虑供应商差价。未入表 → unknown（不能排到有价候选前面）。

旧 `modelPortraits.registry.json` 不再用于查价。

Agent 子集：现有 `agent_gateway_config` 模型列表，不改 Admin 勾选 UI。

实现时用 `GET /api/v1/admin/gateway/providers` 知道环境里有哪些 provider/模型 id，与 JSON 求交后作为运行时池；JSON 本身保持全文导出。

## 12. 观测：`routing_decisions`

每条 chat 请求一行。请求侧插入，`onResponseBody` / 错误回调回填 usage。不写入 trajectory 全文，不替代 `llm_usage`。

| 列 | 说明 |
|----|------|
| `id` bigserial PK | |
| `created_at` | |
| `session_id`, `user_id`, `agent_id`, `project_id` | 与 `xel_` claims 一致 |
| `seq` | 与同一次 proxy 调用里 `trajectory.recordRequest` 返回的 `seq` **相同**。先拿 trajectory seq，再插入决策行。禁止另做一套计数。 |
| `reevaluated` boolean | |
| `trigger` text | `first_turn` / `compaction` / `provider_fail` / `semantic_shift` / `sticky` |
| `demand` jsonb | v1 `null` |
| `sticky_model`, `sticky_provider` | 本轮开始前 |
| `candidates` jsonb | 优化器所见列表（含报价拆分与 `bound`） |
| `chosen_model`, `chosen_provider` | 实际送出 |
| `cost_estimate` jsonb | 美元单价：`cache_read` / `cache_write` / `input` / `output` / `currency` |
| `prompt_tokens`, `cached_tokens`, `completion_tokens`, `latency_ms`, `status_code` | 响应后回填 |
| `error` text | |

索引：`(session_id, seq)` unique；`(user_id, created_at)`；`(created_at)`。

在线 KPI（可后做 Admin 页，本设计不强制 UI）：缓存命中率、粘性保持回合、重评估次数、failover 次数、估算成本。离线回放只读本表，对照始终默认 / 始终最贵 / 始终最便宜。

## 13. 与现有表的关系

| 表 | 角色 |
|----|------|
| `llm_usage` | 成功请求 token 事实，继续写 |
| `session_trajectory` | 对话/工具原文；压缩推断与其 `samePrefix` 共用算法与上一轮 messages 缓存，不读表字段、不塞完整路由 JSON |
| `routing_decisions` | 路由决策与回放 |
| `session_route_sticky` | 热粘性状态 |

## 14. 测试要点

- `evaluateDifficulty` 恒 null 时，在 Agent 勾选模型中选最便宜的一条（无勾选列表才回退请求体 `model`，不是 session 默认模型）
- 无粘性首轮 `trigger=first_turn`；随后未压缩未失败为 `sticky`
- 压缩检测为 true 时 `trigger=compaction`（比价仍按美元单价，不按 token 规模）
- 连续两次上游失败解除粘性并出现 `provider_fail`
- unknown 报价不能排到有价候选前面；显式 0 可以
- `fetchModelPortraits` 只读仓库 JSON，单测用夹具文件，不访问网络
- 决策行在转发成功后回填 `cached_tokens`；失败回填 `error` 且不丢请求侧那一行

## 15. 以后（不在 v1 实现）

- 实现 `evaluateDifficulty` 后：按能力门槛从勾选列表过滤，再跑优化器
- Session `auto \| lock`
- 同一 Agent 多 provider binding，使 `resolveProviderRoute` 的未绑定候选真正可执行
- `fetchModelPortraits` 改为 HTTP
- 粘性 TTL / N 次失败做成可配置
