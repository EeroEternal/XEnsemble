/**
 * 智能路由统计服务（路由分析页）。
 *
 * 口径（含产品修正）：
 * - 「分析请求」= 发生了重评的请求：trigger <> 'sticky' 且 difficulty 非空
 *   （sticky 行沿用上次选择，不计入分析量；trigger 为空的行早于路由功能，不计）。
 * - 复杂度分桶：低 <0.35 / 中 0.35–0.55 / 高 ≥0.55（对齐 HARD_TASK_DIFFICULTY）。
 * - 档位（价格档）：按模型目录 USD 输出单价判定，达目录最高输出单价 50% 记 pro，
 *   其余记 flash；目录外/无价的模型不计入档位计数。
 * - 节省/花费：复用 routingCost 共享实现（含 sticky 行、网关绑定校验），与 Admin
 *   用量统计同一口径。注意「节省」不按 trigger 排除 sticky——sticky 沿用上次选择，
 *   若其 chosen 与 requested 不同，省下的钱是真实的；sticky 只从「分析请求」口径排除。
 */

const { and, eq, gte, isNotNull, ne, sql } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { fetchModelCatalog, usdEstimateFromEntry, findCatalogEntries } = require('../llm/modelCatalog');
const { HARD_TASK_DIFFICULTY } = require('../llm/router/evaluateDifficulty');
const { getRoutingCostByUser } = require('./routingCost');

const DAY_MS = 24 * 60 * 60 * 1000;
const STICKY_TRIGGER = 'sticky';
const MID_BOUNDARY = 0.35;
const TOP_TIER_PRICE_RATIO = 0.5;

function normalizeRange(days) {
    const parsed = Number(days);
    const d = [7, 30, 90].includes(parsed) ? parsed : 30;
    return { days: d, sinceTs: Date.now() - d * DAY_MS };
}

/** 模型 → 价格档分类器（pro/flash）：按目录 USD 输出单价，达目录最高输出单价
 * 50% 记 pro，其余 flash。匹配必须走 findCatalogEntries 的 family/canonical 模糊
 * 匹配——llm_usage.model 是路由后带 provider 前缀的完整串，与目录裸模型名精确比对
 * 永远 miss。目录外/无输出单价的模型返回 null，不计入档位计数。 */
function buildTierClassifier(catalog) {
    const entries = catalog?.entries || [];
    const outputs = entries
        .map((e) => Number(usdEstimateFromEntry(e)?.output))
        .filter((n) => Number.isFinite(n));
    const maxOutput = outputs.length ? Math.max(...outputs) : 0;
    const threshold = maxOutput * TOP_TIER_PRICE_RATIO;
    const cache = new Map();
    return (model) => {
        if (cache.has(model)) return cache.get(model);
        const matched = findCatalogEntries(catalog, { model });
        const matchedOutputs = matched
            .map((e) => Number(usdEstimateFromEntry(e)?.output))
            .filter((n) => Number.isFinite(n));
        const tier = matchedOutputs.length
            ? (Math.max(...matchedOutputs) >= threshold ? 'pro' : 'flash')
            : null;
        cache.set(model, tier);
        return tier;
    };
}

/**
 * 个人路由总览（self 过滤）。
 * @returns {Promise<{summary, difficultyBuckets, tierRouting, triggerStats, days}>}
 */
async function getMyRoutingOverview(userId, { days } = {}) {
    const { days: d, sinceTs } = normalizeRange(days);
    const tierOf = buildTierClassifier(fetchModelCatalog());
    const analyzed = [
        eq(schema.llmUsage.userId, userId),
        gte(schema.llmUsage.createdAt, sinceTs),
        isNotNull(schema.llmUsage.trigger),
        ne(schema.llmUsage.trigger, STICKY_TRIGGER),
        isNotNull(schema.llmUsage.difficulty),
    ];

    const [summaryRows, tierRows, triggerRows, costByUser] = await Promise.all([
        db
            .select({
                requests: sql`count(*)::int`,
                avgDifficulty: sql`avg(${schema.llmUsage.difficulty})`,
                high: sql`sum(case when ${schema.llmUsage.difficulty} >= ${HARD_TASK_DIFFICULTY} then 1 else 0 end)::int`,
                mid: sql`sum(case when ${schema.llmUsage.difficulty} >= ${MID_BOUNDARY} and ${schema.llmUsage.difficulty} < ${HARD_TASK_DIFFICULTY} then 1 else 0 end)::int`,
                low: sql`sum(case when ${schema.llmUsage.difficulty} < ${MID_BOUNDARY} then 1 else 0 end)::int`,
            })
            .from(schema.llmUsage)
            .where(and(...analyzed)),
        db
            .select({ model: schema.llmUsage.model, n: sql`count(*)::int` })
            .from(schema.llmUsage)
            .where(and(...analyzed))
            .groupBy(schema.llmUsage.model),
        db
            .select({ trigger: schema.llmUsage.trigger, n: sql`count(*)::int` })
            .from(schema.llmUsage)
            .where(and(
                eq(schema.llmUsage.userId, userId),
                gte(schema.llmUsage.createdAt, sinceTs),
                isNotNull(schema.llmUsage.trigger),
            ))
            .groupBy(schema.llmUsage.trigger),
        // 成本/节省/改写/升档与 Admin 用量页共用同一实现（含 sticky 处理、网关校验）。
        getRoutingCostByUser({ days: d, userId }),
    ]);

    const r = summaryRows[0] || {};
    const requests = Number(r.requests || 0);
    const high = Number(r.high || 0);
    const mid = Number(r.mid || 0);
    const low = Number(r.low || 0);

    let tierPro = 0;
    let tierFlash = 0;
    for (const row of tierRows) {
        const tier = tierOf(row.model);
        if (tier === 'pro') tierPro += Number(row.n);
        else if (tier === 'flash') tierFlash += Number(row.n);
    }

    const cost = costByUser.get(userId)
        || { estSavingsUsd: 0, savingsRequests: 0, totalSpendUsd: 0, spendRequests: 0, rewrites: 0, upgrades: 0 };
    const rewrites = cost.rewrites;

    const share = (n) => (requests > 0 ? Number((n / requests).toFixed(4)) : 0);
    return {
        summary: {
            requests,
            avgDifficulty: r.avgDifficulty == null ? null : Number(Number(r.avgDifficulty).toFixed(4)),
            highDifficultyShare: share(high),
            estSavingsUsd: Number(cost.estSavingsUsd.toFixed(4)),
            totalSpendUsd: Number(cost.totalSpendUsd.toFixed(4)),
            rewrites,
            rewriteRate: share(rewrites),
            upgrades: cost.upgrades,
        },
        difficultyBuckets: { high, mid, low },
        tierRouting: { pro: tierPro, flash: tierFlash },
        triggerStats: {
            first_turn: 0,
            sticky: 0,
            compaction: 0,
            provider_fail: 0,
            ...Object.fromEntries(triggerRows.map((x) => [x.trigger, Number(x.n)])),
        },
        days: d,
    };
}

module.exports = { getMyRoutingOverview };
