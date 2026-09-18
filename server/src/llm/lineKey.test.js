const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lineKeyOf } = require('./lineKey');

test('lineKeyOf is stable for the same line and differs across lines', () => {
    const sys = { role: 'system', content: 'You are Kimi Code CLI' };
    const lineA = [sys, { role: 'user', content: '审计 DB 迁移风险' }, { role: 'assistant', content: 'ok' }];
    const lineA2 = [...lineA, { role: 'user', content: '继续' }];
    const lineB = [sys, { role: 'user', content: '审计前端风险' }, { role: 'assistant', content: 'ok' }];

    // 同一线追加消息后指纹不变
    assert.equal(lineKeyOf(lineA), lineKeyOf(lineA2));
    // 不同线（首条 user 不同）指纹不同
    assert.notEqual(lineKeyOf(lineA), lineKeyOf(lineB));
});

test('lineKeyOf returns empty string for empty or content-less messages', () => {
    assert.equal(lineKeyOf([]), '');
    assert.equal(lineKeyOf(null), '');
    assert.equal(lineKeyOf([{}, {}]), '');
});
