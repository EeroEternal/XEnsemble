# 智能路由（控制面）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在控制面 LLM proxy 上落地缓存粘性、成本感知供应商选路、`routing_decisions` 观测；难度评估器仅 stub，逻辑模型等于请求体 `model`。

**Architecture:** 决策全部在 `server/src/llm/router/`，`proxy.js` 只编排。画像读仓库内 llm-providers ParaRouter 导出 JSON。粘性与决策进 PostgreSQL。UniGateway 仍只吃改写后的 `provider/model`。压缩无协议字段，用 trajectory 同一套 `samePrefix` 在 `recordRequest` **之前**推断。

**Tech Stack:** Node.js 20, Fastify, Drizzle/PostgreSQL, `node:test`, 现有 `llm/proxy.js` + `http-proxy`。禁止 Redis。

## Global Constraints

- 不引入 Redis；跨实例状态只写 PostgreSQL。
- `evaluateDifficulty()` v1 恒返回 `null`；`null` 时 **不得** 覆盖请求体逻辑模型。
- 逻辑模型 = `body.model`（去掉 `anthropic.` 前缀）；空才回退 token `model` → Agent `primaryModel`。
- 价格优先仓库内静态 JSON；unknown ≠ 0 元；显式 0 才是免费。
- `routing_decisions.seq` 必须等于同一次调用 `trajectory.recordRequest` 的 `seq`。
- 测试 glob：`server/package.json` 的 `test` 必须包含 `src/llm/**/*.test.js`，否则 `router/` 下测试永不跑。
- 迁移用 `cd server && npm run db:generate`，目录 `server/drizzle/`。
- 不改 Admin 勾选模型 UI；不做 Session `auto|lock`；不绑 GPU 实例。

---

## 0. 文件结构

### 新增

| 文件 | 职责 |
|------|------|
| `server/src/llm/modelPortraits.registry.json` | ParaRouter 导出（全文或 schema 合法子集，实现时从 llm-providers `cargo run -- export --format pararouter` 拷入） |
| `server/src/llm/modelPortraits.js` | `canonicalModelId`, `fetchModelPortraits`, `findOfferings` |
| `server/src/llm/modelPortraits.test.js` | 单测（夹具 inline，不读巨型 registry 也可） |
| `server/src/llm/router/pricing.js` | `isPriced`, `estimateCost`, `calculateCost` |
| `server/src/llm/router/pricing.test.js` | |
| `server/src/llm/router/evaluateDifficulty.js` | stub → `null` |
| `server/src/llm/router/evaluateDifficulty.test.js` | |
| `server/src/llm/router/signals.js` | `collectSignals`, `logicalModelFromBody` |
| `server/src/llm/router/signals.test.js` | |
| `server/src/llm/router/sticky.js` | PG 粘性 |
| `server/src/llm/router/sticky.test.js` | 需 DB：`server/src/test/db.js` |
| `server/src/llm/router/triggers.js` | `resolveTrigger` |
| `server/src/llm/router/triggers.test.js` | |
| `server/src/llm/router/optimizer.js` | `resolveProviderRoute`, `chooseRoute` |
| `server/src/llm/router/optimizer.test.js` | |
| `server/src/llm/router/decisions.js` | insert / patch usage |
| `server/src/llm/router/decisions.test.js` | 需 DB |
| `server/src/llm/router/execute.js` | `applyChosenModel(body, route)` |
| `server/src/llm/router/execute.test.js` | |
| `server/src/llm/router/index.js` | `planRoute(ctx)` 编排 |

### 修改

| 文件 | 改动 |
|------|------|
| `server/package.json` | `src/llm/*.test.js` → `src/llm/**/*.test.js` |
| `server/src/db/schema.js` | `sessionRouteSticky`, `routingDecisions` + exports |
| `server/src/llm/trajectory.js` | export `samePrefix`, `getPrevMessages` |
| `server/src/llm/proxy.js` | chat 路径调用 `planRoute`，改写 body，决策回填 |
| `server/drizzle/*` | `db:generate` 产出 |

---

### Task 1: 测试 glob + schema

