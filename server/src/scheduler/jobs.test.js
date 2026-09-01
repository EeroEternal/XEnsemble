const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { eq } = require('drizzle-orm');

const { bootstrapTestDb } = require('../test/db');

let ctx;
let schema;
let db;
let jobsMod;

before(async () => {
    ctx = await bootstrapTestDb([
        '../db/index',
        '../db/schema',
        './jobs',
    ], __dirname);
    ({ db, schema } = ctx);
    jobsMod = ctx.reloaded['./jobs'];
});

after(async () => {
    if (ctx) await ctx.teardown();
});

async function makeSession({ status = 'running', withStream = false, headSeq = 0 } = {}) {
    const id = `sess_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const now = Date.now();
    await db.insert(schema.users).values({
        id: userId,
        username: `u_${randomUUID().slice(0, 8)}`,
        passwordHash: 'hash',
        role: 'user',
        status: 'active',
        createdAt: now,
        updatedAt: now,
    });
    const streamRef = `local:pty:${randomUUID()}`;
    await db.insert(schema.sessions).values({
        id,
        userId,
        agentId: 'agent-test',
        cwd: '/work',
        streamRef,
        status,
        createdAt: now,
    });
    if (withStream) {
        await db.insert(schema.sessionStreams).values({
            sessionId: id,
            headSeq,
            bytes: 0,
            storageRef: streamRef,
            updatedAt: now,
        });
    }
    return { id, userId, streamRef };
}

test('listCandidateSessions picks running sessions with new transcript frames', async () => {
    await makeSession({ status: 'running', withStream: true, headSeq: 10 });
    // already summarized to head 10 → no new content
    const done = await makeSession({ status: 'running', withStream: true, headSeq: 5 });
    await db.insert(schema.sessionConversations).values({
        sessionId: done.id,
        summary: { overview: 'done' },
        turns: [],
        lastSummarizedSeq: 5,
        source: 'transcript',
        updatedAt: Date.now(),
    });

    const rows = await jobsMod.listCandidateSessions(10);
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(done.id) === false);
    assert.ok(rows.length >= 1);
});

test('listCandidateSessions skips sessions with error_count >= 3', async () => {
    const s = await makeSession({ status: 'running', withStream: true, headSeq: 8 });
    await db.insert(schema.sessionConversations).values({
        sessionId: s.id,
        summary: { overview: 'x' },
        turns: [],
        lastSummarizedSeq: 0,
        source: 'transcript',
        errorCount: 3,
        updatedAt: Date.now(),
    });
    const rows = await jobsMod.listCandidateSessions(10);
    assert.ok(!rows.some((r) => r.id === s.id));
});

test('runConversationSummarize handles empty candidate list without throwing', async () => {
    // no sessions at all → 0 processed
    const processed = await jobsMod.runConversationSummarize({ log: () => {} });
    assert.equal(processed, 0);
});

test('runConversationSummarize skips a running session with no content (no_content)', async () => {
    const s = await makeSession({ status: 'running', withStream: true, headSeq: 0 });
    // force a conversation row with cursor 0 but head 0 → not a candidate
    await db.insert(schema.sessionConversations).values({
        sessionId: s.id,
        summary: {},
        turns: [],
        lastSummarizedSeq: 0,
        source: 'transcript',
        updatedAt: Date.now(),
    });
    const processed = await jobsMod.runConversationSummarize({ log: () => {} });
    assert.equal(processed, 0);
});
