/**
 * Token 用量聚合服务（UsageService）
 *
 * 数据源：llm_usage 事实表（llm/proxy.js 落库，每成功请求一行）。
 * 查询时聚合（无 Redis、无预聚合表），按天/用户/项目/模型 GROUP BY。
 *
 * 用户自助接口（getMyUsage*）强制 userId 过滤；管理员接口见 getUserUsageDetail 等。
 */

const { and, eq, gte, isNotNull, lt, ne, sql } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
// 费用趋势按目录 USD 单价估算
const { fetchModelCatalog, lookupCatalog, usdEstimateFromEntry } = require('../llm/modelCatalog');
// 路由成本/节省估算抽到 routingCost，供本服务与路由分析页共用一套口径
const { getRoutingCostByUser } = require('./routingCost');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 周期参数归一化：days ∈ {7, 30, 90}，默认 30。
 * @returns {{ days: number, sinceTs: number }}
 */
function normalizeRange(days) {
    const parsed = Number(days);
    const d = [7, 30, 90].includes(parsed) ? parsed : 30;
    return { days: d, sinceTs: Date.now() - d * DAY_MS };
}

/** 本地时区 YYYY-MM-DD（按天分桶用） */
function dayKey(ts) {
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}-${dd}`;
}

// ── 用户自助（强制 self）─────────────────────────────────────────────

/**
 * 本人用量汇总。
 * @returns {{ promptTokens:number, completionTokens:number, totalTokens:number, requests:number }}
 */
async function getMyUsageSummary(userId, { days } = {}) {
    const { sinceTs } = normalizeRange(days);
    const rows = await db
        .select({
            prompt: sql`coalesce(sum(${schema.llmUsage.promptTokens}), 0)::int`,
            completion: sql`coalesce(sum(${schema.llmUsage.completionTokens}), 0)::int`,
            total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int`,
            requests: sql`count(*)::int`,
        })
        .from(schema.llmUsage)
        .where(and(eq(schema.llmUsage.userId, userId), gte(schema.llmUsage.createdAt, sinceTs)));
    const r = rows[0] || {};
    return {
        promptTokens: Number(r.prompt || 0),
        completionTokens: Number(r.completion || 0),
        totalTokens: Number(r.total || 0),
        requests: Number(r.requests || 0),
    };
}