**Files:**
- Modify: `server/package.json`（`test` script）
- Modify: `server/src/db/schema.js`（`llmUsage` 之后、`module.exports` 之前）
- Create: drizzle 迁移（`cd server && npm run db:generate`）

**Interfaces:**
- Produces: `schema.sessionRouteSticky`, `schema.routingDecisions`

- [ ] **Step 1: 改 test glob**

`server/package.json` 的 `"test"` 里把 `src/llm/*.test.js` 换成 `src/llm/**/*.test.js`。

- [ ] **Step 2: 在 schema.js 增加两表**

紧接 `llmUsage` 定义之后插入（列名与 spec §6 / §12 一致）：

```js
const STICKY_TTL_MS = 10 * 60 * 1000; // 文档用，TTL 逻辑在 sticky.js

const sessionRouteSticky = pgTable('session_route_sticky', {
  sessionId: text('session_id').primaryKey().references(() => sessions.id, { onDelete: 'cascade' }),
  chosenModel: text('chosen_model').notNull(),
  chosenProvider: text('chosen_provider').notNull(),
  failCount: integer('fail_count').notNull().default(0),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

const routingDecisions = pgTable('routing_decisions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
  userId: text('user_id'),
  agentId: text('agent_id'),
  projectId: text('project_id'),
  seq: integer('seq').notNull(),
  reevaluated: boolean('reevaluated').notNull().default(false),
  trigger: text('trigger').notNull(),
  demand: jsonb('demand'),
  stickyModel: text('sticky_model'),
  stickyProvider: text('sticky_provider'),
  candidates: jsonb('candidates'),
  chosenModel: text('chosen_model'),
  chosenProvider: text('chosen_provider'),
  costEstimate: jsonb('cost_estimate'),
  promptTokens: integer('prompt_tokens'),
  cachedTokens: integer('cached_tokens'),
  completionTokens: integer('completion_tokens'),
  latencyMs: integer('latency_ms'),
  statusCode: integer('status_code'),
  error: text('error'),
}, (table) => ({
  sessionSeq: unique('uq_routing_decisions_session_seq').on(table.sessionId, table.seq),
  userCreatedIdx: index('idx_routing_decisions_user_created').on(table.userId, table.createdAt),
  createdIdx: index('idx_routing_decisions_created').on(table.createdAt),
}));
```

`module.exports` 增加 `sessionRouteSticky`, `routingDecisions`。

- [ ] **Step 3: 生成迁移**

Run: `cd server && npm run db:generate`

Expected: `server/drizzle/` 新目录含 `CREATE TABLE session_route_sticky` 与 `routing_decisions`。

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/src/db/schema.js server/drizzle
git commit -m "$(cat <<'EOF'
feat(llm): add routing_decisions and session_route_sticky tables

EOF
)"
```

---

### Task 2: trajectory 导出前缀比对

**Files:**
- Modify: `server/src/llm/trajectory.js`（`samePrefix` 已存在约 181 行；`module.exports` 约 699 行）
- Modify: `server/src/llm/trajectory.test.js`（若无前缀测试则追加）

**Interfaces:**
- Produces: `samePrefix(messages, prev) → boolean`；`getPrevMessages(sessionId) → array|null`（只读 `prevMessages` Map，不更新）

- [ ] **Step 1: 写失败测试**（`trajectory.test.js` 末尾）

```js
test('samePrefix: equal prefix is true, rewrite is false', () => {
    const { samePrefix } = require('./trajectory');
    const prev = [{ role: 'user', content: 'a' }];
    assert.equal(samePrefix([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], prev), true);
    assert.equal(samePrefix([{ role: 'user', content: 'compressed' }], prev), false);
});

