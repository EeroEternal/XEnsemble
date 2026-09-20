/**
 * Conversation summary service (A+B).
 *
 * A. Turns are served live from the LLM proxy's structured chat transcript
 *    (`session_chat_messages`) — no LLM involved. Falls back to stored turns
 *    (from agent state dir / terminal transcript) when no chat transcript
 *    exists yet (e.g. old sessions).
 * B. The LLM is called only to produce the summary fields — overview,
 *    keyDecisions, filesTouched — once (typically at session exit, or on
 *    manual Refresh with force).
 *
 * Failure semantics: LLM failure increments error_count, records last_error;
 * raw turns are still persisted so the turn list stays intact.
 */

const { eq } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');
const analyzeClient = require('../llm/analyzeClient');
const chatTranscript = require('../llm/chatTranscript');
const extractor = require('./conversationExtractor');

const MAX_FILES_TOUCHED = 20;
// 推理模型的思维链与正文共享 max_tokens，2000 在长会话下易被思维链吃光导致截断。
const SUMMARY_MAX_TOKENS = 4096;
// 摘要 prompt 的 turns 渲染预算：单条 turn 文本最长 TURN_MAX_BYTES(8KB)，
// 100 条理论可达 ~800KB，会直接撑爆上下文。超出则从最早 turn 开始丢弃，
// 保留最近的对话（与 skillExtractor 的 renderTurns 同策略）。
const SUMMARY_PROMPT_CHAR_BUDGET = 24000;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const OUTPUT_SPEC = [
    'Output ONLY a JSON object with this exact shape:',
    '{',
    '  "overview": "one-sentence summary of the whole conversation",',
    '  "keyDecisions": ["decision 1", "decision 2"],',
    '  "filesTouched": ["path/to/file.js"]',
    '}',
    'Rules:',
    `- "filesTouched" must contain at most ${MAX_FILES_TOUCHED} paths.`,
    '- Write the summary in the SAME LANGUAGE as the conversation.',
    '- Respond with the JSON object only, no markdown fences, no explanation.',
].join('\n');

function renderTurns(turns) {
    const rendered = turns.map((t, i) => {
        const tools = t.tools && t.tools.length
            ? ` [tools: ${t.tools.map((x) => (typeof x === 'string' ? x : x.tool || 'tool')).join(', ')}]`
            : '';
        return `#${i + 1} ${t.role}${tools}: ${t.text}`;
    });
    let total = rendered.reduce((n, s) => n + s.length + 1, 0);
    let start = 0;
    while (start < rendered.length - 1 && total > SUMMARY_PROMPT_CHAR_BUDGET) {
        total -= rendered[start].length + 1;
        start += 1;
    }
    const omitted = start > 0 ? `… (${start} earlier turns omitted)\n` : '';
    return omitted + rendered.slice(start).join('\n');
}

function buildFullPrompt(turns) {
    return [
        'You are summarizing a terminal session between a user and a coding agent.',
        'Summarize the conversation into a compact structured overview.',
        '',
        'Conversation turns:',
        renderTurns(turns),
        '',
        OUTPUT_SPEC,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate and normalize an LLM-produced summary object.
 * Returns the normalized summary, or null when invalid.
 * Only overview / keyDecisions / filesTouched are LLM-produced — turns are
 * served separately from the structured chat transcript.
 */
function validateSummary(summary) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
    if (typeof summary.overview !== 'string' || !summary.overview.trim()) return null;

    const keyDecisions = Array.isArray(summary.keyDecisions)
        ? summary.keyDecisions.filter((d) => typeof d === 'string' && d.trim()).slice(0, 20)
        : [];
    const filesTouched = Array.isArray(summary.filesTouched)
        ? summary.filesTouched.filter((f) => typeof f === 'string' && f.trim()).slice(0, MAX_FILES_TOUCHED)
        : [];

    return {
        overview: summary.overview.trim(),
        keyDecisions,
        filesTouched,
    };
}

// ---------------------------------------------------------------------------
// Core service
// ---------------------------------------------------------------------------

async function loadSession(sessionId) {
    const rows = await db
        .select({
            id: schema.sessions.id,
            streamRef: schema.sessions.streamRef,
            stateDirRef: schema.sessions.stateDirRef,
        })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);
    const session = rows[0] || null;
    if (!session) return null;

    // BoxLite 等执行面下，sessions.stream_ref 是会话级 handle，而持久化 transcript
    // 实际写在 session_streams.storage_ref（两者可能不同）。与其他消费方
    // （resumeSession / terminal replay）保持一致，优先取 storage_ref。
    const streamRows = await db
        .select({ storageRef: schema.sessionStreams.storageRef })
        .from(schema.sessionStreams)
        .where(eq(schema.sessionStreams.sessionId, sessionId))
        .limit(1);
    session.streamRef = streamRows[0]?.storageRef || session.streamRef;
    return session;
}

