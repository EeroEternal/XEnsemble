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

test('inferCompacted true when history is compacted', async () => {
    const { inferCompacted } = require('./signals');
    const sessionId = `sess_signals_${randomUUID()}`;
    const prev = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
    ];
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
    assert.ok(trajectory.getPrevMessages(sessionId));
    assert.equal(
        inferCompacted(sessionId, [{ role: 'user', content: 'compacted' }]),
        true,
    );
    const appended = [...prev, { role: 'assistant', content: 'd' }, { role: 'user', content: 'e' }];
    assert.equal(inferCompacted(sessionId, appended), false);
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
