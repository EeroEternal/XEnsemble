const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { eq } = require('drizzle-orm');

process.env.LLM_ANALYZE_API_KEY = 'test-key';

const { bootstrapTestDb } = require('../test/db');

let ctx;
let db;
let schema;
let sessionManager;
let transcriptStore;
let analyzeClient;
let autoSummarizer;
let summaryService;

before(async () => {
    ctx = await bootstrapTestDb([
        '../db/index',
        '../runtime/TranscriptStore',
        '../llm/analyzeClient',
        './SessionManager',
        './conversationSummaryService',
        './conversationAutoSummarizer',
    ], __dirname);
    ({ db, schema } = ctx);
    sessionManager = ctx.reloaded['./SessionManager'];
    transcriptStore = ctx.reloaded['../runtime/TranscriptStore'];
    analyzeClient = ctx.reloaded['../llm/analyzeClient'];
    summaryService = ctx.reloaded['./conversationSummaryService'];
    autoSummarizer = ctx.reloaded['./conversationAutoSummarizer'];
});

after(async () => {
    delete process.env.LLM_ANALYZE_API_KEY;
    if (ctx) await ctx.teardown();
});

class FakeHandle {
    constructor(streamRef) {
        this.streamRef = streamRef;
        this.dataListeners = new Set();
        this.exitListeners = new Set();
    }

    onData(cb) {
        this.dataListeners.add(cb);
        return { dispose: () => this.dataListeners.delete(cb) };
    }

    onExit(cb) {
        this.exitListeners.add(cb);
        return () => this.exitListeners.delete(cb);
    }

    write() {}
    resize() {}
    kill() {}
    async getMetrics() { return { cpu: 0, memory: 0 }; }

    emitData(data, rseq) {
        for (const cb of [...this.dataListeners]) cb(data, rseq);
    }

    emitExit(exitCode = 0, signal = null) {
        for (const cb of [...this.exitListeners]) cb({ exitCode, signal });
    }
}

async function makeSession() {
    const sessionId = `sess_auto_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const userId = `usr_auto_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const streamRef = `local:pty:${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await db.insert(schema.users).values({
        id: userId,
        username: `auto_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        passwordHash: 'hash',
        role: 'user',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    await db.insert(schema.sessions).values({
        id: sessionId,
        userId,
        agentId: 'claude-code',
        cwd: '/tmp',
        status: 'running',
        streamRef,
        createdAt: Date.now(),
    });
    return { sessionId, streamRef };
}

const GOOD_SUMMARY = {
    overview: 'fixed login',
    turns: [{ role: 'user', summary: 'asked to fix login' }],
    keyDecisions: [],
    filesTouched: [],
};

test('auto summarizer does not summarize during output (exit-only)', async () => {
    const { sessionId, streamRef } = await makeSession();
    const handle = new FakeHandle(streamRef);

    analyzeClient.chatJson = async () => GOOD_SUMMARY;
    autoSummarizer.start();

    sessionManager.createSession(sessionId, handle, 'claude-code');
    handle.emitData('user: fix login\n', 1);
    handle.emitData('assistant: editing auth.js\n', 2);

    // A+B: no LLM call while the session runs.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const rows = await db.select().from(schema.sessionConversations)
        .where(eq(schema.sessionConversations.sessionId, sessionId));
    assert.equal(rows.length, 0);

    autoSummarizer.stop();
});

test('auto summarizer persists turns on exit even when LLM fails', async () => {
    const { sessionId, streamRef } = await makeSession();
    const handle = new FakeHandle(streamRef);

    analyzeClient.chatJson = async () => {
        const err = new Error('LLM returned invalid JSON');
        err.code = 'llm_request_failed';
        throw err;
    };

    autoSummarizer.start();
    sessionManager.createSession(sessionId, handle, 'claude-code');
    handle.emitData('fix this\n', 1);
    handle.emitExit(0);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const rows = await db.select().from(schema.sessionConversations)
        .where(eq(schema.sessionConversations.sessionId, sessionId));
    assert.equal(rows.length, 1);
    assert.ok(rows[0].turns.length > 0);
    assert.equal(rows[0].errorCount, 1);

    autoSummarizer.stop();
});

test('auto summarizer runs final summarize on exit', async () => {
    const { sessionId, streamRef } = await makeSession();
    const handle = new FakeHandle(streamRef);

    analyzeClient.chatJson = async () => GOOD_SUMMARY;
    autoSummarizer.start();

    sessionManager.createSession(sessionId, handle, 'claude-code');
    handle.emitData('fix this\n', 1);
    handle.emitExit(0);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const rows = await db.select().from(schema.sessionConversations)
        .where(eq(schema.sessionConversations.sessionId, sessionId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].summary.overview, 'fixed login');

    autoSummarizer.stop();
});