async function loadConversationRow(sessionId) {
    const rows = await db
        .select()
        .from(schema.sessionConversations)
        .where(eq(schema.sessionConversations.sessionId, sessionId))
        .limit(1);
    return rows[0] || null;
}

/**
 * Read the agent state dir JSONL for a session (best-effort).
 * Returns '' when unavailable.
 */
async function readStateDirJsonl(session) {
    try {
        const sessionManager = require('./SessionManager');
        const live = sessionManager.getSession(session.id);
        if (!live) return '';
        const runtime = live.runtime || null;
        if (!runtime || !runtime.fs || typeof runtime.fs.fsRead !== 'function') return '';
        const workspacePath = live.workspacePath || live.cwd;
        if (!workspacePath || !session.stateDirRef) return '';
        const content = await runtime.fs.fsRead(workspacePath, `${session.stateDirRef}/conversation.jsonl`, {
            runtimeRef: live.runtimeRef,
            encoding: 'utf8',
        });
        return typeof content === 'string' ? content : '';
    } catch {
        return '';
    }
}

/**
 * Summarize a session.
 *
 * A. Raw turns are persisted (no LLM) so the history list's turn count and
 *    the detail view stay in sync.
 * B. The LLM is called only to produce overview / keyDecisions / filesTouched,
 *    and only when forced (manual Refresh) or when no summary exists yet
 *    (first session exit).
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {boolean} [opts.force] regenerate the summary even if one exists
 * @returns {Promise<object>} the conversation view (same shape as getConversation)
 */
async function summarizeSession(sessionId, { force = false } = {}) {
    const session = await loadSession(sessionId);
    if (!session) {
        const err = new Error('session not found');
        err.code = 'session_not_found';
        throw err;
    }

    const existing = await loadConversationRow(sessionId);
    const hasSummary = Boolean(existing && existing.summary && typeof existing.summary === 'object'
        && existing.summary.overview);

    const store = require('../runtime/TranscriptStore');

    const { source, turns, headSeq: chatHeadSeq } = await extractor.extract({
        transcriptStore: store,
        streamRef: session.streamRef,
        stateDirRef: session.stateDirRef,
        readStateDir: () => readStateDirJsonl(session),
        readChatHistory: () => chatTranscript.getHistory(sessionId),
        // 0029: trajectory 优先 — 全量 verbatim 模型调用（完整工具参数/结果）
        readTrajectorySteps: () => require('../llm/trajectory').getAllSteps(sessionId),
        afterSeq: 0,
        // 落库/历史读取全量（不截断），支持会话历史真正分页；
        // LLM prompt 的截断在下方单独控制。
        maxTurns: null,
    });

    const headSeq = source === 'chat'
        ? (Number(chatHeadSeq) || 0)
        : (session.streamRef && store.head ? Number(store.head(session.streamRef)) || 0 : 0);

    if (turns.length === 0 && !hasSummary) {
        const err = new Error('no conversation content to summarize');
        err.code = 'no_content';
        throw err;
    }
    if (turns.length === 0) {
        return getConversation(sessionId);
    }

    // A: persist full raw turns (no LLM).
    await persistTurns(sessionId, turns, headSeq, source);

    // B: LLM only on first exit or forced refresh.
    if (hasSummary && !force) {
        return getConversation(sessionId);
    }

    // LLM prompt 单独截断：只喂最近 MAX_TURNS 条，避免超长会话 token 溢出
    const promptTurns = turns.length > extractor.MAX_TURNS
        ? turns.slice(turns.length - extractor.MAX_TURNS)
        : turns;
    const user = buildFullPrompt(promptTurns);
    const system = 'You are a precise technical conversation summarizer.';

    let summary;
    try {
        const raw = await analyzeClient.chatJson({
            system,
            user,
            options: { maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.3 },
        });
        summary = validateSummary(raw);
    } catch (err) {
        await recordFailure(sessionId, err);
        throw err;
    }
    if (!summary) {
        const err = new Error('LLM returned invalid summary JSON');
        err.code = 'llm_invalid_summary';
        await recordFailure(sessionId, err);
        throw err;
    }

    await upsertConversation(sessionId, {
        summary,
        turns,
        lastSummarizedSeq: headSeq,
        source,
    });

    return getConversation(sessionId);
}

