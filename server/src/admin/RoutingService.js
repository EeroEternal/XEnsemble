/**
 * 智能路由统计服务（路由分析页）。
 *
 * 口径（含产品修正）：
 * - 「分析请求」= 发生了重评的请求：trigger <> 'sticky' 且 difficulty 非空
 *   （sticky 行沿用上次选择，不计入分析量；trigger 为空的行早于路由功能，不计）。
 * - 复杂度分桶：低 <0.35 / 中 0.35–0.55 / 高 ≥0.55（对齐 HARD_TASK_DIFFICULTY）。
 * - 档位：按模型目录 capability 判定，目录池顶带（max − 0.04）为 pro，其余 flash；
 *   目录外/无 capability 的模型不计入档位计数（与优化器判定同源）。
 * - 节省/花费：模型目录 USD 单价（input/output/cache_read per 1M）token 加权估算；
 *   任一侧无价不计入。requested == chosen 的行只进花费，不进节省。
 */

const { and, eq, gte, isNotNull, ne, sql } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { fetchModelCatalog, lookupCatalog, usdEstimateFromEntry } = require('../llm/modelCatalog');
const { HARD_TASK_DIFFICULTY } = require('../llm/router/evaluateDifficulty');

const DAY_MS = 24 * 60 * 60 * 1000;
const STICKY_TRIGGER = 'sticky';
const MID_BOUNDARY = 0.35;
const TOP_TIER_TOLERANCE = 0.04;

function normalizeRange(days) {
    const parsed = Number(days);
    const d = [7, 30, 90].includes(parsed) ? parsed : 30;
    return { days: d, sinceTs: Date.now() - d * DAY_MS };
}

/** 模型 → 档位（pro/flash）：目录池顶带为 pro（与优化器硬门槛同一判定） */
function buildTierMap(catalog) {
    const entries = catalog?.entries || [];
    const caps = entries.map((e) => Number(e.capability)).filter((n) => Number.isFinite(n));
    const maxCap = caps.length ? Math.max(...caps) : 1;
    const map = new Map();
    for (const e of entries) {
        const cap = Number(e.capability);
        if (!Number.isFinite(cap)) continue;
        map.set(e.model, cap >= maxCap - TOP_TIER_TOLERANCE ? 'pro' : 'flash');
    }
    return map;
}

function usdCost(unit, tokens) {
    if (!unit) return null;
    return (Number(tokens.prompt) / 1e6) * (unit.input ?? 0)
        + (Number(tokens.completion) / 1e6) * (unit.output ?? 0)
        + (Number(tokens.cached) / 1e6) * (unit.cache_read ?? 0);
}

/**
 * 个人路由总览（self 过滤）。
 * @returns {Promise<{summary, difficultyBuckets, tierRouting, triggerStats, days}>}
 */
async function getMyRoutingOverview(userId, { days } = {}) {
    const { days: d, sinceTs } = normalizeRange(days);
    const tierMap = buildTierMap(fetchModelCatalog());
    const analyzed = [
        eq(schema.llmUsage.userId, userId),
        gte(schema.llmUsage.createdAt, sinceTs),
        isNotNull(schema.llmUsage.trigger),
        ne(schema.llmUsage.trigger, STICKY_TRIGGER),
        isNotNull(schema.llmUsage.difficulty),
    ];

    const [summaryRows, tierRows, triggerRows, modelPairs] = await Promise.all([
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
        db
            .select({
                requestedModel: schema.llmUsage.requestedModel,
                chosenModel: schema.llmUsage.model,
                prompt: sql`coalesce(sum(${schema.llmUsage.promptTokens}), 0)::bigint`,
                completion: sql`coalesce(sum(${schema.llmUsage.completionTokens}), 0)::bigint`,
                cached: sql`coalesce(sum(${schema.llmUsage.cachedTokens}), 0)::bigint`,
            })
            .from(schema.llmUsage)
            .where(and(
                eq(schema.llmUsage.userId, userId),
                gte(schema.llmUsage.createdAt, sinceTs),
                isNotNull(schema.llmUsage.trigger),
                ne(schema.llmUsage.trigger, STICKY_TRIGGER),
                isNotNull(schema.llmUsage.requestedModel),
            ))
            .groupBy(schema.llmUsage.requestedModel, schema.llmUsage.model),
    ]);

    const unitCache = new Map();
    const unitOf = (model) => {
        if (!unitCache.has(model)) {
            unitCache.set(model, usdEstimateFromEntry(lookupCatalog(fetchModelCatalog(), { model })));
        }
        return unitCache.get(model);
    };

    const r = summaryRows[0] || {};
    const requests = Number(r.requests || 0);
    const high = Number(r.high || 0);
    const mid = Number(r.mid || 0);
    const low = Number(r.low || 0);

    let tierPro = 0;
    let tierFlash = 0;
    for (const row of tierRows) {
        const tier = tierMap.get(row.model);
        if (tier === 'pro') tierPro += Number(row.n);
        else if (tier === 'flash') tierFlash += Number(row.n);
    }

    let estSavingsUsd = 0;
    let totalSpendUsd = 0;
    for (const row of modelPairs) {
        const tokens = { prompt: row.prompt, completion: row.completion, cached: row.cached };
        const chosen = usdCost(unitOf(row.chosenModel), tokens);
        if (chosen != null) totalSpendUsd += chosen;
        if (row.requestedModel !== row.chosenModel) {
            const requested = usdCost(unitOf(row.requestedModel), tokens);
            if (requested != null && chosen != null) estSavingsUsd += requested - chosen;
        }
    }

    const share = (n) => (requests > 0 ? Number((n / requests).toFixed(4)) : 0);
    return {
        summary: {
            requests,
            avgDifficulty: r.avgDifficulty == null ? null : Number(Number(r.avgDifficulty).toFixed(4)),
            highDifficultyShare: share(high),
            estSavingsUsd: Number(estSavingsUsd.toFixed(4)),
            totalSpendUsd: Number(totalSpendUsd.toFixed(4)),
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