test('getPrevMessages returns what rememberPrev stored via record path', () => {
    const t = require('./trajectory');
    assert.equal(t.getPrevMessages('sess_none'), null);
});
```

- [ ] **Step 2: Run 确认 samePrefix 未导出则失败**

Run: `cd server && node --test src/llm/trajectory.test.js`

- [ ] **Step 3: 实现导出**

在 `samePrefix` 旁增加：

```js
function getPrevMessages(sessionId) {
    const prev = prevMessages.get(sessionId);
    return Array.isArray(prev) ? prev : null;
}
```

`module.exports` 加上 `samePrefix`, `getPrevMessages`。

- [ ] **Step 4: 再跑测试 PASS**

- [ ] **Step 5: Commit**

```bash
git add server/src/llm/trajectory.js server/src/llm/trajectory.test.js
git commit -m "$(cat <<'EOF'
feat(llm): export samePrefix and getPrevMessages for routing compaction

EOF
)"
```

---

### Task 3: 画像 JSON + `fetchModelPortraits`

**Files:**
- Create: `server/src/llm/modelPortraits.registry.json`
- Create: `server/src/llm/modelPortraits.js`
- Test: `server/src/llm/modelPortraits.test.js`

**Interfaces:**
- Produces:
  - `canonicalModelId(raw: string) → string`：去掉 `anthropic.`；若含 `/` 则取第一段之后（`google/gemini-x` → `gemini-x`），否则原串 trim
  - `fetchModelPortraits({ registryPath } = {}) → { registry_version, offerings: Offering[] }`
  - `findOfferings(portraits, { modelId, providerId? }) → Offering[]`
- Offering 字段对齐 schema：`provider_id`, `endpoint_id`, `model_id`, `canonical_model_id`, `price_currency`, `global_pricing: { prompt, completion, cache_read, cache_write, reasoning }`

- [ ] **Step 1: 最小合法 registry 夹具写进仓库**

若能 clone llm-providers 并 `cargo run -- export --format pararouter`，用全文覆盖 `modelPortraits.registry.json`。否则先提交 schema 合法最小文件（测试用），生产替换全文：

```json
{
  "registry_version": "fixture",
  "registry_updated_at": "2026-09-16T00:00:00Z",
  "catalog": [],
  "offerings": [
    {
      "provider_id": "deepseek",
      "endpoint_id": "main",
      "model_id": "deepseek-chat",
      "canonical_model_id": "deepseek-chat",
      "price_currency": "CNY",
      "region": "cn",
      "base_url": "https://api.deepseek.com",
      "global_pricing": { "prompt": 2, "completion": 8, "cache_read": 0.2, "cache_write": null, "reasoning": null },
      "supports_tools": true,
      "supports_vision": false,
      "supports_reasoning": false
    },
    {
      "provider_id": "deepseek",
      "endpoint_id": "main",
      "model_id": "deepseek-reasoner",
      "canonical_model_id": "deepseek-reasoner",
      "price_currency": "CNY",
      "region": "cn",
      "base_url": "https://api.deepseek.com",
      "global_pricing": { "prompt": 4, "completion": 16, "cache_read": null, "cache_write": null, "reasoning": null },
      "supports_tools": true,
      "supports_vision": false,
      "supports_reasoning": true
    }
  ]
}
```

- [ ] **Step 2: 写失败测试**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { canonicalModelId, fetchModelPortraits, findOfferings } = require('./modelPortraits');

test('canonicalModelId strips anthropic. and aggregator prefix', () => {
    assert.equal(canonicalModelId('anthropic.deepseek/deepseek-chat'), 'deepseek-chat');
    assert.equal(canonicalModelId('google/gemini-3.5-flash'), 'gemini-3.5-flash');
    assert.equal(canonicalModelId('deepseek-chat'), 'deepseek-chat');
});

test('fetchModelPortraits reads JSON and findOfferings matches canonical id', () => {
    const portraits = fetchModelPortraits({
        registryPath: path.join(__dirname, 'modelPortraits.registry.json'),
    });
    const hits = findOfferings(portraits, { modelId: 'deepseek-chat' });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].canonical_model_id, 'deepseek-chat');
    assert.equal(typeof hits[0].global_pricing.prompt, 'number');
});
```

- [ ] **Step 3: 实现 `modelPortraits.js`**

