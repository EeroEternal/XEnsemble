const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');

const { bootstrapTestDb } = require('../test/db');

let ctx;
let db;
let schema;
let chatTranscript;

before(async () => {
    ctx = await bootstrapTestDb([
        '../db/index',
        '../db/schema',
        '../llm/chatTranscript',
    ], __dirname);
    ({ db, schema } = ctx);
    chatTranscript = ctx.reloaded['../llm/chatTranscript'];
});

after(async () => {
    if (ctx) await ctx.teardown();
});

async function makeSession() {
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
    await db.insert(schema.sessions).values({
        id,
        userId,
        agentId: 'agent-test',
        cwd: '/work',
        streamRef: `local:pty:${randomUUID()}`,
        status: 'running',
        createdAt: now,
    });
    return id;
}

test('getHistory only returns messages of the requested session (no cross-session seq leakage)', async () => {
    const s1 = await makeSession();
    const s2 = await makeSession();

    // 两个会话都写相同的 seq（1、2、3）——此前的 JOIN 只 on seq 会把 s2 的也带出来
    for (const sid of [s1, s2]) {
        for (let seq = 1; seq <= 3; seq += 1) {
            await db.insert(schema.sessionChatMessages).values({
                sessionId: sid,
                seq,
                ts: 1000 + seq,
                role: 'user',
                content: `${sid.slice(-6)}-msg${seq}`,
            });
        }
    }

    const h1 = await chatTranscript.getHistory(s1);
    assert.equal(h1.length, 3, 'should only contain s1 messages');
    for (const m of h1) assert.ok(m.content.includes(s1.slice(-6)), `unexpected cross-session message: ${m.content}`);
    assert.ok(!h1.some((m) => m.content.includes(s2.slice(-6))), 'leaked messages from other session');

    const h2 = await chatTranscript.getHistory(s2);
    assert.equal(h2.length, 3);
    assert.ok(!h2.some((m) => m.content.includes(s1.slice(-6))));
});

test('getHistory returns newest MAX_EVENTS_PER_SESSION in ascending seq order', async () => {
    const sid = await makeSession();
    const total = 1010;
    for (let seq = 1; seq <= total; seq += 1) {
        await db.insert(schema.sessionChatMessages).values({
            sessionId: sid,
            seq,
            ts: 1000 + seq,
            role: 'user',
            content: `msg${seq}`,
        });
    }
    const h = await chatTranscript.getHistory(sid);
    assert.equal(h.length, 500);
    assert.equal(h[0].content, 'msg511');      // 1010 条取最新 500 条 = msg511..msg1010
    assert.equal(h[499].content, 'msg1010');
    for (let i = 1; i < h.length; i += 1) {
        assert.ok(h[i].seq > h[i - 1].seq, 'not ascending seq');
    }
});

test('getHistory cursor pagination: limit + beforeSeq pages backward', async () => {
    const sid = await makeSession();
    for (let seq = 1; seq <= 10; seq += 1) {
        await db.insert(schema.sessionChatMessages).values({
            sessionId: sid,
            seq,
            ts: 1000 + seq,
            role: 'user',
            content: `msg${seq}`,
        });
    }
    // 第一页：最新 4 条，升序
    const page1 = await chatTranscript.getHistory(sid, { limit: 4 });
    assert.deepEqual(page1.map((m) => m.seq), [7, 8, 9, 10]);
    // 第二页：before_seq = 第一页最早 seq，取更早的 4 条
    const page2 = await chatTranscript.getHistory(sid, { limit: 4, beforeSeq: page1[0].seq });
    assert.deepEqual(page2.map((m) => m.seq), [3, 4, 5, 6]);
    // 第三页：只剩 2 条，不足一页（调用方据此判断「已到开头」）
    const page3 = await chatTranscript.getHistory(sid, { limit: 4, beforeSeq: page2[0].seq });
    assert.deepEqual(page3.map((m) => m.seq), [1, 2]);
    // limit 超过 MAX_EVENTS_PER_SESSION 时被夹到上限；非法值回退默认（全量）
    const all = await chatTranscript.getHistory(sid, { limit: 99999 });
    assert.equal(all.length, 10);
    const badLimit = await chatTranscript.getHistory(sid, { limit: -5 });
    assert.equal(badLimit.length, 10);
});
