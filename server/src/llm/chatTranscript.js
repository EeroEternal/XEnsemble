/**
 * Structured chat transcript per session, backed by PostgreSQL.
 *
 * The agent CLI (qwen/opencode/cline/...) is a TUI — its stdout is raw VT100
 * bytes that cannot be parsed into conversation bubbles. But every agent talks
 * to the model through the LLM proxy (proxy.js), which sees structured
 * OpenAI-compatible messages (user / assistant / tool). This module records
 * those messages per session so the web UI can render a Devin/Cursor-style
 * dialog view whose content matches the agent's real conversation.
 *
 * Persistence: rows are written to `session_chat_messages` (survives backend
 * restarts / CI redeploys). An in-memory buffer is kept only to power live
 * subscribers (WS chat_event) and as a fallback when the DB is unreachable.
 *
 * Seq continuity: the next seq is seeded from the DB max on first use, so a
 * resumed session after a restart keeps numbering (and avoids PK conflicts).
 */

/**
 * 每 session 保留的最大事件条数（内存 buffer 与 DB 历史读取共用）。
 * 超出后丢最旧、保留最新——对话视图按 HISTORY_PAGE_SIZE=50/页游标翻页，
 * 500 条 ≈ 10 页完整历史，足够回溯且控制首屏/传输体积。
 */
const MAX_EVENTS_PER_SESSION = 500;

const buffers = new Map(); // sessionId -> { events: [], subscribers: Set<fn>, nextSeq, seeded }
const globalSubscribers = new Set(); // 进程级订阅（attentionService 挂 L1 钩子用）

function getBuffer(sessionId) {
    let buf = buffers.get(sessionId);
    if (!buf) {
        buf = { events: [], subscribers: new Set(), nextSeq: 1, seeded: false };
        buffers.set(sessionId, buf);
    }
    return buf;
}

/** Seed nextSeq from DB max(seq) once per session/process. */
async function seedSeq(buf, sessionId) {
    if (buf.seeded) return;
    buf.seeded = true; // set before awaiting so concurrent appends don't double-seed
    try {
        const { db } = require('../db/index');
        const schema = require('../db/schema');
        const { eq, sql } = require('drizzle-orm');
        const rows = await db
            .select({ maxSeq: sql`coalesce(max(${schema.sessionChatMessages.seq}), 0)` })
            .from(schema.sessionChatMessages)
            .where(eq(schema.sessionChatMessages.sessionId, sessionId));
        const maxSeq = Number(rows[0]?.maxSeq ?? 0);
        buf.nextSeq = Math.max(buf.nextSeq, maxSeq + 1);
    } catch (_) {
        // DB unavailable — keep in-memory numbering.
    }
}

function entryFromRow(row) {
    return {
        seq: row.seq,
        ts: row.ts,
        role: row.role,
        content: row.content,
        ...(row.callId != null ? { callId: row.callId } : {}),
        ...(row.tool != null ? { tool: row.tool } : {}),
        ...(row.model != null ? { model: row.model } : {}),
    };
}

// Per-session serialization of append(): seq must be reserved in call order.
// The first append of a session awaits seedSeq (a DB round-trip); without
// chaining, appends issued concurrently (LLM error events, tool results from
// parallel requests) would overtake it and invert seq order, scrambling the
// dialog view's transcript.
const appendChains = new Map();

/**
 * Append a chat event for a session, persist it, and notify subscribers.
 * event: { role: 'user'|'assistant'|'tool_call'|'tool_result'|'error', content, callId?, tool?, model? }
 *
 * seq is assigned synchronously (after optional first-use seeding) so call
 * order is preserved; DB persistence is fire-and-forget and never blocks the
 * LLM proxy hot path. Calls are serialized per session to keep that order
 * guarantee under concurrency.
 */
function append(sessionId, event) {
    if (!sessionId || !event) return Promise.resolve(null);
    const prev = appendChains.get(sessionId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => appendInner(sessionId, event));
    appendChains.set(sessionId, next.catch(() => {}));
    return next;
}

async function appendInner(sessionId, event) {
    const buf = getBuffer(sessionId);
    await seedSeq(buf, sessionId);
    const entry = {
        seq: buf.nextSeq++,
        ts: Date.now(),
        role: event.role,
        content: String(event.content ?? ''),
    };
    if (event.model) entry.model = event.model;
    if (event.callId != null) entry.callId = event.callId;
    if (event.tool != null) entry.tool = event.tool;
    buf.events.push(entry);
    if (buf.events.length > MAX_EVENTS_PER_SESSION) {
        buf.events.splice(0, buf.events.length - MAX_EVENTS_PER_SESSION);
    }
    for (const cb of buf.subscribers) {
        try { cb(entry); } catch (_) { /* ignore subscriber errors */ }
    }
    for (const cb of globalSubscribers) {
        try { cb(sessionId, entry); } catch (_) { /* ignore */ }
    }
    persist(sessionId, entry).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[chat-transcript] persist failed:', err?.message || err);
    });
    return entry;
}

async function persist(sessionId, entry) {
    const { db } = require('../db/index');
    const schema = require('../db/schema');
    await db.insert(schema.sessionChatMessages).values({
        sessionId,
        seq: entry.seq,
        ts: entry.ts,
        role: entry.role,
        content: entry.content,
        callId: entry.callId ?? null,
        tool: entry.tool ?? null,
        model: entry.model ?? null,
    }).onConflictDoNothing();
}

/**
 * Subscribe to chat events for ALL sessions (process-wide). Used by the
 * attention service to tap L1 protocol signals without knowing session ids
 * up front. cb(sessionId, entry). Returns an unsubscribe fn.
 */