```js
const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTRY = path.join(__dirname, 'modelPortraits.registry.json');

function canonicalModelId(raw) {
    let s = String(raw || '').trim();
    if (s.startsWith('anthropic.')) s = s.slice('anthropic.'.length);
    const slash = s.indexOf('/');
    if (slash > 0) s = s.slice(slash + 1);
    return s.trim();
}

function fetchModelPortraits({ registryPath } = {}) {
    const p = registryPath || DEFAULT_REGISTRY;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { registry_version: parsed.registry_version, offerings: parsed.offerings || [] };
}

function findOfferings(portraits, { modelId, providerId } = {}) {
    const canon = canonicalModelId(modelId);
    return (portraits.offerings || []).filter((o) => {
        const idOk = o.canonical_model_id === canon || o.model_id === canon || canonicalModelId(o.model_id) === canon;
        const provOk = !providerId || o.provider_id === providerId;
        return idOk && provOk;
    });
}

module.exports = { canonicalModelId, fetchModelPortraits, findOfferings, DEFAULT_REGISTRY };
```

- [ ] **Step 4: Run**

`cd server && node --test src/llm/modelPortraits.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/llm/modelPortraits.js server/src/llm/modelPortraits.test.js server/src/llm/modelPortraits.registry.json
git commit -m "$(cat <<'EOF'
feat(llm): load model portraits from llm-providers export JSON

EOF
)"
```

---

### Task 4: 成本原语

**Files:**
- Create: `server/src/llm/router/pricing.js`
- Test: `server/src/llm/router/pricing.test.js`

**Interfaces:**
- Consumes: `global_pricing` 对象
- Produces:
  - `toUnitPrice(global_pricing) → { inputPer1m, outputPer1m, cacheReadPer1m, cacheWritePer1m }` 缺省轴为 `null`
  - `isPriced(unit) → boolean`：任一轴 `!= null`（含 `0`）
  - `calculateCost(unit, { promptTokens, completionTokens, cacheHitTokens, cacheZero }) → number | null`：`!isPriced` 返回 `null`；`cacheZero` 时 hits=0；无 `cacheReadPer1m` 且 hits>0 时 cache 价 = input * 0.1

- [ ] **Step 1: 测试**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toUnitPrice, isPriced, calculateCost } = require('./pricing');

test('unpriced is not cheapest', () => {
    const u = toUnitPrice({ prompt: null, completion: null, cache_read: null, cache_write: null, reasoning: null });
    assert.equal(isPriced(u), false);
    assert.equal(calculateCost(u, { promptTokens: 1000, completionTokens: 10, cacheHitTokens: 0 }), null);
});

test('explicit zero is priced and free', () => {
    const u = toUnitPrice({ prompt: 0, completion: 0, cache_read: null, cache_write: null, reasoning: null });
    assert.equal(isPriced(u), true);
    assert.equal(calculateCost(u, { promptTokens: 1e6, completionTokens: 1e6, cacheHitTokens: 0 }), 0);
});

test('cache hit uses 10% default when cache_read missing', () => {
    const u = toUnitPrice({ prompt: 1, completion: 2, cache_read: null, cache_write: null, reasoning: null });
    const cost = calculateCost(u, { promptTokens: 1e6, completionTokens: 1e5, cacheHitTokens: 5e5 });
    assert.ok(Math.abs(cost - 0.75) < 1e-6);
});

