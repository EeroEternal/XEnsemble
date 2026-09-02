const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { eq } = require('drizzle-orm');

const { bootstrapTestDb } = require('../test/db');

let ctx;
let schema;
let db;
let pipeline;
let analyzeClient;
let conversationSvc;

before(async () => {
    ctx = await bootstrapTestDb([
        '../db/index',
        '../db/schema',
        '../llm/analyzeClient',
        '../session/conversationSummaryService',
        './skillService',
        './skillPipeline',
    ], __dirname);
    ({ db, schema } = ctx);
    analyzeClient = ctx.reloaded['../llm/analyzeClient'];
    conversationSvc = ctx.reloaded['../session/conversationSummaryService'];
    pipeline = ctx.reloaded['./skillPipeline'];
});

after(async () => {
    if (ctx) await ctx.teardown();
});

// 每个用例前清理候选/技能，避免跨用例残留污染断言
beforeEach(async () => {
    await db.delete(schema.skillCandidates);
    await db.delete(schema.skills);
});

async function makeUser() {
    const id = `user_${randomUUID()}`;
    const now = Date.now();
    await db.insert(schema.users).values({
        id,
        username: `u_${randomUUID().slice(0, 8)}`,
        passwordHash: 'hash',
        role: 'user',
        status: 'active',
        createdAt: now,
        updatedAt: now,
    });
    return id;
}

async function makeSession(userId, { withSummary = true, summaryOverrides = {} } = {}) {
    const id = `sess_${randomUUID()}`;
    const now = Date.now();
    await db.insert(schema.sessions).values({
        id,
        userId,
        agentId: 'agent-test',
        cwd: '/work',
        streamRef: `local:pty:${randomUUID()}`,
        status: 'exited',
        createdAt: now,
    });
    if (withSummary) {
        const summary = {
            overview: '修复 PostgreSQL 连接池泄漏',
            keyDecisions: ['改用连接池复用'],
            filesTouched: ['server/src/db/index.js', 'server/src/db/pool.js', 'server/src/db/config.js'],
            ...summaryOverrides,
        };
        await db.insert(schema.sessionConversations).values({
            sessionId: id,
            summary,
            turns: [
                { role: 'user', text: '修一下连接池泄漏' },
                { role: 'assistant', text: '好的，我检查连接池代码', tools: ['Read'] },
                { role: 'user', text: '不对，应该用连接池复用' },
                { role: 'assistant', text: '改用复用机制', tools: ['Edit'] },
            ],
            lastSummarizedSeq: 0,
            source: 'chat',
            lastError: null,
            errorCount: 0,
            updatedAt: now,
        });
    }
    return id;
}

async function getCandidate(sessionId) {
    const rows = await db
        .select()
        .from(schema.skillCandidates)
        .where(eq(schema.skillCandidates.sessionId, sessionId));
    return rows[0] || null;
}

test('enqueueCandidate inserts scored candidate and marks session extracted (score ≥ MIN_SCORE)', async () => {
    const userId = await makeUser();
    const sessionId = await makeSession(userId);

    const result = await pipeline.enqueueCandidate(sessionId, { exitCode: 0 });
    assert.equal(result.enqueued, true);
    assert.ok(result.score >= 40);

    const cand = await getCandidate(sessionId);
    assert.ok(cand);
    assert.equal(cand.stage, 'scored');
    assert.equal(cand.clusterSize, 1);
    // 中文按 2-gram 指纹，'连接池' 会拆成 '连接'/'接池'
    assert.ok(cand.topicFingerprint.includes('连接'));

    // 幂等：再次入池不重复
    const again = await pipeline.enqueueCandidate(sessionId, { exitCode: 0 });
    assert.equal(again.enqueued, false);
    assert.equal(again.reason, 'already_extracted');
});

test('enqueueCandidate skips low-score sessions but still marks extracted (AC-3: chitchat → 0 skill)', async () => {
    const userId = await makeUser();
    // 无 filesTouched、无纠正、无成功退出 → 低分
    const sessionId = await makeSession(userId, {
        withSummary: true,
        summaryOverrides: {
            filesTouched: [],
            keyDecisions: [],
        },
    });
    const result = await pipeline.enqueueCandidate(sessionId, { exitCode: 1 });
    assert.equal(result.enqueued, false);
    assert.equal(result.reason, 'below_min_score');
    const cand = await getCandidate(sessionId);
    assert.equal(cand, null);
});

