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
const SUMMARY_MAX_TOKENS = 2000;

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
    return turns
        .map((t, i) => {
            const tools = t.tools && t.tools.length
                ? ` [tools: ${t.tools.map((x) => (typeof x === 'string' ? x : x.tool || 'tool')).join(', ')}]`
                : '';
            return `#${i + 1} ${t.role}${tools}: ${t.text}`;
        })
        .join('\n');
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
        afterSeq: 0,
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

    const user = buildFullPrompt(turns);
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
 * Turns are served live from the structured chat transcript (A) and only
 * fall back to the stored turns when no chat transcript exists (e.g. old
 * sessions). The summary (overview / keyDecisions / filesTouched) comes from
 * the stored row (B).
 *
 * Returns null only when there is neither a stored row nor any chat turns.
 */
async function getConversation(sessionId) {
    const row = await loadConversationRow(sessionId);

    let turns = [];
    let source = row?.source || 'transcript';
    try {
        const history = await chatTranscript.getHistory(sessionId);
        if (Array.isArray(history) && history.length > 0) {
            const chat = extractor.extractFromChat(history);
            if (chat.turns.length > 0) {
                turns = chat.turns;
                source = 'chat';
            }
        }
    } catch (_) {
        // fall through to stored turns below
    }
    if (turns.length === 0 && row && Array.isArray(row.turns)) {
        turns = row.turns;
    }

    if (!row && turns.length === 0) return null;

    return {
        sessionId,
        source,
        summary: row?.summary || {},
        turns,
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
