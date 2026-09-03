const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { eq } = require('drizzle-orm');

const { bootstrapTestDb } = require('../test/db');

let ctx;
let schema;
let db;
let svc;
let analyzeClient;
let transcriptStore;

before(async () => {
    ctx = await bootstrapTestDb([
        '../llm/analyzeClient',
        '../runtime/TranscriptStore',
        './conversationSummaryService',
    ], __dirname);
    ({ db, schema } = ctx);
    analyzeClient = ctx.reloaded['../llm/analyzeClient'];
    transcriptStore = ctx.reloaded['../runtime/TranscriptStore'];
    svc = ctx.reloaded['./conversationSummaryService'];
});

after(async () => {
    if (ctx) await ctx.teardown();
});

async function makeSession({ streamRef } = {}) {
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
    const stream = streamRef || `local:pty:${randomUUID()}`;
    await db.insert(schema.sessions).values({
        id,
        userId,
        agentId: 'agent-test',
        cwd: '/work',
        streamRef: stream,
        status: 'running',
        createdAt: now,
    });
    return { id, stream };
}

function appendTurn(streamRef, inText, outText) {
    transcriptStore.append(streamRef, { kind: 'in', data: inText });
    if (outText) transcriptStore.append(streamRef, { kind: 'out', data: outText });
}

const GOOD_SUMMARY = {
    overview: 'Fixed the login bug',
    turns: [
        { role: 'user', summary: 'asked to fix login' },
        { role: 'assistant', summary: 'edited auth.js', tools: ['Edit', 'Bash'] },
    ],
    keyDecisions: ['switch to bcrypt'],
    filesTouched: ['server/src/auth.js'],
};

test('validateSummary normalizes valid output', () => {
    const out = svc.validateSummary({
        overview: '  overview text  ',
        keyDecisions: ['d1', '', 42, 'd2'],
        filesTouched: ['a.js', '', 'b.js'],
    });
    assert.equal(out.overview, 'overview text');
    assert.deepEqual(out.keyDecisions, ['d1', 'd2']);
    assert.deepEqual(out.filesTouched, ['a.js', 'b.js']);
});

test('validateSummary rejects missing overview', () => {
    assert.equal(svc.validateSummary({ keyDecisions: [] }), null);
    assert.equal(svc.validateSummary(null), null);
    assert.equal(svc.validateSummary('nope'), null);
});

test('validateSummary caps keyDecisions at 20 and filesTouched at 20', () => {
    const decisions = Array.from({ length: 30 }, (_, i) => `d${i}`);
    const files = Array.from({ length: 30 }, (_, i) => `f${i}.js`);
    const out = svc.validateSummary({ overview: 'o', keyDecisions: decisions, filesTouched: files });
    assert.equal(out.keyDecisions.length, 20);
    assert.equal(out.filesTouched.length, 20);
});

test('buildFullPrompt includes turn text and output contract', () => {
    const prompt = svc.buildFullPrompt([
        { role: 'user', text: 'fix login' },
        { role: 'assistant', text: 'editing auth.js', tools: ['Edit'] },
    ]);
    assert.match(prompt, /fix login/);
    assert.match(prompt, /editing auth\.js/);
    assert.match(prompt, /\[tools: Edit\]/);
    assert.match(prompt, /"overview"/);
    assert.doesNotMatch(prompt, /"turns"/);
});

test('summarizeSession full path upserts conversation and advances cursor', async () => {
    const { id, stream } = await makeSession();
    appendTurn(stream, 'fix login bug', 'editing auth.js\n');

    const calls = [];
    analyzeClient.chatJson = async (params) => {
        calls.push(params);
        return GOOD_SUMMARY;
    };

    const view = await svc.summarizeSession(id);
    assert.equal(view.sessionId, id);
    assert.equal(view.summary.overview, 'Fixed the login bug');
    assert.equal(view.turns.length, 2);
    assert.equal(view.source, 'transcript');

    const head = transcriptStore.head(stream);
    assert.equal(view.lastSummarizedSeq, head);
    assert.equal(calls.length, 1);
    assert.match(calls[0].user, /fix login bug/);

    const row = await db.select().from(schema.sessionConversations)
        .where(eq(schema.sessionConversations.sessionId, id));
    assert.equal(row[0].errorCount, 0);
    assert.equal(row[0].lastError, null);
});

