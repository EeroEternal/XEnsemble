const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const trajectory = require('../trajectory');

test('logicalModelFromBody prefers request model over session default', () => {
    const { logicalModelFromBody } = require('./signals');
    assert.equal(logicalModelFromBody(
        { model: 'anthropic.acme/deepseek-chat' },
        { tokenModel: 'other/other', agentPrimaryModel: 'primary' },
    ), 'deepseek-chat');
});

test('logicalModelFromBody falls back to token then agent primary', () => {
    const { logicalModelFromBody } = require('./signals');
    assert.equal(logicalModelFromBody(
        {},
        { tokenModel: 'other/other', agentPrimaryModel: 'primary' },
    ), 'other/other');
    assert.equal(logicalModelFromBody(
        { model: '' },
        { tokenModel: '', agentPrimaryModel: 'primary' },
    ), 'primary');
    assert.equal(logicalModelFromBody({}, {}), '');
});

test('inferCompacted false on first turn', () => {
    const { inferCompacted } = require('./signals');
    assert.equal(inferCompacted('no-such-session', [{ role: 'user', content: 'hi' }]), false);
});

test('inferCompacted true when history is compacted on the same line', async () => {
    const { inferCompacted } = require('./signals');
    const sessionId = `sess_signals_${randomUUID()}`;
    // 压缩保留 system 与首条 user（同线），只把中间历史改短
    const sys = { role: 'system', content: 'You are Kimi Code CLI' };
    const head = { role: 'user', content: 'audit server risk' };
    const prev = [sys, head, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    const origError = console.error;
    console.error = () => {};
    try {
        await trajectory.recordRequest({
            sessionId,
            agentId: 'agent-test',
            model: 'deepseek-chat',
            body: { model: 'deepseek-chat', messages: prev },
        });
    } finally {
        console.error = origError;
    }
    // 同线但历史被改短 → 压缩
    assert.equal(
        inferCompacted(sessionId, [sys, head, { role: 'assistant', content: 'compacted' }]),
        true,
    );
    // 同线追加 → 非压缩
    const appended = [...prev, { role: 'assistant', content: 'd' }, { role: 'user', content: 'e' }];
    assert.equal(inferCompacted(sessionId, appended), false);
    // 不同线（首条 user 变了）→ 新线，非压缩
    assert.equal(
        inferCompacted(sessionId, [sys, { role: 'user', content: 'audit web risk' }]),
        false,
    );
});

test('collectSignals derives counts, chars, and last usage', () => {
    const { collectSignals } = require('./signals');
    const sessionId = `sess_signals_${randomUUID()}`;
    const body = {
        model: 'anthropic.acme/deepseek-chat',
        messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: { n: 1 } },
            { role: 'user', content: 'next' },
        ],
    };
    const sig = collectSignals({
        sessionId,
        body,
        tokenModel: 'other/other',
        agentPrimaryModel: 'primary',
        lastUsage: { promptTokens: 100, cachedTokens: 40 },
    });
    assert.equal(sig.sessionId, sessionId);
    assert.equal(sig.logicalModel, 'deepseek-chat');
    assert.equal(sig.msgCount, 3);
    assert.equal(sig.promptChars, 'hello'.length + JSON.stringify({ n: 1 }).length + 'next'.length);
    assert.equal(sig.prefixMsgCount, 2);
    assert.equal(sig.compacted, false);
    assert.equal(sig.lastCachedTokens, 40);
    assert.equal(sig.lastPromptTokens, 100);
});

test('collectSignals lastUsage is null-safe', () => {
    const { collectSignals } = require('./signals');
    const sig = collectSignals({
        sessionId: 's1',
        body: { messages: [{ role: 'user', content: 'x' }] },
        lastUsage: null,
    });
    assert.equal(sig.lastCachedTokens, null);
    assert.equal(sig.lastPromptTokens, null);
    assert.equal(sig.logicalModel, '');
    assert.equal(sig.msgCount, 1);
    assert.equal(sig.prefixMsgCount, 0);
    assert.equal(sig.promptChars, 1);
});

test('parallel lines in one session do not cross-contaminate compaction', async () => {
    const { collectSignals } = require('./signals');
    const sessionId = `sess_lines_${randomUUID()}`;
    const sys = { role: 'system', content: 'You are Kimi Code CLI' };
    const lineA = [sys, { role: 'user', content: 'audit server risk' }];
    const lineB = [sys, { role: 'user', content: 'audit web risk' }];
    const a2 = [...lineA, { role: 'assistant', content: 'r' }, { role: 'user', content: 'next' }];

    const origError = console.error;
    console.error = () => {};
    try {
        // 两条线交替下发：A1 → B1 → A2
        await trajectory.recordRequest({
            sessionId, agentId: 'agent-test', model: 'glm-5.3-flash',
            body: { model: 'glm-5.3-flash', messages: lineA },
        });
        await trajectory.recordRequest({
            sessionId, agentId: 'agent-test', model: 'glm-5.3-flash',
            body: { model: 'glm-5.3-flash', messages: lineB },
        });
        await trajectory.recordRequest({
            sessionId, agentId: 'agent-test', model: 'glm-5.3-flash',
            body: { model: 'glm-5.3-flash', messages: a2 },
        });
    } finally {
        console.error = origError;
    }

    // B 线的第二轮：中间夹了 A 线，仍应识别为同线追加（非压缩）
    const b2 = [...lineB, { role: 'assistant', content: 'r' }, { role: 'user', content: 'next' }];
    assert.equal(collectSignals({ sessionId, body: { messages: b2 } }).compacted, false);

    // 全新的 C 线：该线无历史 → 不是压缩（走 first_turn）
    const lineC = [sys, { role: 'user', content: 'audit deploy risk' }];
    assert.equal(collectSignals({ sessionId, body: { messages: lineC } }).compacted, false);

    // A 线内部历史被改写变短（同线、前缀一致但更短）→ 判定为压缩
    assert.equal(
        collectSignals({ sessionId, body: { messages: lineA } }).compacted,
        true,
    );
});