// 0043：内置 AI 用量归属展示。存量行 source 为 NULL（proxy 写入的 agent 会话流量），
// 查询统一 COALESCE(source, 'session')，前端无需感知历史空值。
function emptySourceBucket() {
    return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/**
 * 本人按流量性质分解：session（agent 会话流量）vs internal（内置 AI 功能）。
 * @returns {Promise<{ session:{requests:number,promptTokens:number,completionTokens:number,totalTokens:number}, internal:{requests:number,promptTokens:number,completionTokens:number,totalTokens:number} }>}
 */
async function getMyUsageBySource(userId, { days } = {}) {
    const { sinceTs } = normalizeRange(days);
    const sourceExpr = sql`coalesce(${schema.llmUsage.source}, 'session')`;
    const rows = await db
        .select({
            source: sourceExpr,
            requests: sql`count(*)::int`,
            prompt: sql`coalesce(sum(${schema.llmUsage.promptTokens}), 0)::int`,
            completion: sql`coalesce(sum(${schema.llmUsage.completionTokens}), 0)::int`,
            total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int`,
        })
        .from(schema.llmUsage)
        .where(and(eq(schema.llmUsage.userId, userId), gte(schema.llmUsage.createdAt, sinceTs)))
        .groupBy(sourceExpr);
    const out = { session: emptySourceBucket(), internal: emptySourceBucket() };
    for (const r of rows) {
        const key = r.source === 'internal' ? 'internal' : 'session';
        out[key] = {
            requests: Number(r.requests || 0),
            promptTokens: Number(r.prompt || 0),
            completionTokens: Number(r.completion || 0),
            totalTokens: Number(r.total || 0),
        };
    }
    return out;
}

/**
 * 本人内置 AI（source='internal'）按功能分解（session_title / deploy_verify / …）。
 * @returns {Promise<Array<{ feature:string, requests:number, promptTokens:number, completionTokens:number, totalTokens:number }>>}
 */
async function getMyInternalByFeature(userId, { days } = {}) {
    const { sinceTs } = normalizeRange(days);
    const rows = await db
        .select({
            feature: schema.llmUsage.feature,
            requests: sql`count(*)::int`,
            prompt: sql`coalesce(sum(${schema.llmUsage.promptTokens}), 0)::int`,
            completion: sql`coalesce(sum(${schema.llmUsage.completionTokens}), 0)::int`,
            total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int`,
        })
        .from(schema.llmUsage)
        .where(and(
            eq(schema.llmUsage.userId, userId),
            gte(schema.llmUsage.createdAt, sinceTs),
            eq(schema.llmUsage.source, 'internal'),
        ))
        .groupBy(schema.llmUsage.feature)
        .orderBy(sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0) desc`);
    return rows.map((r) => ({
        feature: r.feature ?? '(unknown)',
        requests: Number(r.requests || 0),
        promptTokens: Number(r.prompt || 0),
        completionTokens: Number(r.completion || 0),
        totalTokens: Number(r.total || 0),
    }));
}

/**
 * 本人按项目分解（含已删除项目，projectName 为 null 时由调用方兜底展示）。
 * 每项目附缓存命中率（分母只计上报了缓存信息的请求，与 getUsageByAgent 口径一致）。
 * @returns {Promise<Array<{ projectId:string|null, projectName:string|null, requests:number, promptTokens:number, completionTokens:number, totalTokens:number, cachedTokens:number, cacheHitRate:number|null }>>}
 */
async function getMyUsageByProject(userId, { days } = {}) {
    const { sinceTs } = normalizeRange(days);
    const rows = await db
        .select({
            projectId: schema.llmUsage.projectId,
            projectName: schema.projects.name,
            requests: sql`count(*)::int`,
            prompt: sql`coalesce(sum(${schema.llmUsage.promptTokens}), 0)::int`,
            completion: sql`coalesce(sum(${schema.llmUsage.completionTokens}), 0)::int`,
            cached: sql`coalesce(sum(${schema.llmUsage.cachedTokens}), 0)::int`,
            reportedPrompt: sql`coalesce(sum(case when ${schema.llmUsage.cachedTokens} is not null then ${schema.llmUsage.promptTokens} else 0 end), 0)::int`,
            total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int`,
        })
        .from(schema.llmUsage)
        .leftJoin(schema.projects, eq(schema.projects.id, schema.llmUsage.projectId))
        .where(and(eq(schema.llmUsage.userId, userId), gte(schema.llmUsage.createdAt, sinceTs)))
        .groupBy(schema.llmUsage.projectId, schema.projects.name)
        .orderBy(sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0) desc`);
    return rows.map((r) => {
        const promptTokens = Number(r.prompt || 0);
        const cachedTokens = Number(r.cached || 0);
        const reportedPrompt = Number(r.reportedPrompt || 0);
        return {
            projectId: r.projectId,
            projectName: r.projectName ?? null,
            requests: Number(r.requests || 0),
            promptTokens,
            completionTokens: Number(r.completion || 0),
            totalTokens: Number(r.total || 0),
            cachedTokens,
            cacheHitRate: reportedPrompt > 0 ? Number((cachedTokens / reportedPrompt).toFixed(4)) : null,
        };
    });
}

/**
 * 按模型+agent 分组的日桶行 → 按天聚合 tokens + 目录 USD 单价估算费用。
 * 未定价模型（目录无该 model）计 0，不影响其他模型。
 * 返回每日附 costByAgent：agent → 当日估算费用（USD），供费用日趋势按 agent 堆叠展示。
 */
function trendFromModelRows(rows, { days: d }) {
    const catalog = fetchModelCatalog();
    const unitCache = new Map();
    const unitOf = (model) => {
        const key = model ?? '';
        if (!unitCache.has(key)) unitCache.set(key, usdEstimateFromEntry(lookupCatalog(catalog, { model })));
        return unitCache.get(key);
    };
    const byBucket = new Map();
    for (const r of rows) {
        const bucket = Number(r.bucket);
        const prompt = Number(r.prompt || 0);
        const completion = Number(r.completion || 0);
        const cached = Number(r.cached || 0);
        const acc = byBucket.get(bucket) || { prompt: 0, completion: 0, total: 0, requests: 0, costUsd: 0, costByAgent: {} };
        acc.prompt += prompt;
        acc.completion += completion;
        acc.total += Number(r.total || 0);
        acc.requests += Number(r.requests || 0);
        const unit = unitOf(r.model);
        if (unit) {
            const cost = (prompt / 1e6) * (unit.input ?? 0)
                + (completion / 1e6) * (unit.output ?? 0)
                + (cached / 1e6) * (unit.cache_read ?? 0);
            acc.costUsd += cost;
            // agent 维度费用拆分（agentId 为 null 的历史行归入 (unknown)，与 getUsageByAgent 口径一致）
            const agentKey = r.agent ?? '(unknown)';
            acc.costByAgent[agentKey] = (acc.costByAgent[agentKey] || 0) + cost;
        }
        byBucket.set(bucket, acc);
    }
    const todayStart = Math.floor(Date.now() / DAY_MS);
    const out = [];
    for (let i = d - 1; i >= 0; i--) {
        const bucket = todayStart - i;
        const r = byBucket.get(bucket);
        out.push({
            day: dayKey(bucket * DAY_MS),
            promptTokens: Number(r?.prompt || 0),
            completionTokens: Number(r?.completion || 0),
            totalTokens: Number(r?.total || 0),
            requests: Number(r?.requests || 0),
            costUsd: Number((r?.costUsd || 0).toFixed(4)),
            costByAgent: Object.fromEntries(
                Object.entries(r?.costByAgent || {}).map(([k, v]) => [k, Number(v.toFixed(4))]),
            ),
        });
    }
    return out;
}

/**
 * 本人按天趋势（补齐无数据日为 0，便于前端直接画图）。含目录单价估算的 USD 费用
 * （costUsd 总量 + costByAgent 按 agent 拆分）。
 * @returns {Promise<Array<{ day:string, totalTokens:number, requests:number, costUsd:number, costByAgent:Record<string,number> }>>}
 */
async function getMyUsageTrend(userId, { days } = {}) {
    const { days: d, sinceTs } = normalizeRange(days);
    // DAY_MS 为代码内常量，用 sql.raw 内联——参数化占位符在 floor(x / $n) 上
    // 会让 PG 无法推断操作符类型，且 group by 与 select 必须逐字一致。
    const bucketExpr = sql.raw(`floor(created_at / ${DAY_MS})`);
    const rows = await db
        .select({
            bucket: bucketExpr,
            model: schema.llmUsage.model,
            agent: schema.llmUsage.agentId,
            prompt: sql`coalesce(sum(${schema.llmUsage.promptTokens}), 0)::int`,
            completion: sql`coalesce(sum(${schema.llmUsage.completionTokens}), 0)::int`,
            total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int`,
            cached: sql`coalesce(sum(${schema.llmUsage.cachedTokens}), 0)::int`,
            requests: sql`count(*)::int`,
        })
        .from(schema.llmUsage)
        .where(and(eq(schema.llmUsage.userId, userId), gte(schema.llmUsage.createdAt, sinceTs)))
        .groupBy(bucketExpr, schema.llmUsage.model, schema.llmUsage.agentId);
    return trendFromModelRows(rows, { days: d });
}