test('enqueueCandidate is no-op when disabled (AC-8: zero LLM calls)', async () => {
    const userId = await makeUser();
    const sessionId = await makeSession(userId);
    const prev = process.env.SKILL_EXTRACT_ENABLED;
    process.env.SKILL_EXTRACT_ENABLED = 'false';
    try {
        const result = await pipeline.enqueueCandidate(sessionId, { exitCode: 0 });
        assert.equal(result.enqueued, false);
        assert.equal(result.reason, 'disabled');
    } finally {
        if (prev === undefined) delete process.env.SKILL_EXTRACT_ENABLED;
        else process.env.SKILL_EXTRACT_ENABLED = prev;
    }
});

test('runCluster groups similar scored candidates and backfills cluster_size', async () => {
    const userId = await makeUser();
    const s1 = await makeSession(userId, { summaryOverrides: { overview: '修复 PostgreSQL 连接池泄漏' } });
    const s2 = await makeSession(userId, { summaryOverrides: { overview: '修复 PostgreSQL 连接池泄漏并优化' } });
    await pipeline.enqueueCandidate(s1, { exitCode: 0 });
    await pipeline.enqueueCandidate(s2, { exitCode: 0 });

    const clustered = await pipeline.runCluster();
    assert.equal(clustered.length, 2);
    const c1 = await getCandidate(s1);
    assert.equal(c1.stage, 'clustered');
    assert.equal(c1.clusterSize, 2);
    assert.ok(c1.clusterId);
    assert.equal(c1.clusterId, (await getCandidate(s2)).clusterId);
});

test('runExtract produces auto draft skill + SSE and advances candidate to extracted', async () => {
    const userId = await makeUser();
    const sessionId = await makeSession(userId);
    await pipeline.enqueueCandidate(sessionId, { exitCode: 0 });
    await pipeline.runCluster();

    // mock LLM：分类 reusable + 提炼结果（用 prompt 特征串区分 classify/dedup/extract）
    analyzeClient.chatJson = async ({ user }) => {
        if (user.includes('"duplicate"')) return { duplicate: false };
        if (user.includes('"reusable"')) return { reusable: true, type: 'database' };
        return {
            name: '修复 PostgreSQL 连接池泄漏',
            description: '数据库连接池报错时如何排查',
            content: '## When to use\n数据库连接池报错时。\n## Steps\n1. 检查 pool 配置\n2. 启用复用',
            tags: ['postgres', 'pool'],
            confidence: 0.9,
            scripts: [{ path: 'scripts/check.sh', content: '#!/bin/bash\npgrep postgres' }],
        };
    };

    const results = await pipeline.runExtract();
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, 'extracted');
    assert.ok(results[0].skillId);

    const cand = await getCandidate(sessionId);
    assert.equal(cand.stage, 'extracted');

    const skill = await db.select().from(schema.skills).where(eq(schema.skills.id, results[0].skillId));
    assert.equal(skill[0].status, 'draft');
    assert.equal(skill[0].source, 'auto');
    assert.equal(skill[0].category, 'database');
    assert.equal(skill[0].sessionId, sessionId);
    // 0020：提炼脚本贯通到 skills.scripts
    assert.deepEqual(skill[0].scripts, [{ path: 'scripts/check.sh', content: '#!/bin/bash\npgrep postgres' }]);
});

test('runExtract rejects low-value via L3 (reusable=false)', async () => {
    const userId = await makeUser();
    const sessionId = await makeSession(userId);
    await pipeline.enqueueCandidate(sessionId, { exitCode: 0 });
    await pipeline.runCluster();

    analyzeClient.chatJson = async ({ user }) => {
        if (user.includes('"duplicate"')) return { duplicate: false };
        if (user.includes('"reusable"')) return { reusable: false, type: 'none' };
        return { title: 'x', content: 'y', tags: [], confidence: 0.5 };
    };

    const results = await pipeline.runExtract();
    assert.equal(results[0].outcome, 'rejected:low_value');
    const cand = await getCandidate(sessionId);
    assert.equal(cand.stage, 'rejected');
    assert.equal(cand.rejectedReason, 'low_value');
});