async function recordFailure(sessionId, err) {
    const existing = await loadConversationRow(sessionId);
    const now = Date.now();
    const message = String(err?.message || err).slice(0, 500);
    if (existing) {
        await db
            .update(schema.sessionConversations)
            .set({
                lastError: message,
                errorCount: existing.errorCount + 1,
                updatedAt: now,
            })
            .where(eq(schema.sessionConversations.sessionId, sessionId));
    } else {
        await db
            .insert(schema.sessionConversations)
            .values({
                sessionId,
                summary: {},
                turns: [],
                lastSummarizedSeq: 0,
                source: 'transcript',
                lastError: message,
                errorCount: 1,
                updatedAt: now,
            })
            .onConflictDoNothing();
    }
}

async function upsertConversation(sessionId, { summary, turns, lastSummarizedSeq, source }) {
    const now = Date.now();
    await db
        .insert(schema.sessionConversations)
        .values({
            sessionId,
            summary,
            turns,
            lastSummarizedSeq,
            source,
            lastError: null,
            errorCount: 0,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: schema.sessionConversations.sessionId,
            set: {
                summary,
                turns,
                lastSummarizedSeq,
                source,
                lastError: null,
                errorCount: 0,
                updatedAt: now,
            },
        });
}

/**
 * Persist raw turns (no LLM) — advances the cursor so the history list's
 * turn count and the detail view fallback stay in sync. On conflict, only
 * the turns/cursor/source are updated; any existing summary is preserved.
 */
async function persistTurns(sessionId, turns, lastSummarizedSeq, source) {
    const now = Date.now();
    await db
        .insert(schema.sessionConversations)
        .values({
            sessionId,
            summary: {},
            turns,
            lastSummarizedSeq,
            source,
            lastError: null,
            errorCount: 0,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: schema.sessionConversations.sessionId,
            set: {
                turns,
                lastSummarizedSeq,
                source,
                updatedAt: now,
            },
        });
}

/**
 * Read the conversation view for API responses.
 *
 * Turns are served live, preferring the trajectory (0029) — the same source
 * summarizeSession uses — so the summary (overview/keyDecisions/filesTouched)
 * and the turns handed to skill extraction describe the same facts. Falls back
 * to the structured chat transcript, then to the stored turns.
 *
 * P3：真正分页——offset/limit 对 turns 切片，返回 total/hasMore，前端可逐页加载。
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {number} [opts.offset]
 * @param {number} [opts.limit]
 * @returns {Promise<object|null>} null only when there is neither a stored row nor any chat turns.
 */
async function getConversation(sessionId, { offset = 0, limit = null } = {}) {
    const row = await loadConversationRow(sessionId);

    let turns = [];
    let source = row?.source || 'transcript';
    try {
        const steps = await require('../llm/trajectory').getAllSteps(sessionId);
        if (Array.isArray(steps) && steps.length > 0) {
            // 不在此处截断（maxTurns=null），分页由下方统一处理
            const traj = extractor.extractFromTrajectory(steps, { maxTurns: null });
            if (traj.turns.length > 0) {
                turns = traj.turns;
                source = 'trajectory';
            }
        }
    } catch (_) {
        // fall through to chat transcript below
    }
    if (turns.length === 0) {
        try {
            const history = await chatTranscript.getHistory(sessionId);
            if (Array.isArray(history) && history.length > 0) {
                const chat = extractor.extractFromChat(history, 0, { maxTurns: null });
                if (chat.turns.length > 0) {
                    turns = chat.turns;
                    source = 'chat';
                }
            }
        } catch (_) {
            // fall through to stored turns below
        }
    }
    if (turns.length === 0 && row && Array.isArray(row.turns)) {
        turns = row.turns;
    }

    if (!row && turns.length === 0) return null;

    // 业界口径：total 按对话轮数计（1 turn = 一轮问答 = 1 条 user 消息），
    // 与列表 stats.turnCount 同口径；分页 offset/limit 仍对原始 turns（消息条数）
    // 切片——hasMore 必须与 turns.length（全量消息条数）比较，若与 total（轮数）
    // 比较会出现 sliced(40) > total(20) 导致按钮永远不出现的口径错配。
    const total = turns.filter((t) => t && t.role === 'user').length;
    const start = Math.max(0, Number(offset) || 0);
    const pageLimit = limit == null ? null : Math.max(1, Number(limit) || 50);
    const sliced = pageLimit == null ? turns.slice(start) : turns.slice(start, start + pageLimit);

    return {
        sessionId,
        source,
        summary: row?.summary || {},
        turns: sliced,
        total,
        offset: start,
        hasMore: pageLimit == null ? false : start + sliced.length < turns.length,
        lastSummarizedSeq: row?.lastSummarizedSeq || 0,
        updatedAt: row?.updatedAt,
    };
}

module.exports = {
    summarizeSession,
    getConversation,
    validateSummary,
    buildFullPrompt,
};
