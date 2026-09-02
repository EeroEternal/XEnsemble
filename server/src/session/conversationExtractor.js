/**
 * Dual-source conversation extractor (T1.3).
 *
 * Extracts user↔agent turns from a session, in priority order:
 *   1. Preferred source: LLM proxy chat transcript (`session_chat_messages`,
 *      via chatTranscript) — structured user/assistant/tool messages.
 *   2. Agent-native state dir JSONL (Claude Code `projects/*.jsonl` format) —
 *      structured, includes tool names.
 *   3. Fallback source: transcript frames (works for every agent) —
 *      `in` frames are user turns, `out` frames aggregate into assistant
 *      turns on a 2s gap.
 *
 * Output contract: { source, turns: ConversationTurn[] }
 * ConversationTurn: { role, ts, text, tools?, truncated? }
 */

const { cleanTerminalText, truncateMiddle } = require('./terminalText');

const EXTRACTOR_VERSION = '1';
const MAX_TURNS = 100;
const ASSISTANT_GAP_MS = 2000;
const USER_GAP_MS = 3000;
// TUI 终端（opencode/Claude Code 等）会对每个按键毫秒级回显一个 out 帧；
// 距上次用户输入 < ECHO_GAP_MS 的 out 视为回显，跳过，避免把逐键输入拆成碎片。
const ECHO_GAP_MS = 500;
const TURN_MAX_BYTES = 8192;

// ---------------------------------------------------------------------------
// Chat transcript source (LLM proxy structured messages)
// ---------------------------------------------------------------------------

function chatHeadSeq(history) {
    let head = 0;
    for (const e of history || []) {
        const s = Number(e?.seq);
        if (Number.isFinite(s) && s > head) head = s;
    }
    return head;
}

/**
 * Extract turns from chatTranscript history rows.
 * user/assistant → plain turns; tool_call → assistant turn carrying the tool
 * name; tool_result rows are intermediate echoes and are skipped (the
 * assistant's final text already captures the outcome).
 *
 * @param {Array} history chatTranscript.getHistory() rows
 * @param {number} [afterSeq] only rows with seq > afterSeq
 * @returns {{ source: 'chat', turns: Array, headSeq: number }}
 */
function extractFromChat(history, afterSeq = 0) {
    const cursor = Number(afterSeq) || 0;
    const turns = [];
    // The assistant turn currently being aggregated. Tool calls attach here;
    // tool results pair back to their tool entry via callId.
    let pendingAssistant = null;
    const callMap = new Map(); // callId -> tool entry, for tool_result pairing

    const pushAssistantTurn = (ts) => {
        const turn = { role: 'assistant', ts, text: '', tools: [] };
        turns.push(turn);
        pendingAssistant = turn;
        return turn;
    };

    for (const e of history || []) {
        if (!e || typeof e !== 'object') continue;
        const seq = Number(e.seq);
        if (Number.isFinite(seq) && seq <= cursor) continue;
        const role = e.role;
        const raw = typeof e.content === 'string' ? e.content : '';
        if (role === 'user') {
            pendingAssistant = null;
            const text = raw.trim();
            if (!text) continue;
            const t = truncateMiddle(text, TURN_MAX_BYTES);
            turns.push({ role, ts: Number.isFinite(e.ts) ? e.ts : null, text: t.text, truncated: t.truncated });
        } else if (role === 'assistant') {
            const text = raw.trim();
            const t = truncateMiddle(text, TURN_MAX_BYTES);
            const turn = pushAssistantTurn(Number.isFinite(e.ts) ? e.ts : null);
            turn.text = t.text;
            turn.truncated = t.truncated;
        } else if (role === 'tool_call') {
            // Attach the call to the current assistant turn (create one if the
            // agent tool-called before emitting any text). Structured entry lets
            // the UI render a collapsible tool card with args + paired result.
            if (!pendingAssistant) pushAssistantTurn(Number.isFinite(e.ts) ? e.ts : null);
            const args = truncateMiddle(raw, TURN_MAX_BYTES);
            const entry = { tool: e.tool || 'tool', args: args.text };
            if (args.truncated) entry.argsTruncated = true;
            if (e.callId != null) {
                entry.callId = e.callId;
                callMap.set(e.callId, entry);
            }
            pendingAssistant.tools.push(entry);
        } else if (role === 'tool_result') {
            const entry = e.callId != null ? callMap.get(e.callId) : null;
            if (entry) {
                const res = truncateMiddle(raw, TURN_MAX_BYTES);
                entry.result = res.text;
                if (res.truncated) entry.resultTruncated = true;
            }
        }
    }

    // Drop assistant turns that carry neither text nor any tool call.
    const cleaned = turns.filter((t) => !(t.role === 'assistant' && !t.text && (!t.tools || t.tools.length === 0)));
    return { source: 'chat', turns: capTurns(cleaned), headSeq: chatHeadSeq(history) };
}

