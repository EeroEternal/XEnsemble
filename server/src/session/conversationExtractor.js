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
function extractFromChat(history, afterSeq = 0, { maxTurns = MAX_TURNS } = {}) {
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
    const capped = maxTurns == null ? cleaned : capTurns(cleaned, maxTurns);
    return { source: 'chat', turns: capped, headSeq: chatHeadSeq(history) };
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
 * @param {object} [opts]
 * @param {number|null} [opts.maxTurns] 截断到最近 N 条；null 表示不截断（默认 MAX_TURNS）
 * @returns {{ source: 'transcript', turns: Array }}
 */
function extractFromTranscript(transcriptStore, streamRef, afterSeq = 0, { maxTurns = MAX_TURNS } = {}) {
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

    const capped = maxTurns == null ? turns : capTurns(turns, maxTurns);
    return { source: 'transcript', turns: capped };
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
 * @param {object} [opts]
 * @param {number|null} [opts.maxTurns] 截断到最近 N 条；null 表示不截断（默认 MAX_TURNS）
 * @returns {{ source: 'state_dir', turns: Array }}
 */
function extractFromStateDir(jsonl, { maxTurns = MAX_TURNS } = {}) {
    const turns = [];
    for (const line of String(jsonl || '').split('\n')) {
        if (!line.trim()) continue;
        const turn = parseStateDirLine(line);
        if (turn) turns.push(turn);
    }
    const capped = maxTurns == null ? turns : capTurns(turns, maxTurns);
    return { source: 'state_dir', turns: capped };
}

// ---------------------------------------------------------------------------
// Unified entry
// ---------------------------------------------------------------------------

function capTurns(turns, max = MAX_TURNS) {
    if (turns.length <= max) return turns;
    return turns.slice(turns.length - max);
}

// ---------------------------------------------------------------------------
// Trajectory source (0029) — preferred: full verbatim model calls
// ---------------------------------------------------------------------------

/** Extract text from anthropic-style content blocks (string or block array). */
function textFromBlocks(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const b of content) {
        if (typeof b === 'string') parts.push(b);
        else if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    return parts.join('\n');
}

/**
 * Extract turns from trajectory rows (session_trajectory, seq order).
 * Replays snapshot/delta rows into per-call context (via llm/trajectory
 * replayToFull) but only consumes messages not yet processed — agent CLIs
 * resend the full history on every call, so structural prefix alignment keeps
 * each user/assistant/tool message contributing exactly one turn.
 *
 * Dedupe is purely structural (common prefix against consumed history) — no
 * content classification: CLI-injected / synthetic user messages are recorded
 * and shown verbatim, and real user messages are never skipped even when a
 * bypass call (suggestion generation, memory consolidation) interleaves.
 *
 * Both wire formats are handled per-message: OpenAI (role:'tool' results)
 * and Anthropic (tool_result blocks inside user messages).
 *
 * @param {Array} steps trajectory.getAllSteps() rows
 * @param {object} [opts]
 * @param {number|null} [opts.maxTurns]
 * @returns {{ source: 'trajectory', turns: Array }}
 */

/** 已消费消息的 JSON 串形式（公共前缀比对用）。 */
function stringifyMsg(msg) {
    try { return JSON.stringify(msg); } catch (_) { return String(msg); }
}

/**
 * incoming 与已消费历史的公共前缀长度。纯结构比对，不涉及任何内容分类。
 */
function commonPrefixLen(messages, consumed) {
    const n = Math.min(messages.length, consumed.length);
    let i = 0;
    while (i < n && stringifyMsg(messages[i]) === consumed[i]) i += 1;
    return i;
}

function extractFromTrajectory(steps, { maxTurns = MAX_TURNS } = {}) {
    const { replayToFull } = require('../llm/trajectory');
    const lines = replayToFull(steps || []);
    const turns = [];
    let pendingAssistant = null;
    const callMap = new Map(); // callId -> tools entry, for result pairing
    // 已消费消息的 JSON 串（镜像当前上下文链）。快照行与它做公共前缀对齐决定
    // 消费起点，替代旧的绝对游标：旁路调用（建议生成/记忆整理等）的分歧上下文
    // 会把绝对下标顶过真实用户消息，结构比对则不依赖任何内容分类。
    let consumed = [];

    const pushAssistantTurn = (ts) => {
        const turn = { role: 'assistant', ts, text: '', tools: [] };
        turns.push(turn);
        pendingAssistant = turn;
        return turn;
    };

    const addUserText = (text, ts) => {
        pendingAssistant = null;
        const trimmed = String(text || '').trim();
        // 不过滤：CLI 注入/合成的 role=user 内容原样成轮（轨迹忠实呈现），
        // 区分真实用户消息交由上层按需处理
        if (!trimmed) return;
        const t = truncateMiddle(trimmed, TURN_MAX_BYTES);
        turns.push({ role: 'user', ts, text: t.text, truncated: t.truncated });
    };

    const addToolCall = (name, args, callId, ts) => {
        // 同一次调用会先随 response 出现、再随下一次请求重放出现（agent 每轮重放
        // 上一条 assistant 消息）。按 callId 去重，保证工具调用只计一次。
        if (callId != null && callMap.has(callId)) return;
        if (!pendingAssistant) pushAssistantTurn(ts);
        const entry = { tool: name || 'tool', args: String(args ?? '') };
        if (entry.args.length > TURN_MAX_BYTES) {
            entry.args = entry.args.slice(0, TURN_MAX_BYTES);
            entry.argsTruncated = true;
        }
        if (callId != null) {
            entry.callId = callId;
            callMap.set(callId, entry);
        }
        pendingAssistant.tools.push(entry);
    };

    const addToolResult = (callId, result) => {
        const entry = callId != null ? callMap.get(callId) : null;
        if (!entry) return;
        const res = truncateMiddle(String(result ?? ''), TURN_MAX_BYTES);
        entry.result = res.text;
        if (res.truncated) entry.resultTruncated = true;
    };

    // Emit the call's normalized response as an assistant turn. The next
    // request's history normally resends this message — we drop the pending
    // response when that resend is present (dedupe), and only emit it for the
    // final call (whose reply has no following request) or when the agent
    // rewrote history (compaction).
    let pendingResp = null;
    let pendingRespTs = null;
    const emitResponse = (resp, ts) => {
        if (!resp || !Array.isArray(resp.content)) return;
        const text = [];
        const tools = [];
        for (const b of resp.content) {
            if (b?.type === 'text' && b.text) text.push(b.text);
            else if (b?.type === 'tool_use') tools.push(b);
        }
        if (!text.length && !tools.length) return;
        const t = truncateMiddle(text.join('\n').trim(), TURN_MAX_BYTES);
        const turn = pushAssistantTurn(ts);
        turn.text = t.text;
        turn.truncated = t.truncated;
        for (const block of tools) {
            let args = '';
            try { args = JSON.stringify(block.input ?? {}); } catch (_) { args = ''; }
            addToolCall(block.name, args, block.id ?? null, ts);
        }
    };

    for (const line of lines) {
        const req = line.request;
        if (!req || !Array.isArray(req.messages)) continue;
        // 消费起点：delta 行（非快照）的 messages 已由 proxy 前缀比对保证全是
        // 新增，全量消费；快照行与已消费历史求公共前缀——前缀之后都是本链尚未
        // 消费的消息（含被旁路调用顶乱下标的真实消息）。历史整体缩短（压缩重写）
        // 时全部视为已呈现过，仅把基线重置为新链，避免旧尾部重复成轮。
        const isDelta = Array.isArray(line.delta_messages);
        const messages = isDelta ? line.delta_messages : req.messages;
        const ts = Number.isFinite(line.ts) ? line.ts : null;
        let start = 0;
        if (isDelta) {
            consumed = consumed.concat(messages.map(stringifyMsg));
        } else if (messages.length < consumed.length) {
            start = messages.length;
            consumed = messages.map(stringifyMsg);
        } else {
            start = commonPrefixLen(messages, consumed);
            consumed = messages.map(stringifyMsg);
        }
        // Resolve the previous call's pending response: delta 行不重发历史，
        // 上一次响应直接落为助手轮；snapshot 行先探测消费起点处是否为重发的
        // assistant 消息，是则丢弃 pending 副本避免重复。
        if (pendingResp) {
            let emitIt = true;
            if (!isDelta) {
                const histMsg = (start >= 0 && start < messages.length) ? messages[start] : null;
                if (histMsg && histMsg.role === 'assistant') emitIt = false;
            }
            if (emitIt) emitResponse(pendingResp, pendingRespTs);
            pendingResp = null;
        }
        for (let i = 0; i < messages.length; i += 1) {
            if (!isDelta && i < start) continue;
            const msg = messages[i];
            if (!msg || typeof msg !== 'object') continue;
            const content = msg.content;

            if (msg.role === 'user' || msg.role === 'human') {
                // Anthropic: tool results ride inside user messages — pair them
                // instead of emitting a user turn.
                if (Array.isArray(content)) {
                    let userText = '';
                    for (const b of content) {
                        if (b?.type === 'tool_result') {
                            addToolResult(b.tool_use_id ?? b.call_id ?? null, textFromBlocks(b.content));
                        } else if (b?.type === 'text' && typeof b.text === 'string') {
                            userText += (userText ? '\n' : '') + b.text;
                        }
                    }
                    if (userText.trim()) addUserText(userText, ts);
                } else {
                    addUserText(typeof content === 'string' ? content : '', ts);
                }
            } else if (msg.role === 'assistant') {
                const parts = [];
                if (typeof content === 'string' && content) parts.push(content);
                else if (Array.isArray(content)) {
                    for (const b of content) {
                        if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
                        // thinking blocks are skipped — decisions land in the text
                    }
                }
                const calls = msg.tool_calls || [];
                if (!parts.length && !calls.length) continue;
                const text = truncateMiddle(parts.join('\n').trim(), TURN_MAX_BYTES);
                if (parts.length) {
                    const turn = pushAssistantTurn(ts);
                    turn.text = text.text;
                    turn.truncated = text.truncated;
                }
                for (const tc of calls) {
                    addToolCall(tc?.function?.name, tc?.function?.arguments, tc?.id ?? null, ts);
                }
                // Anthropic assistant blocks: tool_use inline
                if (Array.isArray(content)) {
                    for (const b of content) {
                        if (b?.type === 'tool_use') {
                            let args = '';
                            try { args = JSON.stringify(b.input ?? {}); } catch (_) { args = ''; }
                            addToolCall(b.name, args, b.id ?? null, ts);
                        }
                    }
                }
            } else if (msg.role === 'tool') {
                // OpenAI tool result
                addToolResult(msg.tool_call_id ?? null, typeof content === 'string' ? content : textFromBlocks(content));
            }
        }
        pendingResp = line.response;
        pendingRespTs = ts;
    }
    // The final call's reply never appears in a later request — emit it here.
    emitResponse(pendingResp, pendingRespTs);

    // Drop assistant turns that carry neither text nor any tool call.
    const cleaned = turns.filter((t) => !(t.role === 'assistant' && !t.text && (!t.tools || t.tools.length === 0)));
    const capped = maxTurns == null ? cleaned : capTurns(cleaned, maxTurns);
    return { source: 'trajectory', turns: capped };
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
 * @param {Function} [opts.readTrajectorySteps] async () => trajectory rows (session_trajectory); injected for testability
 * @param {number} [opts.afterSeq] cursor (chat transcript & transcript sources only)
 * @param {number|null} [opts.maxTurns] 各来源统一截断到最近 N 条；null 表示不截断（默认 MAX_TURNS）
 * @returns {Promise<{ source: string, turns: Array }>}
 */
async function extract({ transcriptStore, streamRef, stateDirRef, readStateDir, readChatHistory, readTrajectorySteps, afterSeq = 0, maxTurns = MAX_TURNS }) {
    // Preferred source: trajectory (0029) — full verbatim model calls with
    // complete tool args/results; the chat transcript is the realtime/降级 view.
    if (typeof readTrajectorySteps === 'function') {
        try {
            const steps = await readTrajectorySteps();
            if (Array.isArray(steps) && steps.length > 0) {
                const result = extractFromTrajectory(steps, { maxTurns });
                if (result.turns.length > 0) return result;
            }
        } catch {
            // fall through to chat history / state dir / transcript sources
        }
    }
    if (typeof readChatHistory === 'function') {
        try {
            const history = await readChatHistory();
            if (Array.isArray(history) && history.length > 0) {
                return extractFromChat(history, afterSeq, { maxTurns });
            }
        } catch {
            // fall through to state dir / transcript sources
        }
    }
    if (stateDirRef && typeof readStateDir === 'function') {
        try {
            const jsonl = await readStateDir(stateDirRef);
            if (jsonl) {
                const result = extractFromStateDir(jsonl, { maxTurns });
                if (result.turns.length > 0) return result;
            }
        } catch {
            // fall through to transcript source
        }
    }
    return extractFromTranscript(transcriptStore, streamRef, afterSeq, { maxTurns });
}

module.exports = {
    extract,
    extractFromChat,
    extractFromTrajectory,
    extractFromTranscript,
    extractFromStateDir,
    parseStateDirLine,
    EXTRACTOR_VERSION,
    MAX_TURNS,
};
