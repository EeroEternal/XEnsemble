/**
 * Skill pipeline (P3) —— 信号驱动漏斗编排。
 *
 * 流程（对齐 02-技术设计规格 §2.3 / 03-数据模型规格 §4）：
 *   session exit ──► L1 评分（skillScorer，纯规则）score ≥ 40 或 userMarked ──►
 *                    skill_candidates(stage='scored')，sessions.skill_extracted_at 防重入
 *   定时 job（6h）──► L2 聚簇（skillClusterer）──► L3 分类（skillClassifier）
 *                    ──► L4 提炼（skillExtractor + 判重）──► skills(status='draft', source='auto')
 *                    ──► SSE skill_draft_created
 *
 * GC（03 §4）：候选 7 天未升级 → expired；expired/rejected 30 天后物理删除；
 *             auto draft 超 SKILL_DRAFT_TTL_DAYS 未处理 → 物理删除。
 *
 * 灰度：SKILL_EXTRACT_ENABLED 默认 false（关闭时零 LLM 调用，AC-8）。
 */

const { and, eq, inArray, sql } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');
const scorer = require('./skillScorer');
const clusterer = require('./skillClusterer');
const classifier = require('./skillClassifier');
const extractor = require('./skillExtractor');
const { broadcastSse } = require('../session/sseManager');

const DEFAULT_INTERVAL_MS = 21_600_000; // 6h
const DEFAULT_CANDIDATE_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天
const DEFAULT_DRAFT_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天（SKILL_DRAFT_TTL_DAYS）

function isEnabled() {
    return process.env.SKILL_EXTRACT_ENABLED !== 'false';
}

function candidateTtlMs() {
    return Number(process.env.SKILL_CANDIDATE_TTL_DAYS) * 24 * 3600 * 1000 || DEFAULT_CANDIDATE_TTL_MS;
}

function draftTtlMs() {
    return Number(process.env.SKILL_DRAFT_TTL_DAYS) * 24 * 3600 * 1000 || DEFAULT_DRAFT_TTL_MS;
}

// ---------------------------------------------------------------------------
// 依赖（测试可注入）
// ---------------------------------------------------------------------------

function getSummaryService() {
    return require('../session/conversationSummaryService');
}

function getSkillService() {
    return require('./skillService');
}

// ---------------------------------------------------------------------------
// L1 入池
// ---------------------------------------------------------------------------

