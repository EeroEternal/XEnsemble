const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseApprovalState } = require('./approvalState');

// runner.stripAnsi 同款清理（parseApprovalState 的入参约定：已去 ANSI + 小写）
const prep = (text) => String(text)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .toLowerCase();

const paint = (s) => `\x1b[2m${s}\x1b[22m (Shift+Tab)`;
const ENABLED = paint('⏵⏵ Auto-approve all enabled');
const DISABLED = paint('Auto-approve all disabled');

test('parseApprovalState reads the enabled state string', () => {
    assert.equal(parseApprovalState(prep(ENABLED)), true);
});

test('parseApprovalState reads the disabled state string', () => {
    assert.equal(parseApprovalState(prep(DISABLED)), false);
});

test('parseApprovalState returns null when neither string is present', () => {
    // 事故现场：扫描窗口内只有 ClinePass 促销弹窗正文，无状态栏重绘
    assert.equal(parseApprovalState(prep('Try ClinePass\nClinePass is a $9.99/month subscription plan')), null);
    assert.equal(parseApprovalState(''), null);
});

test('parseApprovalState: the later repaint wins (dismiss redraw then toggle redraw)', () => {
    // Esc 关弹窗 → 主屏重绘仍是 enabled；250ms 后 Shift+Tab 生效 → disabled 重绘。
    // 两段重绘落入同一扫描窗口（旧实现 includes('enabled') 会误读中间态）。
    assert.equal(parseApprovalState(prep([ENABLED, DISABLED].join(''))), false);
});

test('parseApprovalState: the later repaint wins (reverse order)', () => {
    assert.equal(parseApprovalState(prep([DISABLED, ENABLED].join(''))), true);
});

test('parseApprovalState: promo dialog frames between repaints do not shift the verdict', () => {
    const promo = 'ClinePass is a $9.99/month subscription plan\nTry it now with a limited-time promo for $4.99.';
    assert.equal(parseApprovalState(prep([ENABLED, promo, DISABLED].join(''))), false);
});
