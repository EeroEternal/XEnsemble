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

const MAX_EVENTS_PER_SESSION = 1000;

const buffers = new Map(); // sessionId -> { events: [], subscribers: Set<fn>, nextSeq, seeded }

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

/**
 * Append a chat event for a session, persist it, and notify subscribers.
 * event: { role: 'user'|'assistant'|'tool_call'|'tool_result', content, callId?, tool?, model? }
 *
 * seq is assigned synchronously (after optional first-use seeding) so call
 * order is preserved; DB persistence is fire-and-forget and never blocks the
 * LLM proxy hot path.
 */
async function append(sessionId, event) {
    if (!sessionId || !event) return null;
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

/** Subscribe to new chat events for a session. Returns an unsubscribe fn. */
function subscribe(sessionId, cb) {
    const buf = getBuffer(sessionId);
    buf.subscribers.add(cb);
    return () => { buf.subscribers.delete(cb); };
}

/**
 * Full history for a session (oldest first), read from PostgreSQL so it
 * survives restarts. Falls back to the in-memory buffer if the DB is
 * unreachable.
 *
 * 只读最近 MAX_EVENTS_PER_SESSION 条（最新），仍按 seq 升序输出——
 * 超长会话应看到「最近」的对话而非最早的开场白。内存 buffer 兜底
 * 路径（buf.events 超限时 splice 丢最旧）本身即保留最新，语义一致。
 */
async function getHistory(sessionId) {
    try {
        const { db } = require('../db/index');
        const schema = require('../db/schema');
        const { eq, asc, desc } = require('drizzle-orm');
        // 子查询先按 seq DESC 取最新 MAX_EVENTS_PER_SESSION 条
        const sub = db
            .select({ seq: schema.sessionChatMessages.seq })
            .from(schema.sessionChatMessages)
            .where(eq(schema.sessionChatMessages.sessionId, sessionId))
            .orderBy(desc(schema.sessionChatMessages.seq))
            .limit(MAX_EVENTS_PER_SESSION)
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
        const buf = buffers.get(sessionId);
        return buf ? buf.events.slice() : [];
    }
}

module.exports = { append, subscribe, getHistory };