test('summarizeSession does not re-call LLM when summary exists and not forced', async () => {
    const { id, stream } = await makeSession();
    appendTurn(stream, 'fix login bug', 'editing auth.js\n');

    analyzeClient.chatJson = async () => GOOD_SUMMARY;
    await svc.summarizeSession(id);

    // New turns arrive; without force, the exit-once policy keeps the existing
    // summary and only persists the raw turns (A) — no second LLM call.
    appendTurn(stream, 'now also fix the logout bug', 'editing logout.js\n');

    let callCount = 0;
    analyzeClient.chatJson = async () => { callCount += 1; return GOOD_SUMMARY; };

    const view = await svc.summarizeSession(id);
    assert.equal(callCount, 0);
    assert.equal(view.summary.overview, 'Fixed the login bug');
});

test('summarizeSession bad JSON persists turns but increments error_count', async () => {
    const { id, stream } = await makeSession();
    appendTurn(stream, 'do work', 'doing work\n');

    analyzeClient.chatJson = async () => {
        const err = new Error('LLM returned invalid JSON: bad');
        err.code = 'llm_request_failed';
        throw err;
    };

    await assert.rejects(
        () => svc.summarizeSession(id),
        (err) => err.code === 'llm_request_failed',
    );

    const row = await db.select().from(schema.sessionConversations)
        .where(eq(schema.sessionConversations.sessionId, id));
    assert.equal(row[0].errorCount, 1);
    assert.ok(row[0].lastError.includes('invalid JSON'));
    // A: turns are persisted regardless of the LLM outcome.
    assert.ok(Array.isArray(row[0].turns) && row[0].turns.length > 0);
});

test('summarizeSession returns current view when nothing new', async () => {
    const { id, stream } = await makeSession();
    appendTurn(stream, 'hello', 'hi there\n');

    analyzeClient.chatJson = async () => GOOD_SUMMARY;
    await svc.summarizeSession(id);

    let callCount = 0;
    analyzeClient.chatJson = async () => { callCount += 1; return GOOD_SUMMARY; };

    const view = await svc.summarizeSession(id);
    assert.equal(callCount, 0);
    assert.equal(view.summary.overview, 'Fixed the login bug');
});

test('getConversation returns null for missing row', async () => {
    const missing = await svc.getConversation('sess_does_not_exist');
    assert.equal(missing, null);
});

test('summarizeSession persists all turns but caps the LLM prompt to last 100', async () => {
    const { id } = await makeSession();
    // 聊天源：120 条 user 消息 → 120 turns
    const history = [];
    for (let i = 1; i <= 120; i += 1) {
        history.push({ seq: i, ts: 1000 + i, role: 'user', content: `msg${i}` });
    }
    const chatTranscript = require('../llm/chatTranscript');
    for (const e of history) {
        await db.insert(schema.sessionChatMessages).values({
            sessionId: id,
            seq: e.seq,
            ts: e.ts,
            role: e.role,
            content: e.content,
        });
    }

    let prompt = '';
    analyzeClient.chatJson = async (params) => { prompt = params.user; return GOOD_SUMMARY; };

    await svc.summarizeSession(id);

    // 落库全量：session_conversations.turns 存满 120 条
    const row = await db.select().from(schema.sessionConversations)
        .where(eq(schema.sessionConversations.sessionId, id));
    assert.equal(Array.isArray(row[0].turns) ? row[0].turns.length : 0, 120);

    // prompt 只喂最近 100 条（msg21..msg120），不包含最早的 msg1..msg20
    assert.ok(prompt.includes('user: msg120'));
    assert.ok(prompt.includes('user: msg21'));
    assert.ok(!prompt.includes('user: msg1\n'));
    assert.ok(!prompt.includes('user: msg20\n'));
});