function subscribeAll(cb) {
    globalSubscribers.add(cb);
    return () => globalSubscribers.delete(cb);
}

/** Subscribe to new chat events for a session. Returns an unsubscribe fn. */
function subscribe(sessionId, cb) {
    const buf = getBuffer(sessionId);
    buf.subscribers.add(cb);
    return () => { buf.subscribers.delete(cb); };
}

/**
 * Normalize optional history-read options.
 * limit: page size, clamped to [1, MAX_EVENTS_PER_SESSION]; default = full cap.
 * beforeSeq: cursor — only return events with seq < beforeSeq (older pages).
 */
function normalizeHistoryOpts(opts = {}) {
    const limitRaw = Number(opts.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_EVENTS_PER_SESSION)
        : MAX_EVENTS_PER_SESSION;
    const beforeRaw = Number(opts.beforeSeq);
    const beforeSeq = Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.floor(beforeRaw) : null;
    return { limit, beforeSeq };
}

/**
 * History for a session (oldest first), read from PostgreSQL so it
 * survives restarts. Falls back to the in-memory buffer if the DB is
 * unreachable.
 *
 * 只读最近 limit 条（默认 = MAX_EVENTS_PER_SESSION，即全部保留历史），
 * 仍按 seq 升序输出——超长会话应看到「最近」的对话而非最早的开场白。
 * 内存 buffer 兕底路径（buf.events 超限时 splice 丢最旧）本身即保留最新，
 * 语义一致。
 *
 * 游标分页：传 { beforeSeq } 时只返回该 seq 之前（更早）的一页，
 * 供对话视图「加载更早」向前翻页；不传则返回最新一页全量。
 */
async function getHistory(sessionId, opts = {}) {
    const { limit, beforeSeq } = normalizeHistoryOpts(opts);
    try {
        const { db } = require('../db/index');
        const schema = require('../db/schema');
        const { and, eq, asc, desc, lt } = require('drizzle-orm');
        // 过滤条件：本会话；游标模式下再限定 seq < beforeSeq（更早一页）
        const conds = beforeSeq != null
            ? and(
                eq(schema.sessionChatMessages.sessionId, sessionId),
                lt(schema.sessionChatMessages.seq, beforeSeq),
            )
            : eq(schema.sessionChatMessages.sessionId, sessionId);
        // 子查询先按 seq DESC 取最新 limit 条
        const sub = db
            .select({ seq: schema.sessionChatMessages.seq })
            .from(schema.sessionChatMessages)
            .where(conds)
            .orderBy(desc(schema.sessionChatMessages.seq))
            .limit(limit)
            .as('sub');
        // 外层再按 seq ASC 输出，保证调用方拿到的是 旧→新 顺序。
        // 关键：JOIN 必须同时带 sessionId，否则会把其他会话里相同 seq 的消息
        // 一并拉出（跨会话数据泄漏）。此前的 innerJoin 只 on seq 即中招。
        const rows = await db
            .select({
                seq: schema.sessionChatMessages.seq,
                ts: schema.sessionChatMessages.ts,
                role: schema.sessionChatMessages.role,
                content: schema.sessionChatMessages.content,
                callId: schema.sessionChatMessages.callId,
                tool: schema.sessionChatMessages.tool,
                model: schema.sessionChatMessages.model,
            })
            .from(schema.sessionChatMessages)
            .innerJoin(sub, eq(schema.sessionChatMessages.seq, sub.seq))
            .where(eq(schema.sessionChatMessages.sessionId, sessionId))
            .orderBy(asc(schema.sessionChatMessages.seq));
        return rows.map(entryFromRow);
    } catch (_) {
        // DB unreachable — same newest-`limit` semantics against the in-memory
        // buffer: filter by cursor, keep the latest `limit` events.
        const buf = buffers.get(sessionId);
        if (!buf) return [];
        let events = buf.events;
        if (beforeSeq != null) events = events.filter((e) => e.seq < beforeSeq);
        return events.slice(-limit);
    }
}

/**
 * Batch variant of getHistory for list views: returns a Map of sessionId ->
 * history rows (oldest first), keeping the same per-session cap semantics
 * (latest MAX_EVENTS_PER_SESSION rows per session).
 *
 * @param {string[]} sessionIds
 * @returns {Promise<Map<string, Array>>}
 */
async function getHistoryForSessions(sessionIds) {
    const result = new Map();
    const ids = (sessionIds || []).filter(Boolean);
    if (ids.length === 0) return result;
    try {
        const { db } = require('../db/index');
        const schema = require('../db/schema');
        const { sql } = require('drizzle-orm');
        const rows = await db.execute(sql`
            SELECT session_id, seq, ts, role, content, call_id, tool, model
            FROM (
                SELECT m.*, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq DESC) AS rn
                FROM session_chat_messages m
                WHERE m.session_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            ) t
            WHERE rn <= ${MAX_EVENTS_PER_SESSION}
            ORDER BY session_id, seq ASC
        `);
        const raw = rows.rows || rows;
        for (const row of raw) {
            const list = result.get(row.session_id) || [];
            list.push(entryFromRow(row));
            result.set(row.session_id, list);
        }
    } catch (_) {
        // DB unavailable — return whatever the in-memory buffers hold.
        for (const id of ids) {
            const buf = buffers.get(id);
            if (buf) result.set(id, buf.events.slice());
        }
    }
    return result;
}

module.exports = { append, subscribe, subscribeAll, getHistory, getHistoryForSessions };