test('compaction zeros cache hits', () => {
    const u = toUnitPrice({ prompt: 1, completion: 0, cache_read: 0.02, cache_write: null, reasoning: null });
    const cost = calculateCost(u, { promptTokens: 1e6, completionTokens: 0, cacheHitTokens: 9e5, cacheZero: true });
    assert.equal(cost, 1);
});
```

- [ ] **Step 2: 实现 `pricing.js`**（公式与 SmartGate `calculate_cost` 相同：miss * input + hit * cache + completion * output，单位 1M）

- [ ] **Step 3: Run** `cd server && node --test src/llm/router/pricing.test.js`

- [ ] **Step 4: Commit** `feat(llm): add cache-aware unit cost helpers`

---

### Task 5: `evaluateDifficulty` stub

**Files:**
- Create: `server/src/llm/router/evaluateDifficulty.js`
- Test: `server/src/llm/router/evaluateDifficulty.test.js`

**Interfaces:**
- Produces: `async function evaluateDifficulty(signals) → null`

- [ ] **Step 1–3: 测试断言 `await evaluateDifficulty({}) === null`，实现恒 `return null`**
- [ ] **Step 4: Commit** `feat(llm): stub evaluateDifficulty returning null`

---

### Task 6: 信号与逻辑模型

**Files:**
- Create: `server/src/llm/router/signals.js`
- Test: `server/src/llm/router/signals.test.js`

**Interfaces:**
- Consumes: `trajectory.getPrevMessages`, `trajectory.samePrefix`, `canonicalModelId`
- Produces:
  - `logicalModelFromBody(body, { tokenModel, agentPrimaryModel }) → string`
  - `inferCompacted(sessionId, messages) → boolean`
  - `collectSignals({ sessionId, body, tokenModel, agentPrimaryModel, lastUsage }) → { sessionId, logicalModel, msgCount, promptChars, prefixMsgCount, compacted, lastCachedTokens, lastPromptTokens }`

规则：
- `logicalModelFromBody`：`canonicalModelId(body.model)`，空则 `tokenModel`，再空则 `agentPrimaryModel`，再空则 `''`
- `inferCompacted`：`prev = getPrevMessages(sessionId)`；无 prev → `false`；有 prev 且非（更长且 `samePrefix`）→ `true`

- [ ] **Step 1: 测试**

```js
test('logicalModelFromBody prefers request model over session default', () => {
    const { logicalModelFromBody } = require('./signals');
    assert.equal(logicalModelFromBody(
        { model: 'anthropic.acme/deepseek-chat' },
        { tokenModel: 'other/other', agentPrimaryModel: 'primary' },
    ), 'deepseek-chat');
});