// ---------------------------------------------------------------------------
// Transcript source
// ---------------------------------------------------------------------------

/**
 * Extract turns from transcript frames.
 *
 * @param {object} transcriptStore
 * @param {string} streamRef
 * @param {number} [afterSeq] only frames with seq > afterSeq
 * @returns {{ source: 'transcript', turns: Array }}
 */
function extractFromTranscript(transcriptStore, streamRef, afterSeq = 0) {
    const frames = transcriptStore.readFrom(streamRef, afterSeq) || [];
    const turns = [];
    let current = null; // pending assistant turn being aggregated
    let pendingUser = null; // pending user turn being coalesced from keystroke-level in frames

    // 用户提交信号：回车/换行/Ctrl-C。TUI 终端的 in 帧逐键到达，
    // 只有遇到提交字符或长时间停顿才结束一个 user turn。
    const SUBMIT_RE = /[\r\n\u0003]/;

    const flushAssistant = () => {
        if (!current) return;
        const cleaned = cleanTerminalText(current.text);
        if (cleaned) {
            const { text, truncated } = truncateMiddle(cleaned, TURN_MAX_BYTES);
            turns.push({ role: 'assistant', ts: current.ts, text, tools: [], truncated });
        }
        current = null;
    };

    const flushUser = () => {
        if (!pendingUser) return;
        const cleaned = cleanTerminalText(pendingUser.text).trim();
        if (cleaned) {
            const { text, truncated } = truncateMiddle(cleaned, TURN_MAX_BYTES);
            turns.push({ role: 'user', ts: pendingUser.ts, text, truncated });
        }
        pendingUser = null;
    };

    for (const frame of frames) {
        if (frame.kind === 'in') {
            // Terminal input arrives per keystroke (or per IME commit), so
            // consecutive `in` frames coalesce into one user turn until the
            // user submits (Enter/Ctrl-C) or pauses past USER_GAP_MS.
            flushAssistant();
            const raw = typeof frame.data === 'string' ? frame.data : '';
            if (!raw) continue;
            if (pendingUser && frame.ts - pendingUser.lastTs > USER_GAP_MS) {
                flushUser();
            }
            if (!pendingUser) {
                pendingUser = { ts: frame.ts, lastTs: frame.ts, text: '' };
            }
            pendingUser.text += raw;
            pendingUser.lastTs = frame.ts;
            // Enter/Ctrl-C 提交 → 结束当前 user turn（剔除尾部提交字符）
            if (SUBMIT_RE.test(raw)) {
                pendingUser.text = pendingUser.text.replace(/[\r\n\u0003]+$/, '');
                flushUser();
            }
            continue;
        }
        if (frame.kind === 'out' && typeof frame.data === 'string') {
            // TUI 终端会对每个按键回显一个 out 帧（含 \r 重绘）。用户输入活跃期
            // （距上次 in 未超过 USER_GAP_MS）的 out 视为回显，跳过，避免把
            // 逐键输入拆成碎片。
            if (pendingUser && frame.ts - pendingUser.lastTs <= USER_GAP_MS) {
                continue;
            }
            flushUser();
            const ts = frame.ts;
            if (current && ts - current.lastTs > ASSISTANT_GAP_MS) {
                flushAssistant();
            }
            if (!current) {
                current = { ts, lastTs: ts, text: '' };
            }
            current.text += frame.data;
            current.lastTs = ts;
        }
    }
    flushUser();
    flushAssistant();

    return { source: 'transcript', turns: capTurns(turns) };
}

