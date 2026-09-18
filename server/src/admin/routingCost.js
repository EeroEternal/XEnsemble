/**
 * 智能路由成本/节省估算（共享单一实现）。
 *
 * 数据源：llm_usage 事实表按 (user_id, agent_id, requested_model, model) 聚合。
 * 路由分析页（用户自助 /api/v1/routing/me）与管理用量统计（/api/v1/admin/usage/*）
 * 共用本模块，避免两处各写一套过滤逻辑导致口径漂移。
 *
 * 口径：
 * - 成本 = 模型目录 USD 单价（input/output/cache_read per 1M）× token 数；目录外/无价不计入。
 * - 总花费 = 所有「路由观测到」的行（trigger 非空、requested_model 非空）的 chosen 成本之和。
 * - 节省 = Σ(requested 成本 − chosen 成本)，需同时满足：
 *     1. requested 与 chosen 的 canonical id 不同（仅 provider 前缀差异不算换模型）；
 *     2. requested 属于该 Agent 网关当前绑定的模型——排除用户选的网关外模型（如
 *        claude-sonnet-5），以及网关配置变更后存量会话残留的旧 provider/model；
 *     3. 两侧均有价。
 * - 不按 trigger 排除 sticky：sticky 沿用上次选择，但若其 chosen 与 requested 不同，
 *   省下的钱是真实的，应计入节省。sticky 只从「分析请求数/难度分布」里排除。
 * - 改写数（rewrites）与升档数（upgrades）属「分析」口径：rewrites 排除 sticky，
 *   与 requests 分母一致；upgrades 统计被路由改写到更贵模型（能力门槛强制升档）的次数。
 *
 * 注：Agent 网关模型取「当前」配置。历史配置无留存，跨越配置变更的窗口只能按现状判定。
 */

const { and, eq, gte, isNotNull, sql } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { fetchModelCatalog, lookupCatalog, usdEstimateFromEntry } = require('../llm/modelCatalog');
const { canonicalModelId } = require('../llm/modelPortraits');
const agentGatewayConfig = require('./AgentGatewayConfig');

const DAY_MS = 24 * 60 * 60 * 1000;
const STICKY_TRIGGER = 'sticky';

function normalizeRange(days) {
    const parsed = Number(days);
    const d = [7, 30, 90].includes(parsed) ? parsed : 30;
    return { days: d, sinceTs: Date.now() - d * DAY_MS };
}

function usdCost(unit, tokens) {
    if (!unit) return null;
    return (Number(tokens.prompt) / 1e6) * (unit.input ?? 0)
        + (Number(tokens.completion) / 1e6) * (unit.output ?? 0)
        + (Number(tokens.cached) / 1e6) * (unit.cache_read ?? 0);
}

/** 模型 → 目录 USD 单价（带缓存）；供调用方复用同一套定价解析。 */
function makeUnitResolver(catalog) {
    const cache = new Map();
    return (model) => {
        if (!cache.has(model)) {
            cache.set(model, usdEstimateFromEntry(lookupCatalog(catalog, { model })));
        }
        return cache.get(model);
    };
}

/** Agent → 该 Agent 网关绑定模型的 canonical 集合；无配置/查询失败时为 null（视为不可校验）。 */
function makeGatewayModelResolver() {
    const cache = new Map();
    return async (agentId) => {
        if (!agentId) return null;
        if (cache.has(agentId)) return cache.get(agentId);
        let set = null;
        try {
            const cfg = await agentGatewayConfig.getForAgent(agentId);
            const models = agentGatewayConfig.allModels(cfg);
            if (models.length > 0) set = new Set(models.map((m) => canonicalModelId(m)));
        } catch {
            set = null;
        }
        cache.set(agentId, set);
        return set;
    };
}

/**
 * 按用户聚合路由成本与节省。
 * @param {{ days?: number|string, userId?: string }} opts userId 省略时返回全部用户
 * @returns {Promise<Map<string, { estSavingsUsd:number, savingsRequests:number, totalSpendUsd:number, spendRequests:number }>>}
 */
async function getRoutingCostByUser({ days, userId } = {}) {
    const { sinceTs } = normalizeRange(days);
    const catalog = fetchModelCatalog();
    const resolveAllowed = makeGatewayModelResolver();

    const conds = [
        gte(schema.llmUsage.createdAt, sinceTs),
        isNotNull(schema.llmUsage.trigger),
        isNotNull(schema.llmUsage.requestedModel),
        isNotNull(schema.llmUsage.model),
    ];
    if (userId) conds.push(eq(schema.llmUsage.userId, userId));

    const rows = await db
        .select({
            userId: schema.llmUsage.userId,
            agentId: schema.llmUsage.agentId,
            trigger: schema.llmUsage.trigger,
            requestedModel: schema.llmUsage.requestedModel,
            chosenModel: schema.llmUsage.model,
            prompt: sql`coalesce(sum(${schema.llmUsage.promptTokens}), 0)::bigint`,
            completion: sql`coalesce(sum(${schema.llmUsage.completionTokens}), 0)::bigint`,
            cached: sql`coalesce(sum(${schema.llmUsage.cachedTokens}), 0)::bigint`,
            n: sql`count(*)::int`,
        })
        .from(schema.llmUsage)
        .where(and(...conds))
        .groupBy(
            schema.llmUsage.userId,
            schema.llmUsage.agentId,
            schema.llmUsage.trigger,
            schema.llmUsage.requestedModel,
            schema.llmUsage.model,
        );

    const unitOf = makeUnitResolver(catalog);

    const byUser = new Map();
    for (const r of rows) {
        const tokens = { prompt: r.prompt, completion: r.completion, cached: r.cached };
        const chosenCost = usdCost(unitOf(r.chosenModel), tokens);
        const acc = byUser.get(r.userId)
            || {
                estSavingsUsd: 0,
                savingsRequests: 0,
                totalSpendUsd: 0,
                spendRequests: 0,
                rewrites: 0,
                upgrades: 0,
            };
        // 花费/节省是「钱」，含 sticky 行——sticky 复用上次选择省下的钱同样真实。
        if (chosenCost != null) {
            acc.totalSpendUsd += chosenCost;
            acc.spendRequests += 1;
        }
        const requestedCanon = canonicalModelId(r.requestedModel);
        const chosenCanon = canonicalModelId(r.chosenModel);
        // 仅 provider 前缀差异不算换模型（如 glm-5.3-flash → personal_glm/glm-5.3-flash）
        const isRewrite = requestedCanon && chosenCanon && requestedCanon !== chosenCanon;
        if (isRewrite) {
            // 必须是该 Agent 网关可服务的模型，才算路由的改写决策：
            // 排除用户选的网关外模型（claude-sonnet-5）与配置变更后的陈旧残留。
            const allowed = await resolveAllowed(r.agentId);
            if (allowed && allowed.has(requestedCanon)) {
                const requestedCost = usdCost(unitOf(r.requestedModel), tokens);
                if (requestedCost != null && chosenCost != null) {
                    acc.estSavingsUsd += requestedCost - chosenCost;
                    acc.savingsRequests += 1;
                    // 升档：选中模型比原请求更贵（能力门槛强制升档 / 原模型不合格被替换）
                    if (chosenCost > requestedCost) acc.upgrades += Number(r.n || 0);
                }
                // 改写率属「分析」口径，与 requests 分母一致，排除 sticky。
                if (r.trigger !== STICKY_TRIGGER) acc.rewrites += Number(r.n || 0);
            }
        }
        byUser.set(r.userId, acc);
    }
    return byUser;
}

module.exports = { getRoutingCostByUser, usdCost, makeUnitResolver };