test('inferCompacted false on first turn', () => {
    const { inferCompacted } = require('./signals');
    assert.equal(inferCompacted('no-such-session', [{ role: 'user', content: 'hi' }]), false);
});
```

压缩 true 的测试：先 `trajectory.recordRequest` 写入 prev，再改写 messages 调 `inferCompacted`。

- [ ] **Step 2: 实现 `signals.js`**
- [ ] **Step 3: Run tests PASS**
- [ ] **Step 4: Commit** `feat(llm): collect routing signals and body logical model`

---

### Task 7: 粘性 PG

**Files:**
- Create: `server/src/llm/router/sticky.js`
- Test: `server/src/llm/router/sticky.test.js`（`const { bootstrapTestDb } = require('../../test/db')`，与 `proxyModels.test.js` 相同：`ctx = await bootstrapTestDb([], __dirname)`）

**Interfaces:**
- `STICKY_TTL_MS = 10 * 60 * 1000`
- `FAIL_THRESHOLD = 2`
- `async getSticky(sessionId) → { chosenModel, chosenProvider, failCount, expiresAt } | null`（过期当 null）
- `async touchSticky(sessionId, { chosenModel, chosenProvider })`：upsert，`failCount=0`，`expiresAt=now+TTL`
- `async recordStickyFailure(sessionId) → { failCount, released }`：无行则 noop；有行 `failCount++`，≥2 则 delete 且 `released: true`

- [ ] **Step 1: 写 sticky.test.js**

`before` 里 `ctx = await bootstrapTestDb([], __dirname)`，插入一条 `sessions` 行（`id: 'sess_sticky'`，`status: 'running'`，user/project 用 seed 用户）。断言：`getSticky` 无行 → null；`touchSticky` 后能读到 model/provider；把 `expiresAt` 改到过去后再 get → null；`recordStickyFailure` 两次后行消失且 `released: true`。

- [ ] **Step 2: 实现 sticky.js（只用 drizzle + `schema.sessionRouteSticky`）**
- [ ] **Step 3: `cd server && node --test src/llm/router/sticky.test.js`**
- [ ] **Step 4: Commit** `feat(llm): persist session route sticky in postgres`

---

### Task 8: 触发器

**Files:**
- Create: `server/src/llm/router/triggers.js`
- Test: `server/src/llm/router/triggers.test.js`

**Interfaces:**
- `resolveTrigger({ sticky, compacted, stickyReleasedByFailures }) → { trigger, reevaluate }`
  - 无 sticky → `{ trigger: 'first_turn', reevaluate: true }`
  - compacted → `{ trigger: 'compaction', reevaluate: true }`
  - stickyReleasedByFailures 或 `sticky.failCount >= 2` → `{ trigger: 'provider_fail', reevaluate: true }`
  - 否则 `{ trigger: 'sticky', reevaluate: false }`
- 永不返回 `semantic_shift`（v1）

- [ ] **Step 1–4: 四个分支各一条 assert + 实现 + commit** `feat(llm): resolve when to reevaluate routes`

---

### Task 9: 优化器

**Files:**
- Create: `server/src/llm/router/optimizer.js`
- Test: `server/src/llm/router/optimizer.test.js`

**Interfaces:**
- Consumes: `findOfferings`, `calculateCost`, `isPriced`, `canonicalModelId`
- `resolveProviderRoute({ portraits, logicalModel, boundProviderIds: string[], cacheHitTokens, promptTokens, completionTokensGuess = 0, cacheZero, demand }) → Candidate[]`
  - `demand != null` 时 **v1 仍忽略**（评估器未实现）；注释写明以后在此做能力门槛
  - 候选 = `findOfferings(portraits, { modelId: logicalModel })`
  - 每条：`bound = boundProviderIds.includes(provider_id)`；`cost_estimate = calculateCost(...)`；`skip_reason = bound ? null : 'provider_not_bound'`
  - 排序：有价且 bound 按 cost 升序；无价排后面；未 bound 再后面
- `chooseRoute(candidates, { sticky, reevaluate }) → { chosenModel, chosenProvider, candidates }`
  - `!reevaluate && sticky` → 沿用 sticky（即使不在候选第一）
  - 否则取第一个 `bound && (isPriced || 没有有价 bound)` 的候选；没有任何 bound 则 `chosenProvider=''` 且 chosenModel 仍为逻辑模型（执行层不得捏造 provider）

- [ ] **Step 1: 测试**
  - 两家 offering 同模型，只 bound 一家 → chosen 是 bound 那家，另一家 `skip_reason=provider_not_bound`
  - unknown 价不能排到有价 bound 前面
  - `demand=null` 时不会换成 offerings 里另一个 `canonical_model_id`
  - `reevaluate=false` 复用 sticky provider

- [ ] **Step 2: 实现**
- [ ] **Step 3: 跑测 PASS**
- [ ] **Step 4: Commit** `feat(llm): rank bound providers by cache-aware cost`

---

### Task 10: 决策落库

**Files:**
- Create: `server/src/llm/router/decisions.js`
- Test: `server/src/llm/router/decisions.test.js`

**Interfaces:**
- `async insertDecision(row)`：`row.seq` 调用方传入（trajectory seq）；`demand` 恒 `null`
- `async patchDecisionUsage({ sessionId, seq, promptTokens, cachedTokens, completionTokens, latencyMs, statusCode, error })`

- [ ] **Step 1: 测试 insert + patch 同一 `(sessionId, seq)`**
- [ ] **Step 2: 实现**
- [ ] **Step 3: Commit** `feat(llm): persist routing_decisions rows`

---

### Task 11: 执行改写 + `planRoute` 编排

**Files:**
- Create: `server/src/llm/router/execute.js`
- Create: `server/src/llm/router/index.js`
- Test: `server/src/llm/router/execute.test.js`、`server/src/llm/router/index.test.js`（index 可用内存/桩：mock sticky/db）

**Interfaces:**
- `applyChosenModel(parsedBody, { chosenProvider, chosenModel }) → parsedBody`：若 `chosenProvider` 非空，`model = `${chosenProvider}/${chosenModel}``（chosenModel 已是 canonical）；provider 空则 `model = chosenModel`
- `async planRoute({ claims, body, lastUsage, boundProviderIds, portraits })` 顺序：
  1. `signals = collectSignals(...)`（**必须在 trajectory.recordRequest 之前**由 proxy 调用 collect，或 planRoute 内只读 prev）
  2. `demand = await evaluateDifficulty(signals)`
  3. `sticky = await getSticky(claims.sid)`
  4. `trig = resolveTrigger({ sticky, compacted: signals.compacted, stickyReleasedByFailures: sticky && sticky.failCount >= 2 })`
  5. 逻辑模型：`demand == null` 则 `signals.logicalModel`（已来自 body）
  6. `candidates = resolveProviderRoute(...)`；`cacheZero = trig.trigger === 'compaction'`
  7. `chosen = chooseRoute(candidates, trig)`
  8. 返回 `{ signals, demand, trig, chosen, candidates }` 供 proxy 写决策、改 body、成功则 `touchSticky`、失败则 `recordStickyFailure`

- [ ] **Step 1: execute 测试** `applyChosenModel({ model: 'x' }, { chosenProvider: 'deepseek', chosenModel: 'deepseek-chat' }).model === 'deepseek/deepseek-chat'`
- [ ] **Step 2: index 测试** demand null 时 chosenModel 等于 body 的 canonical，不等于 claims.model
- [ ] **Step 3: 实现**
- [ ] **Step 4: Commit** `feat(llm): planRoute orchestrates sticky cost routing`

---

### Task 12: 接入 `proxy.js`

**Files:**
- Modify: `server/src/llm/proxy.js`（`proxyLlmRequest` 中解析 body 之后、`trajectory.recordRequest` 之前插入 planRoute；`forwardToGateway` 使用改写后的 body；`onResponseBody` / 错误分支 patchDecision + sticky）
- Test: 扩展 `server/src/llm/proxyModels.test.js` 或新 `server/src/llm/proxy.routing.test.js`（照 `proxyModels.test.js` 起 fake gateway：断言转发 body.model 带 bound provider 前缀；null evaluator 不改成 session 默认）

**顺序（硬约束）：**

1. parse JSON body  
2. `planRoute`（此时 prev 仍是上一轮）  
3. `applyChosenModel` 写回 `request.body` Buffer  
4. opencode alias 改写（若 aid===opencode，**在 applyChosenModel 之后**）  
5. `trajSeq = await trajectory.recordRequest(...)`  
6. `insertDecision({ ..., seq: trajSeq, trigger, chosen_*, candidates, demand: null })`  
7. `forwardToGateway`  
8. 成功 2xx：`touchSticky` + `patchDecisionUsage`（含 extractUsage 的 cachedTokens）  
9. 失败：`recordStickyFailure` + `patchDecisionUsage` error  

- [ ] **Step 1: 写 proxy.routing 测试**（无 token 仍 401；有效 session 转发的 model 为 `boundProvider/canonical`）
- [ ] **Step 2: 改 proxy.js 最小编排，不要把优化器逻辑内联进 proxy**
- [ ] **Step 3: `cd server && node --test src/llm/proxy.routing.test.js src/llm/proxyModels.test.js`**
- [ ] **Step 4: Commit** `feat(llm): apply intelligent routing on llm proxy chat path`

---

### Task 13: 文档

**Files:**
- Modify: `docs/LlmProxy.md` 增加一小节「智能路由（v1）」：四层在控制面、画像来自仓库 JSON、评估器 stub、压缩为前缀推断、决策表名。不重复全文 spec。

- [ ] **Step 1: 写 15–25 行**
- [ ] **Step 2: Commit** `docs: describe llm proxy intelligent routing v1`

---

## Spec coverage（自检）

| Spec | Task |
|------|------|
| §5 信号 / §5.1 压缩推断 | 2, 6 |
| §6 粘性 TTL 10min N=2 | 7 |
| §7 触发器 | 8 |
| §8 评估器 null + body model | 5, 6, 11 |
| §9 成本 / bound / unknown | 4, 9 |
| §10 执行改写 + opencode 之后 | 11, 12 |
| §11 静态 JSON | 3 |
| §12–13 表 | 1, 10 |
| §14 测试要点 | 各 task 测试 |
| 无 Redis | 7 用 PG |
| package.json glob | 1 |

不在本计划：评估器实现、Session UI、多 provider binding、运行时 HTTP 画像、Admin KPI 页。