test('runExtract rejects singleton with score < SINGLETON_MIN_SCORE', async () => {
    const userId = await makeUser();
    // 低分会话：无纠正、少文件、失败退出
    const sessionId = await makeSession(userId, {
        withSummary: true,
        summaryOverrides: {
            filesTouched: ['a.js'],
            keyDecisions: [],
        },
    });
    // 手动插入低分候选（stage=clustered，clusterSize=1）
    const now = Date.now();
    await db.insert(schema.skillCandidates).values({
        sessionId,
        userId,
        projectId: null,
        score: 15,
        signals: { userMarked: false, correctionCount: 0, filesTouched: 1, successExit: false, turnCount: 5, clusterSize: 1 },
        topicFingerprint: 'low',
        clusterId: sessionId,
        clusterSize: 1,
        stage: 'clustered',
        rejectedReason: null,
        createdAt: now,
        updatedAt: now,
    });

    const results = await pipeline.runExtract();
    assert.equal(results[0].outcome, 'rejected:singleton_low_score');
    const cand = await getCandidate(sessionId);
    assert.equal(cand.stage, 'rejected');
    assert.equal(cand.rejectedReason, 'singleton_low_score');
});

test('extractFromSession (US-3) creates a skill directly from a session', async () => {
    const userId = await makeUser();
    const sessionId = await makeSession(userId);

    analyzeClient.chatJson = async ({ user }) => {
        if (user.includes('"duplicate"')) return { duplicate: false };
        return {
            name: '手动提炼的技能',
            description: '从会话中手动提炼',
            content: '## Steps\n1. 步骤一\n2. 步骤二',
            tags: ['manual'],
            confidence: 0.8,
        };
    };

    const skill = await pipeline.extractFromSession(sessionId, { userId });
    assert.equal(skill.title, '手动提炼的技能');
    assert.equal(skill.source, 'auto');
    assert.equal(skill.status, 'draft');
    assert.equal(skill.sessionId, sessionId);

    // 会话已标记 extracted
    const sess = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    assert.ok(sess[0].skillExtractedAt > 0);
});

test('extractFromSession throws session_not_found for missing session', async () => {
    await assert.rejects(
        () => pipeline.extractFromSession('sess_missing', { userId: 'u' }),
        (e) => e.code === 'session_not_found',
    );
});

test('runGc expires stale candidates and deletes stale auto drafts', async () => {
    const userId = await makeUser();
    const sessionId = await makeSession(userId);
    const now = Date.now();

    // 过期候选（7 天前 scored）
    await db.insert(schema.skillCandidates).values({
        sessionId,
        userId,
        projectId: null,
        score: 80,
        signals: { userMarked: false },
        topicFingerprint: 'x',
        clusterId: null,
        clusterSize: 1,
        stage: 'scored',
        rejectedReason: null,
        createdAt: now - 10 * 24 * 3600 * 1000,
        updatedAt: now - 10 * 24 * 3600 * 1000,
    });

    // 过期 auto draft（30 天前）
    await db.insert(schema.skills).values({
        id: `skl_${randomUUID()}`,
        userId,
        title: 'stale draft',
        content: 'x',
        tags: [],
        status: 'draft',
        source: 'auto',
        confidence: 0.5,
        signals: null,
        clusterSize: 1,
        visibility: 'private',
        installCount: 0,
        usageCount: 0,
        createdAt: now - 40 * 24 * 3600 * 1000,
        updatedAt: now - 40 * 24 * 3600 * 1000,
    });

    const result = await pipeline.runGc();
    assert.ok(result.expiredStale >= 1);
    assert.ok(result.deletedDraft >= 1);

    const cand = await getCandidate(sessionId);
    assert.equal(cand.stage, 'expired');
    assert.equal(cand.rejectedReason, 'expired');
});

test('conversationSvc integration: pipeline reads summary via getConversation', async () => {
    const userId = await makeUser();
    const sessionId = await makeSession(userId);
    const view = await conversationSvc.getConversation(sessionId);
    assert.ok(view.summary.overview.includes('连接池'));
    assert.ok(view.turns.length >= 2);
});
