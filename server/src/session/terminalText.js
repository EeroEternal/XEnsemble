/**
 * Terminal text cleaning utilities shared by title generation and
 * conversation extraction. Extracted from titleService.js (T1.1).
 */

// ANSI CSI 序列（真实 ESC 字节 \x1b）
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g;
// caret 记法的 CSI 序列（如 ^[[I、^[[?1;2c）——字面 "^[" 文本，而非真实 ESC 字节。
// 某些 TUI 采集路径会把转义序列以 caret 记法落盘，需与真实 ESC 一并剥离。
// eslint-disable-next-line no-control-regex
const CARET_CSI_RE = /\^\[\[[0-9;:<=>?]*[ -/]*[@-~]/g;
// Charset designation (ESC ( B, ESC ) 0)
// eslint-disable-next-line no-control-regex
const CHARSET_RE = /\x1b[()][0-9A-Za-z]/g;
// OSC sequences (e.g. window title: \x1b]0;title\x07)
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Other 2-char escape sequences: DEC cursor save/restore (ESC 7 / ESC 8),
// keypad mode (ESC = / ESC >), terminal reset (ESC c).
// eslint-disable-next-line no-control-regex
const SIMPLE_ESC_RE = /\x1b[=>0-9A-Za-z]/g;
// Remaining control chars except \n and \t
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

function stripAnsi(input) {
    if (!input) return '';
    return input
        .replace(OSC_RE, '')
        .replace(ANSI_CSI_RE, '')
        .replace(CARET_CSI_RE, '')
        .replace(CHARSET_RE, '')
        .replace(SIMPLE_ESC_RE, '')
        .replace(CONTROL_RE, '');
}

/**
 * Clean raw terminal output (TUI agent incremental redraws) into readable
 * plain text:
 *   1. split lines on \n
 *   2. within each line, split on \r and keep the LAST segment (carriage
 *      return overwrites the line start — spinner/progress redraws)
 *   3. strip ANSI/OSC/control sequences
 *   4. collapse consecutive identical lines (frame redraws)
 *   5. collapse consecutive blank lines
 */
function cleanTerminalText(raw) {
    if (!raw) return '';
    const lines = String(raw).split('\n');
    const cleaned = [];
    let prevNonEmpty = null;
    let blankRun = 0;

    for (const line of lines) {
        // \r overwrite semantics: keep the last segment
        let text = line;
        const crIdx = line.lastIndexOf('\r');
        if (crIdx >= 0) text = line.slice(crIdx + 1);

        text = stripAnsi(text);

        if (!text.trim()) {
            blankRun += 1;
            if (blankRun <= 1) cleaned.push('');
            continue;
        }
        blankRun = 0;

        // Collapse consecutive identical non-empty lines (TUI frame redraws)
        if (text === prevNonEmpty) continue;
        prevNonEmpty = text;
        cleaned.push(text);
    }

    return cleaned.join('\n').trim();
}

/**
 * Truncate over-long text keeping head and tail, marking the elided middle.
 * Cuts at UTF-8 character boundaries (never splits a multibyte sequence).
 */
function truncateMiddle(text, maxBytes = 8192) {
    if (!text) return { text: '', truncated: false };
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes) return { text, truncated: false };

    const marker = (omitted) => `\n…(truncated ${omitted} chars)\n`;
    // Reserve room for the marker itself
    const markerBytes = Buffer.byteLength(marker(0));
    const budget = Math.max(0, maxBytes - markerBytes);
    const half = Math.floor(budget / 2);

    const headEnd = utf8Boundary(buf, half);
    const tailStart = utf8Boundary(buf, buf.length - half, true);

    const head = buf.subarray(0, headEnd).toString('utf8');
    const tail = buf.subarray(tailStart).toString('utf8');
    const omitted = text.length - head.length - tail.length;
    return { text: head + marker(omitted) + tail, truncated: true };
}

/**
 * Move a byte offset to a UTF-8 character boundary. When `backward` is true,
 * walk back to the start of the character containing the offset; otherwise
 * walk forward to the start of the next character.
 */
function utf8Boundary(buf, offset, backward = false) {
    let i = Math.max(0, Math.min(offset, buf.length));
    if (backward) {
        // Walk back while we are inside a continuation byte (10xxxxxx)
        while (i > 0 && (buf[i] & 0xc0) === 0x80) i -= 1;
        return i;
    }
    // Walk forward while the byte at i is a continuation byte
    while (i < buf.length && (buf[i] & 0xc0) === 0x80) i += 1;
    return i;
}

module.exports = {
    stripAnsi,
    cleanTerminalText,
    truncateMiddle,
};
