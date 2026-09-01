const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripAnsi, cleanTerminalText, truncateMiddle } = require('./terminalText');

test('stripAnsi removes CSI color sequences', () => {
    const input = '\x1b[32mOK\x1b[0m done';
    assert.equal(stripAnsi(input), 'OK done');
});

test('stripAnsi removes OSC title sequences', () => {
    const input = '\x1b]0;opencode\x07real content';
    assert.equal(stripAnsi(input), 'real content');
});

test('stripAnsi removes SGR mouse events (CSI with <)', () => {
    assert.equal(stripAnsi('\x1b[<35;114;13M'), '');
    assert.equal(stripAnsi('\x1b[<0;61;23m'), '');
});

test('stripAnsi removes device attribute queries (CSI with ?)', () => {
    assert.equal(stripAnsi('\x1b[?1;2c'), '');
    assert.equal(stripAnsi('\x1b[?2026h\x1b[?25l   '), '   ');
});

test('stripAnsi removes caret-notation CSI sequences (literal ^[[ text)', () => {
    assert.equal(stripAnsi('^[[I'), '');
    assert.equal(stripAnsi('^[[?1;2c'), '');
    assert.equal(stripAnsi('^[[I^[[?1;2c^[[I'), '');
    assert.equal(stripAnsi('real^[[Itext'), 'realtext');
});

test('stripAnsi removes charset designation and simple 2-char escapes', () => {
    assert.equal(stripAnsi('\x1b(B'), '');
    assert.equal(stripAnsi('\x1b7'), '');
    assert.equal(stripAnsi('\x1b='), '');
});

test('stripAnsi removes remaining control chars but keeps \\n and \\t', () => {
    const input = 'a\x00b\x07c\td\ne';
    assert.equal(stripAnsi(input), 'abc\td\ne');
});

test('stripAnsi handles empty/null input', () => {
    assert.equal(stripAnsi(''), '');
    assert.equal(stripAnsi(null), '');
});

test('cleanTerminalText keeps last segment of \\r-overwritten lines (spinner)', () => {
    // A spinner redraws the same line: "Loading 10%\rLoading 50%\rLoading 99%"
    const raw = 'Loading 10%\rLoading 50%\rLoading 99%\nDone';
    assert.equal(cleanTerminalText(raw), 'Loading 99%\nDone');
});

test('cleanTerminalText collapses consecutive identical lines (frame redraws)', () => {
    const raw = 'Analyzing files...\nAnalyzing files...\nAnalyzing files...\nResult: 3 files';
    assert.equal(cleanTerminalText(raw), 'Analyzing files...\nResult: 3 files');
});

test('cleanTerminalText collapses consecutive blank lines', () => {
    const raw = 'a\n\n\n\nb';
    assert.equal(cleanTerminalText(raw), 'a\n\nb');
});

test('cleanTerminalText strips ANSI inside lines', () => {
    const raw = '\x1b[1m\x1b[32mSuccess\x1b[0m\nnext';
    assert.equal(cleanTerminalText(raw), 'Success\nnext');
});

test('cleanTerminalText handles mixed \\r + ANSI + redraw', () => {
    const raw = '\x1b[?25l\r\x1b[2K\x1b[1m⠋\x1b[0m thinking\r\x1b[2K\x1b[1m⠙\x1b[0m thinking\r\x1b[2Kdone';
    const out = cleanTerminalText(raw);
    assert.ok(out.includes('done'));
    assert.ok(!out.includes('⠋'));
    assert.ok(!out.includes('\x1b'));
});

test('cleanTerminalText trims leading/trailing whitespace', () => {
    assert.equal(cleanTerminalText('  \n hello \n  '), 'hello');
});

test('truncateMiddle returns unchanged when under limit', () => {
    const res = truncateMiddle('short', 100);
    assert.equal(res.text, 'short');
    assert.equal(res.truncated, false);
});

test('truncateMiddle keeps head and tail with marker', () => {
    const long = 'A'.repeat(3000) + 'B'.repeat(3000); // 6000 chars
    const res = truncateMiddle(long, 1000);
    assert.equal(res.truncated, true);
    assert.ok(res.text.startsWith('AAAA'));
    assert.ok(res.text.endsWith('BBBB'));
    assert.ok(res.text.includes('truncated'));
    // marker reports omitted char count (positive)
    const m = res.text.match(/truncated (\d+) chars/);
    assert.ok(m);
    assert.ok(Number(m[1]) > 0);
});

test('truncateMiddle handles multibyte safely (no broken chars)', () => {
    const long = '你好'.repeat(5000); // 10000 chars, 30000 bytes
    const res = truncateMiddle(long, 1000);
    assert.equal(res.truncated, true);
    // No replacement chars from splitting a multibyte sequence
    assert.ok(!res.text.includes('\uFFFD'));
});

test('truncateMiddle handles empty input', () => {
    assert.deepEqual(truncateMiddle('', 100), { text: '', truncated: false });
});