async function loadSession(sessionId) {
    const rows = await db
        .select({
            id: schema.sessions.id,
            userId: schema.sessions.userId,
            projectId: schema.sessions.projectId,
            skillExtractedAt: schema.sessions.skillExtractedAt,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);
    return rows[0] || null;
}

/**
 * L1 评分 + 入池（exit 时调用；幂等，靠 sessions.skill_extracted_at 防重入）。
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {number} [opts.exitCode]  exit 时的退出码（决定 successExit 信号）
 * @param {boolean} [opts.userMarked] US-3 显式标记（直跳 L4，score=100+）
 * @returns {Promise<{ enqueued: boolean, score: number, reason?: string }>}
 */
async function enqueueCandidate(sessionId, { exitCode = null, userMarked = false } = {}) {
    if (!isEnabled()) return { enqueued: false, score: 0, reason: 'disabled' };

    const session = await loadSession(sessionId);
    if (!session) return { enqueued: false, score: 0, reason: 'session_not_found' };
    if (session.skillExtractedAt != null) return { enqueued: false, score: 0, reason: 'already_extracted' };

    let conversation = null;
    try {
        conversation = await getSummaryService().getConversation(sessionId);
    } catch (_) { /* 提取失败按无摘要处理 */ }

    const summary = (conversation && conversation.summary) || {};
    const turns = (conversation && Array.isArray(conversation.turns)) ? conversation.turns : [];
    const correctionCount = scorer.countCorrections(turns);
    const filesTouched = Array.isArray(summary.filesTouched) ? summary.filesTouched.length : 0;
    const successExit = Number(exitCode) === 0;

    const signals = scorer.buildSignals({
        userMarked,
        correctionCount,
        filesTouched,
        successExit,
        turnCount: turns.length,
        clusterSize: 1,
    });
    const score = scorer.computeScore(signals);

    const overview = summary.overview || '';
    const topicFingerprint = overview ? clusterer.fingerprint(overview) : '';

    // userMarked 直跳 L4（不入候选池的普通流程，由 extractFromSession 处理）；
    // 非 userMarked 且未达阈值 → 不入池。
    if (!userMarked && score < scorer.MIN_SCORE) {
        // 仍标记已处理，避免低价值会话反复重算（AC-3：闲聊零产出）
        await markExtracted(sessionId);
        return { enqueued: false, score, reason: 'below_min_score' };
    }

    const now = Date.now();
    await db
        .insert(schema.skillCandidates)
        .values({
            sessionId,
            userId: session.userId,
            projectId: session.projectId || null,
            score,
            signals,
            topicFingerprint: topicFingerprint || null,
            clusterId: null,
            clusterSize: 1,
            stage: 'scored',
            rejectedReason: null,
            createdAt: now,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: schema.skillCandidates.sessionId,
            set: {
                score,
                signals,
                topicFingerprint: topicFingerprint || null,
                stage: 'scored',
                rejectedReason: null,
                updatedAt: now,
            },
        });
    await markExtracted(sessionId);
    return { enqueued: true, score };
}

async function markExtracted(sessionId) {
    await db
        .update(schema.sessions)
        .set({ skillExtractedAt: Date.now() })
        .where(eq(schema.sessions.id, sessionId));
}

// ---------------------------------------------------------------------------
// GC（03 §4）
// ---------------------------------------------------------------------------

/**
 * 候选/auto draft 生命周期清理：
 * 1. expired/rejected 候选超 30 天 → 物理删除
 * 2. 活跃候选（scored/clustered/classified）超 7 天未升级 → expired
 * 3. skills(draft, source='auto') 超 SKILL_DRAFT_TTL_DAYS 未处理 → 物理删除
 */
async function runGc({ now = Date.now() } = {}) {
    // 先 SELECT 统计各阶段影响行数（postgres-js 的 UPDATE/DELETE rowCount 不可靠）
    const finalCutoff = now - DEFAULT_DRAFT_TTL_MS;
    const staleCutoff = now - candidateTtlMs();
    const draftCutoff = now - draftTtlMs();

    const [finalRows, staleRows, draftRows] = await Promise.all([
        db.select({ sessionId: schema.skillCandidates.sessionId })
            .from(schema.skillCandidates)
            .where(and(
                inArray(schema.skillCandidates.stage, ['expired', 'rejected']),
                sql`${schema.skillCandidates.updatedAt} < ${finalCutoff}`,
            )),
        db.select({ sessionId: schema.skillCandidates.sessionId })
            .from(schema.skillCandidates)
            .where(and(
                inArray(schema.skillCandidates.stage, ['scored', 'clustered', 'classified']),
                sql`${schema.skillCandidates.updatedAt} < ${staleCutoff}`,
            )),
        db.select({ id: schema.skills.id })
            .from(schema.skills)
            .where(and(
                eq(schema.skills.status, 'draft'),
                eq(schema.skills.source, 'auto'),
                sql`${schema.skills.updatedAt} < ${draftCutoff}`,
            )),
    ]);

    // 1. expired/rejected 超 30 天物理删除
    if (finalRows.length > 0) {
        await db.delete(schema.skillCandidates)
            .where(and(
                inArray(schema.skillCandidates.stage, ['expired', 'rejected']),
                sql`${schema.skillCandidates.updatedAt} < ${finalCutoff}`,
            ));
    }
    // 2. 活跃候选超 7 天未升级 → expired
    if (staleRows.length > 0) {
        await db.update(schema.skillCandidates)
            .set({ stage: 'expired', rejectedReason: 'expired', updatedAt: now })
            .where(and(
                inArray(schema.skillCandidates.stage, ['scored', 'clustered', 'classified']),
                sql`${schema.skillCandidates.updatedAt} < ${staleCutoff}`,
            ));
    }
    // 3. auto draft 超 TTL 未处理 → 物理删除（manual 永久保留）
    if (draftRows.length > 0) {
        await db.delete(schema.skills)
            .where(and(
                eq(schema.skills.status, 'draft'),
                eq(schema.skills.source, 'auto'),
                sql`${schema.skills.updatedAt} < ${draftCutoff}`,
            ));
    }
    return {
        deletedFinal: finalRows.length,
        expiredStale: staleRows.length,
        deletedDraft: draftRows.length,
    };
}

// ---------------------------------------------------------------------------
// 漏斗主流程（L2 → L3 → L4）
// ---------------------------------------------------------------------------

async function loadCandidates(stages) {
    return db
        .select()
        .from(schema.skillCandidates)
        .where(inArray(schema.skillCandidates.stage, stages))
        .orderBy(schema.skillCandidates.createdAt);
}

async function loadCandidate(sessionId) {
    const rows = await db
        .select()
        .from(schema.skillCandidates)
        .where(eq(schema.skillCandidates.sessionId, sessionId))
        .limit(1);
    return rows[0] || null;
}

/**
 * L2 聚簇：对 stage='scored' 且带指纹的候选做传递闭包聚簇，
 * 回填 cluster_id / cluster_size 并推进 stage='clustered'。
 */
async function runCluster() {
    const scored = await loadCandidates(['scored']);
    const withFingerprint = scored.filter((c) => c.topicFingerprint);

    const updated = [];
    if (withFingerprint.length > 0) {
        const groups = clusterer.cluster(withFingerprint.map((c) => ({
            sessionId: c.sessionId,
            overview: c.topicFingerprint, // 指纹本身即为归一化词串，可复用 tokenize
        })));
        const now = Date.now();
        for (const group of groups) {
            for (const sessionId of group.sessionIds) {
                await db
                    .update(schema.skillCandidates)
                    .set({ clusterId: group.clusterId, clusterSize: group.size, stage: 'clustered', updatedAt: now })
                    .where(eq(schema.skillCandidates.sessionId, sessionId));
                updated.push({ sessionId, clusterId: group.clusterId, clusterSize: group.size });
            }
        }
    }
    return updated;
}

/**
 * 安全 log 封装：console 不可直接调用（不是函数），避免 `log.warn?.(m) ?? log?.(m)`
 * 在 log=console 时执行 console(...) 抛 TypeError。
 */
function safeLog(log, msg) {
    if (log && typeof log.warn === 'function') {
        try { log.warn(msg); return; } catch (_) { /* ignore */ }
    }
    if (typeof log === 'function') {
        try { log(msg); return; } catch (_) { /* ignore */ }
    }
}

/**
 * L3 + L4：对 clustered/classified 候选逐一分类、提炼、判重、落库 skills。
 *
 * 决策（02 §6.2 / §3.4）：
 * - userMarked → 无条件 L4
 * - 单例（clusterSize===1）且 score < SINGLETON_MIN_SCORE → rejected(singleton_low_score)
 * - L3 分类 reusable=false → rejected(low_value)
 * - L4 提炼 → 判重（标题相似 + LLM 二次确认）→ duplicate_of 标记
 *
 * @returns {Promise<Array>} 处理摘要
 */
async function runExtract({ log = console } = {}) {
    const candidates = await loadCandidates(['clustered', 'classified']);
    const results = [];
    for (const cand of candidates) {
        const now = Date.now();
        const signals = cand.signals || {};
        const userMarked = Boolean(signals.userMarked);

        // 单例低分直接拒绝（§6.2 单例需 score ≥ 60）
        if (!userMarked && cand.clusterSize <= 1 && cand.score < scorer.SINGLETON_MIN_SCORE) {
            await db.update(schema.skillCandidates)
                .set({ stage: 'rejected', rejectedReason: 'singleton_low_score', updatedAt: now })
                .where(eq(schema.skillCandidates.sessionId, cand.sessionId));
            results.push({ sessionId: cand.sessionId, outcome: 'rejected:singleton_low_score' });
            continue;
        }

        // 加载会话上下文（summary + turns）供 L3/L4
        let conversation = null;
        try {
            conversation = await getSummaryService().getConversation(cand.sessionId);
        } catch (_) { /* 兜底：无摘要则跳过本轮 */ }
        const summary = (conversation && conversation.summary) || {};
        const turns = (conversation && Array.isArray(conversation.turns)) ? conversation.turns : [];

        // L3 分类（跳过已 classified / userMarked）
        let classified = cand.stage === 'classified';
        let classifiedType = null;
        if (!classified && !userMarked) {
            try {
                const cl = await classifier.classify({
                    overview: summary.overview || '',
                    keyDecisions: summary.keyDecisions || [],
                    filesTouched: summary.filesTouched || [],
                });
                if (!cl.reusable) {
                    await db.update(schema.skillCandidates)
                        .set({ stage: 'rejected', rejectedReason: 'low_value', updatedAt: now })
                        .where(eq(schema.skillCandidates.sessionId, cand.sessionId));
                    results.push({ sessionId: cand.sessionId, outcome: 'rejected:low_value' });
                    continue;
                }
                classified = true;
                classifiedType = cl.type || null;
            } catch (err) {
                // LLM 未配置 / 瞬时失败：本轮跳过，保留 stage 下轮重试
                safeLog(log, `[skill-pipeline] classify skip ${cand.sessionId}: ${err?.message || err}`);
                results.push({ sessionId: cand.sessionId, outcome: 'classify_deferred' });
                continue;
            }
        }

        // L4 提炼
        let extracted;
        try {
            extracted = await extractor.extract({ summary, turns });
        } catch (err) {
            safeLog(log, `[skill-pipeline] extract skip ${cand.sessionId}: ${err?.message || err}`);
            results.push({ sessionId: cand.sessionId, outcome: 'extract_deferred' });
            continue;
        }

        // 判重（§3.4）：标题相似 ≥0.85 → LLM 二次确认
        let duplicateOf = null;
        try {
            const similar = await extractor.findSimilarTitles(cand.userId, extracted.title);
            for (const existing of similar) {
                const dup = await extractor.confirmDuplicate({
                    existingTitle: existing.title,
                    existingContent: existing.content,
                    newTitle: extracted.title,
                    newContent: extracted.content,
                });
                if (dup) {
                    duplicateOf = existing.id;
                    break;
                }
            }
        } catch (_) { /* 判重失败不阻塞提炼（LLM 不可用等） */ }

        // 落库 skills（draft, source='auto'），category 用 L3 分类结果
        const skillService = getSkillService();
        const skill = await skillService.createSkill({
            userId: cand.userId,
            title: extracted.title,
            content: extracted.content,
            tags: extracted.tags,
            category: classifiedType || null,
            projectId: cand.projectId || null,
            sessionId: cand.sessionId,
            source: 'auto',
            signals,
            confidence: extracted.confidence,
            scripts: extracted.scripts || [],
        });
        if (duplicateOf) {
            await db.update(schema.skills)
                .set({ duplicateOf })
                .where(eq(schema.skills.id, skill.id));
        }

        // 候选推进 extracted + SSE
        await db.update(schema.skillCandidates)
            .set({ stage: 'extracted', rejectedReason: null, updatedAt: now })
            .where(eq(schema.skillCandidates.sessionId, cand.sessionId));
        try {
            broadcastSse({
                type: 'skill_draft_created',
                skillId: skill.id,
                title: skill.title,
                userId: cand.userId,
            });
        } catch (_) { /* SSE 失败不影响主流程 */ }

        results.push({
            sessionId: cand.sessionId,
            outcome: 'extracted',
            skillId: skill.id,
            duplicateOf,
        });
    }
    return results;
}

/**
 * 完整漏斗一轮：GC → L2 聚簇 → L3/L4 提炼。
 * @returns {Promise<object>} 摘要
 */
async function runPipeline({ log = console } = {}) {
    if (!isEnabled()) return { skipped: true };
    const gc = await runGc();
    const clustered = await runCluster();
    const extracted = await runExtract({ log });
    return { gc, clustered, extracted };
}

// ---------------------------------------------------------------------------
// US-3：从会话手动提炼（直跳 L4，跳过 L1-L3）
// ---------------------------------------------------------------------------

/**
 * 从指定会话手动提炼 skill（04-API规格 §2.7）。
 * - 会话需有 conversation summary；无则内部先触发一次摘要（串行等待）
 * - 已在候选池 → 标记 stage='extracted'，防漏斗重复处理
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @returns {Promise<object>} skill 全量
 */
async function extractFromSession(sessionId, { userId, log = console } = {}) {
    // 手动提炼（US-3 显式操作）不受 SKILL_EXTRACT_ENABLED 灰度限制：
    // 与「手动 Refresh 摘要不受 Scheduler 开关影响」同语义；AC-8 仅约束自动漏斗。
    let session = await loadSession(sessionId);
    if (!session) {
        const err = new Error('session not found');
        err.code = 'session_not_found';
        err.statusCode = 404;
        throw err;
    }

    let conversation = null;
    try {
        conversation = await getSummaryService().getConversation(sessionId);
    } catch (_) { /* below */ }
    if (!conversation || !(conversation.summary && conversation.summary.overview)) {
        // 无摘要 → 内部触发一次（force 不必要，首次 exit 路径已足够）
        try {
            await getSummaryService().summarizeSession(sessionId);
            conversation = await getSummaryService().getConversation(sessionId);
        } catch (err) {
            log.warn?.(`[skill-pipeline] from-session summarize ${sessionId}: ${err?.message || err}`)
                ?? log?.(`[skill-pipeline] from-session summarize ${sessionId}: ${err?.message || err}`);
        }
    }
    const summary = (conversation && conversation.summary) || {};
    const turns = (conversation && Array.isArray(conversation.turns)) ? conversation.turns : [];

    const extracted = await extractor.extract({ summary, turns });

    let duplicateOf = null;
    try {
        const similar = await extractor.findSimilarTitles(session.userId, extracted.title);
        for (const existing of similar) {
            const dup = await extractor.confirmDuplicate({
                existingTitle: existing.title,
                existingContent: existing.content,
                newTitle: extracted.title,
                newContent: extracted.content,
            });
            if (dup) { duplicateOf = existing.id; break; }
        }
    } catch (_) { /* 判重失败不阻塞 */ }

    const signals = scorer.buildSignals({
        userMarked: true,
        correctionCount: scorer.countCorrections(turns),
        filesTouched: Array.isArray(summary.filesTouched) ? summary.filesTouched.length : 0,
        successExit: false,
        turnCount: turns.length,
        clusterSize: 1,
    });

    const skillService = getSkillService();
    const skill = await skillService.createSkill({
        userId: userId || session.userId,
        title: extracted.title,
        content: extracted.content,
        tags: extracted.tags,
        category: extracted.type || null,
        projectId: session.projectId || null,
        sessionId,
        source: 'auto',
        signals,
        confidence: extracted.confidence,
        scripts: extracted.scripts || [],
    });
    if (duplicateOf) {
        await db.update(schema.skills).set({ duplicateOf }).where(eq(schema.skills.id, skill.id));
    }

    // 防漏斗重复处理
    const existingCand = await loadCandidate(sessionId);
    if (existingCand) {
        await db.update(schema.skillCandidates)
            .set({ stage: 'extracted', updatedAt: Date.now() })
            .where(eq(schema.skillCandidates.sessionId, sessionId));
    }
    await markExtracted(sessionId);

    return skill;
}

// ---------------------------------------------------------------------------
// exit 钩子（对齐 conversationAutoSummarizer 模式）
// ---------------------------------------------------------------------------

const sessionManager = require('../session/SessionManager');
const state = new Map();

function cleanup(sessionId) {
    state.delete(sessionId);
}

async function runOnce(sessionId, exitCode) {
    const entry = state.get(sessionId);
    if (!entry) return;
    if (entry.running) {
        entry.pending = true;
        return;
    }
    entry.running = true;
    try {
        await enqueueCandidate(sessionId, { exitCode });
    } catch (_) {
        // 入池失败不影响会话生命周期
    } finally {
        entry.running = false;
        if (entry.pending) {
            entry.pending = false;
            setImmediate(() => runOnce(sessionId, exitCode));
        }
    }
}

function attach(sessionId) {
    if (state.has(sessionId)) return;
    state.set(sessionId, { running: false, pending: false });
    sessionManager.onExit(sessionId, (exitCode) => runOnce(sessionId, exitCode));
}

function start() {
    sessionManager.onSessionCreated((session) => {
        if (session?.id) attach(session.id);
    });
    for (const session of sessionManager.listSessions()) {
        if (session?.id) attach(session.id);
    }
}

function stop() {
    for (const id of [...state.keys()]) cleanup(id);
}

module.exports = {
    isEnabled,
    DEFAULT_INTERVAL_MS,
    enqueueCandidate,
    extractFromSession,
    runCluster,
    runExtract,
    runGc,
    runPipeline,
    start,
    stop,
};