/**
 * 区间 [fromTs, toTs) 内的 Token 总量（环比用）。
 */
async function getTotalBetween(userId, fromTs, toTs) {
    const rows = await db
        .select({ total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int` })
        .from(schema.llmUsage)
        .where(and(
            eq(schema.llmUsage.userId, userId),
            gte(schema.llmUsage.createdAt, fromTs),
            lt(schema.llmUsage.createdAt, toTs),
        ));
    return Number(rows[0]?.total || 0);
}

// ── 管理员 ──────────────────────────────────────────────────────────

/**
 * 全部用户用量排行（LEFT JOIN users，含 0 用量用户）。附每用户缓存命中率
 * （分母只计上报了缓存信息的请求）。
 * @returns {Promise<Array<{ userId, username, displayName, role, promptTokens, completionTokens, totalTokens, requests, cachedTokens, cacheHitRate }>>}
 */
async function getUsageByUser({ days } = {}) {
    const { sinceTs } = normalizeRange(days);
    const [rows, savingsByUser] = await Promise.all([
        db
            .select({
                userId: schema.users.id,
                username: schema.users.username,
                displayName: schema.users.displayName,
                role: schema.users.role,
                prompt: sql`coalesce(sum(${schema.llmUsage.promptTokens}), 0)::int`,
                completion: sql`coalesce(sum(${schema.llmUsage.completionTokens}), 0)::int`,
                cached: sql`coalesce(sum(${schema.llmUsage.cachedTokens}), 0)::int`,
                reportedPrompt: sql`coalesce(sum(case when ${schema.llmUsage.cachedTokens} is not null then ${schema.llmUsage.promptTokens} else 0 end), 0)::int`,
                total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int`,
                requests: sql`count(${schema.llmUsage.id})::int`,
                // PG 的 avg 天然忽略 NULL（未走路由的行不计入难易度）
                avgDifficulty: sql`avg(${schema.llmUsage.difficulty})`,
            })
            .from(schema.users)
            .leftJoin(
                schema.llmUsage,
                and(eq(schema.llmUsage.userId, schema.users.id), gte(schema.llmUsage.createdAt, sinceTs)),
            )
            .groupBy(schema.users.id, schema.users.username, schema.users.displayName, schema.users.role)
            .orderBy(sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0) desc`),
        getRoutingCostByUser({ days }),
    ]);
    return rows.map((r) => {
        const cachedTokens = Number(r.cached || 0);
        const reportedPrompt = Number(r.reportedPrompt || 0);
        const savings = savingsByUser.get(r.userId);
        return {
            userId: r.userId,
            username: r.username,
            displayName: r.displayName ?? null,
            role: r.role,
            promptTokens: Number(r.prompt || 0),
            completionTokens: Number(r.completion || 0),
            totalTokens: Number(r.total || 0),
            requests: Number(r.requests || 0),
            cachedTokens,
            cacheHitRate: reportedPrompt > 0 ? Number((cachedTokens / reportedPrompt).toFixed(4)) : null,
            avgDifficulty: r.avgDifficulty == null ? null : Number(Number(r.avgDifficulty).toFixed(4)),
            estSavingsUsd: savings ? Number(savings.estSavingsUsd.toFixed(4)) : null,
        };
    });
}

/**
 * 按 agent 聚合（平台总览或单用户）。命中率分母只计 provider 上报了缓存
 * 信息的请求（cached_tokens 非空行），未上报缓存的流量不稀释命中率。
 * @returns {Promise<Array<{ key:string, requests:number, promptTokens:number, cachedTokens:number, totalTokens:number, cacheHitRate:number|null }>>}
 */
async function getUsageByAgent({ days, userId } = {}) {
    const { sinceTs } = normalizeRange(days);
    const conds = [gte(schema.llmUsage.createdAt, sinceTs)];
    if (userId) conds.push(eq(schema.llmUsage.userId, userId));
    const rows = await db
        .select({
            key: schema.llmUsage.agentId,
            requests: sql`count(*)::int`,
            prompt: sql`coalesce(sum(${schema.llmUsage.promptTokens}), 0)::int`,
            cached: sql`coalesce(sum(${schema.llmUsage.cachedTokens}), 0)::int`,
            reportedPrompt: sql`coalesce(sum(case when ${schema.llmUsage.cachedTokens} is not null then ${schema.llmUsage.promptTokens} else 0 end), 0)::int`,
            total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int`,
        })
        .from(schema.llmUsage)
        .where(and(...conds))
        .groupBy(schema.llmUsage.agentId)
        .orderBy(sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0) desc`);
    return rows.map((r) => {
        const promptTokens = Number(r.prompt || 0);
        const cachedTokens = Number(r.cached || 0);
        const reportedPrompt = Number(r.reportedPrompt || 0);
        return {
            key: r.key ?? '(unknown)',
            requests: Number(r.requests || 0),
            promptTokens,
            cachedTokens,
            totalTokens: Number(r.total || 0),
            cacheHitRate: reportedPrompt > 0 ? Number((cachedTokens / reportedPrompt).toFixed(4)) : null,
        };
    });
}

/**
 * 单用户详情：汇总 + 日趋势 + 模型分布 + 项目分布 + agent 分布 + 内置 AI 功能分布（0043）。
 */
async function getUserUsageDetail(userId, { days } = {}) {
    const [summary, trend, byModel, byProject, byAgent, bySource, internalByFeature] = await Promise.all([
        getMyUsageSummary(userId, { days }),
        getMyUsageTrend(userId, { days }),
        getUsageByModel(userId, { days }),
        getMyUsageByProject(userId, { days }),
        getUsageByAgent({ days, userId }),
        getMyUsageBySource(userId, { days }),
        getMyInternalByFeature(userId, { days }),
    ]);
    return { summary, trend, byModel, byProject, byAgent, bySource, internalByFeature };
}

/**
 * 单用户按模型聚合。
 * @returns {Promise<Array<{ key:string, totalTokens:number, requests:number }>>}
 */
async function getUsageByModel(userId, { days } = {}) {
    const { sinceTs } = normalizeRange(days);
    const rows = await db
        .select({
            key: schema.llmUsage.model,
            total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int`,
            requests: sql`count(*)::int`,
        })
        .from(schema.llmUsage)
        .where(and(eq(schema.llmUsage.userId, userId), gte(schema.llmUsage.createdAt, sinceTs)))
        .groupBy(schema.llmUsage.model)
        .orderBy(sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0) desc`);
    return rows.map((r) => ({ key: r.key ?? '(unknown)', totalTokens: Number(r.total || 0), requests: Number(r.requests || 0) }));
}

/**
 * 平台总览：汇总（含缓存命中）+ 日趋势 + TOP5 用户 + agent 分布。
 */
async function getPlatformOverview({ days } = {}) {
    const { days: d, sinceTs } = normalizeRange(days);
    // 同 getMyUsageTrend：按天分桶用内联常量表达式（select/group by 逐字一致）
    const bucketExpr = sql.raw(`floor(created_at / ${DAY_MS})`);
    const [summaryRows, trendRows, topUsers, byAgent] = await Promise.all([
        db
            .select({
                prompt: sql`coalesce(sum(${schema.llmUsage.promptTokens}), 0)::int`,
                completion: sql`coalesce(sum(${schema.llmUsage.completionTokens}), 0)::int`,
                total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int`,
                cached: sql`coalesce(sum(${schema.llmUsage.cachedTokens}), 0)::int`,
                reportedPrompt: sql`coalesce(sum(case when ${schema.llmUsage.cachedTokens} is not null then ${schema.llmUsage.promptTokens} else 0 end), 0)::int`,
                requests: sql`count(*)::int`,
                activeUsers: sql`count(distinct ${schema.llmUsage.userId})::int`,
            })
            .from(schema.llmUsage)
            .where(gte(schema.llmUsage.createdAt, sinceTs)),
        db
            .select({
                bucket: bucketExpr,
                model: schema.llmUsage.model,
                agent: schema.llmUsage.agentId,
                prompt: sql`coalesce(sum(${schema.llmUsage.promptTokens}), 0)::int`,
                completion: sql`coalesce(sum(${schema.llmUsage.completionTokens}), 0)::int`,
                total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int`,
                cached: sql`coalesce(sum(${schema.llmUsage.cachedTokens}), 0)::int`,
                requests: sql`count(*)::int`,
            })
            .from(schema.llmUsage)
            .where(gte(schema.llmUsage.createdAt, sinceTs))
            .groupBy(bucketExpr, schema.llmUsage.model, schema.llmUsage.agentId),
        getUsageByUser({ days }),
        getUsageByAgent({ days }),
    ]);
    const s = summaryRows[0] || {};
    const cachedTokens = Number(s.cached || 0);
    const reportedPrompt = Number(s.reportedPrompt || 0);
    const trend = trendFromModelRows(trendRows, { days: d });
    return {
        summary: {
            promptTokens: Number(s.prompt || 0),
            completionTokens: Number(s.completion || 0),
            totalTokens: Number(s.total || 0),
            requests: Number(s.requests || 0),
            activeUsers: Number(s.activeUsers || 0),
            cachedTokens,
            cacheHitRate: reportedPrompt > 0 ? Number((cachedTokens / reportedPrompt).toFixed(4)) : null,
        },
        trend,
        topUsers: topUsers.filter((u) => u.totalTokens > 0).slice(0, 5),
        byAgent,
    };
}

/** 最近请求明细（管理员单用户详情用，不含消息内容） */
async function getUserRecentRequests(userId, { days = 7, limit = 20 } = {}) {
    const { sinceTs } = normalizeRange(days);
    const rows = await db
        .select({
            id: schema.llmUsage.id,
            sessionId: schema.llmUsage.sessionId,
            projectId: schema.llmUsage.projectId,
            projectName: schema.projects.name,
            model: schema.llmUsage.model,
            promptTokens: schema.llmUsage.promptTokens,
            completionTokens: schema.llmUsage.completionTokens,
            totalTokens: schema.llmUsage.totalTokens,
            statusCode: schema.llmUsage.statusCode,
            createdAt: schema.llmUsage.createdAt,
        })
        .from(schema.llmUsage)
        .leftJoin(schema.projects, eq(schema.projects.id, schema.llmUsage.projectId))
        .where(and(eq(schema.llmUsage.userId, userId), gte(schema.llmUsage.createdAt, sinceTs)))
        .orderBy(sql`${schema.llmUsage.createdAt} desc`)
        .limit(Math.min(Number(limit) || 20, 100));
    return rows;
}

module.exports = {
    normalizeRange,
    getMyUsageSummary,
    getMyUsageBySource,
    getMyInternalByFeature,
    getMyUsageByProject,
    getMyUsageTrend,
    getTotalBetween,
    getUsageByUser,
    getUsageByModel,
    getUsageByAgent,
    getUserUsageDetail,
    getPlatformOverview,
    getUserRecentRequests,
};