// ---------------------------------------------------------------------------
// State-dir source (Claude Code JSONL)
// ---------------------------------------------------------------------------

/**
 * Parse one Claude Code JSONL line into a ConversationTurn, or null.
 * Line shape: { type: 'user'|'assistant', message: { role, content }, timestamp }
 */
function parseStateDirLine(line) {
    let obj;
    try {
        obj = JSON.parse(line);
    } catch {
        return null;
    }
    if (!obj || typeof obj !== 'object') return null;

    const role = obj.type === 'user' ? 'user' : obj.type === 'assistant' ? 'assistant' : null;
    if (!role) return null;

    const content = obj.message?.content;
    let text = '';
    const tools = [];
    if (typeof content === 'string') {
        text = content;
    } else if (Array.isArray(content)) {
        const parts = [];
        for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'text' && typeof block.text === 'string') {
                parts.push(block.text);
            } else if (block.type === 'tool_use' && typeof block.name === 'string') {
                if (!tools.includes(block.name)) tools.push(block.name);
            }
        }
        text = parts.join('\n');
    }
    text = (text || '').trim();
    if (!text && tools.length === 0) return null;

    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Number(obj.timestamp);
    const { text: truncatedText, truncated } = truncateMiddle(text, TURN_MAX_BYTES);
    const turn = { role, ts: Number.isFinite(ts) ? ts : null, text: truncatedText, truncated };
    if (role === 'assistant' && tools.length) turn.tools = tools;
    return turn;
}

/**
 * Extract turns from a Claude Code state dir JSONL payload.
 *
 * @param {string} jsonl raw file content (one JSON object per line)
 * @returns {{ source: 'state_dir', turns: Array }}
 */
function extractFromStateDir(jsonl) {
    const turns = [];
    for (const line of String(jsonl || '').split('\n')) {
        if (!line.trim()) continue;
        const turn = parseStateDirLine(line);
        if (turn) turns.push(turn);
    }
    return { source: 'state_dir', turns: capTurns(turns) };
}

// ---------------------------------------------------------------------------
// Unified entry
// ---------------------------------------------------------------------------

function capTurns(turns) {
    if (turns.length <= MAX_TURNS) return turns;
    return turns.slice(turns.length - MAX_TURNS);
}

/**
 * Extract conversation turns for a session.
 *
 * @param {object} opts
 * @param {object} opts.transcriptStore
 * @param {string} opts.streamRef
 * @param {string|null} [opts.stateDirRef]
 * @param {Function} [opts.readStateDir] async (stateDirRef) => jsonl string; injected for testability
 * @param {Function} [opts.readChatHistory] async () => chatTranscript history rows; injected for testability
 * @param {number} [opts.afterSeq] cursor (chat transcript & transcript sources only)
 * @returns {Promise<{ source: string, turns: Array }>}
 */
async function extract({ transcriptStore, streamRef, stateDirRef, readStateDir, readChatHistory, afterSeq = 0 }) {
    if (typeof readChatHistory === 'function') {
        try {
            const history = await readChatHistory();
            if (Array.isArray(history) && history.length > 0) {
                return extractFromChat(history, afterSeq);
            }
        } catch {
            // fall through to state dir / transcript sources
        }
    }
    if (stateDirRef && typeof readStateDir === 'function') {
        try {
            const jsonl = await readStateDir(stateDirRef);
            if (jsonl) {
                const result = extractFromStateDir(jsonl);
                if (result.turns.length > 0) return result;
            }
        } catch {
            // fall through to transcript source
        }
    }
    return extractFromTranscript(transcriptStore, streamRef, afterSeq);
}

module.exports = {
    extract,
    extractFromChat,
    extractFromTranscript,
    extractFromStateDir,
    parseStateDirLine,
    EXTRACTOR_VERSION,
    MAX_TURNS,
};
