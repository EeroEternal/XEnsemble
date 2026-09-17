/**
 * Session trajectory — full verbatim record of every model call, backed by PG.
 *
 * While chatTranscript records a downsampled dialog for the chat view, this
 * module is the authoritative execution record: every request (system prompt,
 * full context, tool definitions, params) and every response (text, thinking,
 * complete tool arguments, finish reason, usage) per model call.
 *
 * Storage shape (session_trajectory, one row per model call):
 *   snapshot rows: request.messages = full context array (first call, or when
 *                  compaction / mismatch resets the delta chain)
 *   delta rows:    request.messages = only messages appended since the previous
 *                  call (agent CLIs replay the whole history every request, so
 *                  storing it verbatim would be O(n²); export replays deltas
 *                  back into per-call full payloads)
 *
 * Capture point: llm proxy (proxy.js) — request side parses the forwarded body
 * before forwarding; response side receives the assembled upstream body (same
 * 2MB cap as the chat view). Persistence is fire-and-forget and never blocks
 * the proxy hot path; seq assignment is serialized per session.
 */

const MAX_JSON_BYTES = 1.5 * 1024 * 1024; // per jsonb column budget
const STR_CAP = 8000; // per-string cap once a record exceeds the budget
const MAX_PREV_SESSIONS = 50; // LRU on per-session "previous messages" cache
const MAX_PREV_BYTES = 6 * 1024 * 1024; // skip delta caching above this size

// sessionId -> Promise chain: seq must be claimed in call order (mirrors
// chatTranscript's appendChains — concurrent appends must not invert seq).
const chains = new Map();
// sessionId -> { nextSeq, seeded }
const seqState = new Map();
// sessionId -> previous request's messages array (delta verification base)
const prevMessages = new Map();
// sessionId -> Set<fn(step)> — live WS subscribers (trajectory_event)
const subscribers = new Map();

/** Subscribe to completed steps for a session; returns an unsubscribe fn. */
function subscribe(sessionId, fn) {
    let set = subscribers.get(sessionId);
    if (!set) {
        set = new Set();
        subscribers.set(sessionId, set);
    }
    set.add(fn);
    return () => {
        const cur = subscribers.get(sessionId);
        if (!cur) return;
        cur.delete(fn);
        if (cur.size === 0) subscribers.delete(sessionId);
    };
}

function notifySubscribers(sessionId, step) {
    const set = subscribers.get(sessionId);
    if (!set) return;
    for (const fn of set) {
        try { fn(step); } catch (_) { /* ignore subscriber errors */ }
    }
}

async function notifyRow(sessionId, seq) {
    try {
        const { db } = require('../db/index');
        const schema = require('../db/schema');
        const { and, eq } = require('drizzle-orm');
        const rows = await db.select().from(schema.sessionTrajectory)
            .where(and(eq(schema.sessionTrajectory.sessionId, sessionId), eq(schema.sessionTrajectory.seq, seq)))
            .limit(1);
        if (rows[0]) notifySubscribers(sessionId, stepFromRow(rows[0]));
    } catch (_) { /* 通知失败不影响记录 */ }
}

function enqueue(sessionId, fn) {
    const prev = chains.get(sessionId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    chains.set(sessionId, next.catch(() => {}));
    return next;
}

function state(sessionId) {
    let st = seqState.get(sessionId);
    if (!st) {
        st = { nextSeq: 1, seeded: false };
        seqState.set(sessionId, st);
    }
    return st;
}

/** Seed nextSeq from DB max(seq) once per session/process. */
async function seedSeq(st, sessionId) {
    if (st.seeded) return;
    st.seeded = true;
    try {
        const { db } = require('../db/index');
        const schema = require('../db/schema');
        const { eq, sql } = require('drizzle-orm');
        const rows = await db
            .select({ maxSeq: sql`coalesce(max(${schema.sessionTrajectory.seq}), 0)` })
            .from(schema.sessionTrajectory)
            .where(eq(schema.sessionTrajectory.sessionId, sessionId));
        const maxSeq = Number(rows[0]?.maxSeq ?? 0);
        if (maxSeq + 1 > st.nextSeq) st.nextSeq = maxSeq + 1;
    } catch (_) { /* DB unavailable — in-memory numbering */ }
}

// ---------------------------------------------------------------------------
// Request side: snapshot vs delta
// ---------------------------------------------------------------------------

function pickParams(body) {
    const params = {};
    for (const k of Object.keys(body || {})) {
        if (k === 'messages') continue;
        params[k] = body[k];
    }
    return params;
}

// CLI 注入的合成用户消息（记忆整理/压缩摘要/离开总结/输入建议生成）。
// 与 session/conversationExtractor.js 同一约定集，用于识别「旁路调用」——
// 其请求历史末尾是 CLI 自身生成的伪指令，而非真实用户输入。
const SYNTHETIC_USER_RES = [
    /^This session is being continued from a previous conversation/,
    /^Caveat: The messages below/,
    /^The user (?:stepped away|is away|has stepped away)/,
    /^Managed memory has/,
    /^\[SUGGESTION MODE:/,
];

/** 单条消息是否为 CLI 合成的伪用户指令 */
function isSyntheticUserMessage(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.role !== 'user' && msg.role !== 'human') return false;
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
            if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
        }
    }
    const trimmed = text.trim();
    return trimmed.length > 0 && SYNTHETIC_USER_RES.some((re) => re.test(trimmed));
}

/**
 * 是否为「旁路合成调用」：请求历史末尾是 CLI 生成的伪用户指令（输入建议、
 * 记忆整理等）。这类调用与主对话分支不同、会污染 prev 链与读取端游标，
 * 导致真实用户消息被误跳过、伪指令泄漏成用户轮次——写入前整条拒绝记录。
 */
function isSyntheticBypassCall(body) {
    const msgs = Array.isArray(body?.messages) ? body.messages : null;
    if (!msgs || msgs.length === 0) return false;
    return isSyntheticUserMessage(msgs[msgs.length - 1]);
}

/**
 * Build the stored request record. Pure (exported for tests).
 * Delta applies only when the new history is a strict append of the previous
 * one (verified by value, not just length — compaction rewrites history).
 */
function buildRequestRecord(body, prevMessagesArr) {
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    const record = { snapshot: true, params: pickParams(body), messages: [] };
    if (!messages) return record;
    record.msg_count = messages.length;

    if (
        Array.isArray(prevMessagesArr) &&
        messages.length > prevMessagesArr.length &&
        samePrefix(messages, prevMessagesArr)
    ) {
        record.snapshot = false;
        record.messages = messages.slice(prevMessagesArr.length);
    } else {
        record.messages = messages.slice();
    }
    return record;
}

function samePrefix(messages, prev) {
    // Cheap length check first, then value compare (agents replay history
    // verbatim; only compaction/rewrites break the prefix — those reset to a
    // snapshot so export replay stays exact).
    try {
        return JSON.stringify(messages.slice(0, prev.length)) === JSON.stringify(prev);
    } catch (_) {
        return false;
    }
}

function getPrevMessages(sessionId) {
    const prev = prevMessages.get(sessionId);
    return Array.isArray(prev) ? prev : null;
}

function capDeep(v, cap, depth) {
    const d = depth || 0;
    if (typeof v === 'string') {
        return v.length > cap ? v.slice(0, cap) + '…[truncated]' : v;
    }
    if (Array.isArray(v)) {
        if (d > 8) return '[…]';
        return v.map((x) => capDeep(x, cap, d + 1));
    }
    if (v && typeof v === 'object') {
        if (d > 8) return { truncated: true };
        const out = {};
        for (const k of Object.keys(v)) out[k] = capDeep(v[k], cap, d + 1);
        return out;
    }
    return v;
}

function jsonBytes(v) {
    try { return Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch (_) { return Infinity; }
}

/** Enforce the per-record PG budget; degrades gracefully, never throws. */
function capRequestRecord(record) {
    if (jsonBytes(record) <= MAX_JSON_BYTES) return record;
    let out = capDeep(record, STR_CAP, 0);
    out.truncated = true;
    if (jsonBytes(out) <= MAX_JSON_BYTES) return out;
    // Drop the oldest context messages (delta rows keep only a handful; in
    // practice only giant snapshots reach here).
    for (const keep of [200, 50, 10]) {
        if (Array.isArray(out.messages) && out.messages.length > keep) {
            out = { ...out, messages: out.messages.slice(-keep), truncated: true };
        }
        if (jsonBytes(out) <= MAX_JSON_BYTES) return out;
    }
    return { ...out, messages: [], truncated: true };
}

function rememberPrev(sessionId, messages) {
    if (!Array.isArray(messages)) return;
    try {
        if (jsonBytes(messages) > MAX_PREV_BYTES) return;
    } catch (_) { return; }
    prevMessages.delete(sessionId); // refresh LRU position
    prevMessages.set(sessionId, messages);
    while (prevMessages.size > MAX_PREV_SESSIONS) {
        const oldest = prevMessages.keys().next().value;
        prevMessages.delete(oldest);
    }
}

/**
 * Record a model-call request. Resolves to the claimed seq (for response
 * pairing), or null when the call is not recordable. The row is inserted
 * with response=null; recordResponse()/recordFailure() fill the outcome.
 */
function recordRequest({ sessionId, agentId, model, body }) {
    if (!sessionId || !body || typeof body !== 'object') return Promise.resolve(null);
    // 旁路合成调用（输入建议/记忆整理）不落轨迹：写入整条会污染 prev 链，
    // 读取端的分歧快照又把游标顶过真实消息 → 消息丢失 + 伪指令泄漏。
    if (isSyntheticBypassCall(body)) return Promise.resolve(null);
    return enqueue(sessionId, async () => {
        const st = state(sessionId);
        await seedSeq(st, sessionId);
        const seq = st.nextSeq++;
        const prev = prevMessages.get(sessionId) || null;
        let record;
        try {
            record = buildRequestRecord(body, prev);
        } catch (_) {
            record = { snapshot: true, params: {}, messages: [] };
        }
        record = capRequestRecord(record);
        rememberPrev(sessionId, Array.isArray(body.messages) ? body.messages : null);
        const row = {
            sessionId,
            seq,
            ts: Date.now(),
            agentId: agentId || null,
            model: model || null,
            snapshot: record.snapshot,
            msgCount: Number(record.msg_count) || 0,
            request: { snapshot: record.snapshot, truncated: !!record.truncated, params: record.params, messages: record.messages },
            response: null,
            status: 'ok',
            latencyMs: null,
            error: null,
        };
        // 在链内 await：后续 recordResponse 的 UPDATE 依赖本行已存在，否则
        // UPDATE 先于 INSERT 执行会匹配 0 行、响应静默丢失。单条 INSERT 在
        // 模型调用热路径上可忽略（对比数秒的 LLM 往返）。
        try {
            await persistInsert(row);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[trajectory] insert failed:', err?.message || err);
        }
        // 请求侧也推送：用户消息即时出现在轨迹里（响应行随后以相同 seq 覆盖更新）
        await notifyRow(sessionId, seq);
        return seq;
    }).catch(() => null);
}

async function persistInsert(row) {
    const { db } = require('../db/index');
    const schema = require('../db/schema');
    await db.insert(schema.sessionTrajectory).values(row);
}

// ---------------------------------------------------------------------------
// Response side: normalize openai-completions & anthropic-messages streams
// ---------------------------------------------------------------------------

/** Normalize one non-stream response body (pure, exported for tests). */
function normalizeNonStream(body) {
    if (!body || typeof body !== 'object') return null;
    // OpenAI-compatible chat.completion
    const choice = body.choices?.[0];
    if (choice?.message) {
        const m = choice.message;
        const content = [];
        const thinking = m.reasoning_content ?? m.reasoning;
        if (typeof thinking === 'string' && thinking) content.push({ type: 'thinking', thinking });
        if (typeof m.content === 'string' && m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.tool_calls || []) {
            content.push(toolUseFromOpenai(tc));
        }
        return {
            format: 'openai',
            content,
            finish_reason: choice.finish_reason || body.finish_reason || null,
            usage: normalizeUsageOpenai(body.usage),
            truncated: false,
        };
    }
    // Anthropic messages response
    if (Array.isArray(body.content) && (body.model || body.stop_reason || body.role === 'assistant')) {
        const content = [];
        for (const b of body.content || []) {
            if (b?.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
            else if (b?.type === 'thinking' && b.thinking) content.push({ type: 'thinking', thinking: b.thinking });
            else if (b?.type === 'tool_use') content.push({ type: 'tool_use', id: b.id || null, name: b.name || null, input: b.input ?? {} });
        }
        return {
            format: 'anthropic',
            content,
            finish_reason: body.stop_reason || null,
            usage: normalizeUsageAnthropic(body.usage),
            truncated: false,
        };
    }
    return null;
}

function toolUseFromOpenai(tc) {
    let input = {};
    const raw = tc?.function?.arguments;
    if (raw != null) {
        try { input = JSON.parse(raw); } catch (_) { input = { raw: String(raw) }; }
    }
    return { type: 'tool_use', id: tc?.id || null, name: tc?.function?.name || null, input };
}

function normalizeUsageOpenai(u) {
    if (!u || typeof u !== 'object') return null;
    const prompt = Number(u.prompt_tokens ?? 0);
    const completion = Number(u.completion_tokens ?? 0);
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number(u.total_tokens ?? prompt + completion) };
}

function normalizeUsageAnthropic(u) {
    if (!u || typeof u !== 'object') return null;
    const prompt = Number(u.input_tokens ?? 0);
    const completion = Number(u.output_tokens ?? 0);
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/**
 * Assemble a streaming (SSE) response into the same normalized shape as
 * normalizeNonStream. Pure (exported for tests).
 */
function parseSseResponse(text) {
    const acc = { format: null, content: [], finish_reason: null, usage: null, toolIdx: {} };
    let sawEvent = false;
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch (_) { continue; }
        if (!obj || typeof obj !== 'object') continue;
        sawEvent = true;
        if (obj.type === 'error' && obj.error) {
            acc.error = obj.error.message || JSON.stringify(obj.error);
            continue;
        }
        // --- Anthropic messages stream ---
        if (obj.type) {
            acc.format = acc.format || 'anthropic';
            if (obj.type === 'message_start') {
                acc.usage = mergeUsage(acc.usage, normalizeUsageAnthropic(obj.message?.usage));
            } else if (obj.type === 'content_block_start') {
                const b = obj.content_block || {};
                acc.content[obj.index] = b.type === 'tool_use'
                    ? { type: 'tool_use', id: b.id || null, name: b.name || null, inputStr: '' }
                    : b.type === 'thinking'
                        ? { type: 'thinking', thinking: '' }
                        : { type: 'text', text: '' };
            } else if (obj.type === 'content_block_delta') {
                const blk = acc.content[obj.index] || (acc.content[obj.index] = { type: 'text', text: '' });
                const d = obj.delta || {};
                if (d.type === 'text_delta' && typeof d.text === 'string') blk.text = (blk.text || '') + d.text;
                else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') blk.thinking = (blk.thinking || '') + d.thinking;
                else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') blk.inputStr = (blk.inputStr || '') + d.partial_json;
            } else if (obj.type === 'message_delta') {
                if (obj.delta?.stop_reason) acc.finish_reason = obj.delta.stop_reason;
                if (obj.usage) {
                    // Anthropic semantics: message_delta.usage.output_tokens is
                    // the CUMULATIVE total, not an increment — replace, don't merge.
                    const nu = normalizeUsageAnthropic(obj.usage);
                    if (nu) {
                        const prompt = acc.usage?.prompt_tokens ?? nu.prompt_tokens;
                        acc.usage = { prompt_tokens: prompt, completion_tokens: nu.completion_tokens, total_tokens: prompt + nu.completion_tokens };
                    }
                }
            }
            continue;
        }
        // --- OpenAI-compatible chat stream ---
        if (obj.choices) {
            acc.format = acc.format || 'openai';
            const c = obj.choices[0] || {};
            const delta = c.delta || {};
            if (typeof delta.content === 'string' && delta.content) {
                acc.content.push({ type: 'text', text: delta.content });
            }
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (typeof reasoning === 'string' && reasoning) {
                acc.content.push({ type: 'thinking', thinking: reasoning });
            }
            for (const tc of delta.tool_calls || []) {
                const idx = Number.isFinite(tc.index) ? tc.index : 0;
                const cur = acc.toolIdx[idx] || (acc.toolIdx[idx] = { type: 'tool_use', id: null, name: null, args: '' });
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name = tc.function.name;
                if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
            }
            if (c.finish_reason) acc.finish_reason = c.finish_reason;
            if (obj.usage) acc.usage = mergeUsage(acc.usage, normalizeUsageOpenai(obj.usage));
        }
    }
    if (!sawEvent) return null;
    // Fold accumulated pieces preserving arrival order: concat adjacent
    // text/thinking, finalize tool inputs. Flush on every type switch so the
    // emitted block order matches what the model actually produced.
    const content = [];
    let textBuf = '';
    let thinkBuf = '';
    const flushText = () => { if (textBuf) content.push({ type: 'text', text: textBuf }); textBuf = ''; };
    const flushThink = () => { if (thinkBuf) content.push({ type: 'thinking', thinking: thinkBuf }); thinkBuf = ''; };
    for (const piece of acc.content) {
        if (!piece) continue;
        if (piece.type === 'text') { flushThink(); textBuf += piece.text || ''; }
        else if (piece.type === 'thinking') { flushText(); thinkBuf += piece.thinking || ''; }
        else if (piece.type === 'tool_use') {
            flushText(); flushThink();
            let input = {};
            if (piece.inputStr) { try { input = JSON.parse(piece.inputStr); } catch (_) { input = { raw: piece.inputStr }; } }
            content.push({ type: 'tool_use', id: piece.id, name: piece.name, input });
        }
    }
    flushText(); flushThink();
    for (const idx of Object.keys(acc.toolIdx)) {
        const t = acc.toolIdx[idx];
        let input = {};
        if (t.args) { try { input = JSON.parse(t.args); } catch (_) { input = { raw: t.args }; } }
        content.push({ type: 'tool_use', id: t.id, name: t.name, input });
    }
    return {
        format: acc.format || 'openai',
        content,
        finish_reason: acc.finish_reason,
        usage: acc.usage,
        truncated: false,
        error: acc.error || null,
    };
}

function mergeUsage(a, b) {
    if (!b) return a || null;
    if (!a) return b;
    return {
        prompt_tokens: a.prompt_tokens + b.prompt_tokens,
        completion_tokens: a.completion_tokens + b.completion_tokens,
        total_tokens: a.total_tokens + b.total_tokens,
    };
}

/** Parse raw upstream response bytes into the normalized shape (or null). */
function parseResponseBytes(bodyBuffer, contentType) {
    if (!bodyBuffer || !bodyBuffer.length) return null;
    const text = bodyBuffer.toString('utf8');
    if (/text\/event-stream/i.test(String(contentType))) {
        return parseSseResponse(text);
    }
    try {
        return normalizeNonStream(JSON.parse(text));
    } catch (_) {
        return null;
    }
}

function capResponse(resp) {
    if (!resp || jsonBytes(resp) <= MAX_JSON_BYTES) return resp;
    const out = capDeep(resp, STR_CAP, 0);
    out.truncated = true;
    return out;
}

/**
 * Fill in the outcome of a previously claimed request row (seq from
 * recordRequest). Fire-and-forget; failures only log.
 */
function recordResponse({ sessionId, seq, bodyBuffer, contentType, statusCode, latencyMs, errorText }) {
    if (!sessionId || !Number.isFinite(seq)) return;
    enqueue(sessionId, async () => {
        const parsed = parseResponseBytes(bodyBuffer, contentType);
        const isError = Boolean(errorText) || Boolean(parsed?.error) || (Number(statusCode) >= 400);
        const response = capResponse(parsed);
        const { db } = require('../db/index');
        const schema = require('../db/schema');
        const { and, eq } = require('drizzle-orm');
        const updated = await db.update(schema.sessionTrajectory).set({
            response: response || null,
            status: isError ? 'error' : 'ok',
            latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
            error: (errorText ? String(errorText).slice(0, 2000) : null)
                || parsed?.error
                || (Number(statusCode) >= 400 ? `upstream ${statusCode}` : null),
        }).where(and(eq(schema.sessionTrajectory.sessionId, sessionId), eq(schema.sessionTrajectory.seq, seq)))
            .returning({ seq: schema.sessionTrajectory.seq });
        if (updated.length === 0) {
            // 请求行缺失（insert 失败等）——兜底落一行独立响应，避免响应丢失
            const st = state(sessionId);
            await seedSeq(st, sessionId);
            const newSeq = st.nextSeq++;
            await db.insert(schema.sessionTrajectory).values({
                sessionId,
                seq: newSeq,
                ts: Date.now(),
                model: null,
                snapshot: true,
                msgCount: 0,
                request: { snapshot: true, unmatched: true, params: {}, messages: [] },
                response: response || null,
                status: isError ? 'error' : 'ok',
                latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
                error: (errorText ? String(errorText).slice(0, 2000) : null)
                    || parsed?.error
                    || (Number(statusCode) >= 400 ? `upstream ${statusCode}` : null),
            });
            await notifyRow(sessionId, newSeq);
        } else {
            await notifyRow(sessionId, seq);
        }
    }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[trajectory] response update failed:', err?.message || err);
    });
}

/**
 * Record a call that failed before/without an upstream body (forward error,
 * gateway down). With a claimed seq it updates the row; without one it inserts
 * a standalone error row so the failure is still visible in the trajectory.
 */
function recordFailure({ sessionId, seq, agentId, model, error, latencyMs }) {
    if (!sessionId || !error) return;
    enqueue(sessionId, async () => {
        const { db } = require('../db/index');
        const schema = require('../db/schema');
        const { and, eq } = require('drizzle-orm');
        if (Number.isFinite(seq)) {
            await db.update(schema.sessionTrajectory).set({
                status: 'error',
                latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
                error: String(error).slice(0, 2000),
            }).where(and(eq(schema.sessionTrajectory.sessionId, sessionId), eq(schema.sessionTrajectory.seq, seq)));
            await notifyRow(sessionId, seq);
            return;
        }
        const st = state(sessionId);
        await seedSeq(st, sessionId);
        const newSeq = st.nextSeq++;
        await db.insert(schema.sessionTrajectory).values({
            sessionId,
            seq: newSeq,
            ts: Date.now(),
            agentId: agentId || null,
            model: model || null,
            snapshot: true,
            msgCount: 0,
            request: { snapshot: true, unmatched: true, params: {}, messages: [] },
            response: null,
            status: 'error',
            latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
            error: String(error).slice(0, 2000),
        });
        await notifyRow(sessionId, newSeq);
    }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[trajectory] failure record failed:', err?.message || err);
    });
}

// ---------------------------------------------------------------------------
// Read side: paged steps + delta replay (export)
// ---------------------------------------------------------------------------

function stepFromRow(row) {
    return {
        seq: row.seq,
        ts: row.ts,
        agentId: row.agentId,
        model: row.model,
        snapshot: row.snapshot,
        msgCount: row.msgCount,
        request: row.request,
        response: row.response,
        status: row.status,
        latencyMs: row.latencyMs,
        error: row.error,
    };
}

async function getSteps(sessionId, { afterSeq = 0, limit = 100 } = {}) {
    const { db } = require('../db/index');
    const schema = require('../db/schema');
    const { and, asc, eq, gt } = require('drizzle-orm');
    const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = await db.select().from(schema.sessionTrajectory)
        .where(and(eq(schema.sessionTrajectory.sessionId, sessionId), gt(schema.sessionTrajectory.seq, Number(afterSeq) || 0)))
        .orderBy(asc(schema.sessionTrajectory.seq))
        .limit(capped + 1);
    const hasMore = rows.length > capped;
    return { steps: rows.slice(0, capped).map(stepFromRow), hasMore };
}

async function getAllSteps(sessionId) {
    const { db } = require('../db/index');
    const schema = require('../db/schema');
    const { asc, eq } = require('drizzle-orm');
    const rows = await db.select().from(schema.sessionTrajectory)
        .where(eq(schema.sessionTrajectory.sessionId, sessionId))
        .orderBy(asc(schema.sessionTrajectory.seq));
    return rows.map(stepFromRow);
}

/**
 * Aggregate session-wide totals from the full step rows (pure, exported for
 * tests). The viewer header shows these over ALL calls instead of the paged
 * `steps` it has loaded, so long sessions don't under-count until "load more".
 *
 * userTurns/toolCalls reuse conversationExtractor so the header matches the
 * trajectory report (same dedupe of replayed assistant messages).
 */
function computeStats(steps) {
    const rows = Array.isArray(steps) ? steps : [];
    let durationMs = 0;
    let toolCalls = 0;
    let maxSeq = 0;
    for (const s of rows) {
        if (Number.isFinite(s?.seq) && s.seq > maxSeq) maxSeq = s.seq;
        if (Number.isFinite(s?.latencyMs)) durationMs += s.latencyMs;
        const content = Array.isArray(s?.response?.content) ? s.response.content : [];
        for (const b of content) {
            if (b && b.type === 'tool_use') toolCalls += 1;
        }
    }
    let userTurns = 0;
    try {
        const { extractFromTrajectory } = require('../session/conversationExtractor');
        const { turns } = extractFromTrajectory(rows, { maxTurns: null }) || {};
        for (const turn of turns || []) {
            if (turn?.role === 'user') userTurns += 1;
        }
    } catch (_) { /* extraction failure → keep 0, header degrades to local count */ }
    return { modelCalls: rows.length, durationMs, toolCalls, userTurns, maxSeq };
}

async function getStats(sessionId) {
    return computeStats(await getAllSteps(sessionId));
}

/**
 * Replay snapshot/delta rows into per-call full payloads (pure, exported for
 * tests). Each returned line carries the complete context messages the agent
 * sent on that call — semantically identical to storing every request
 * verbatim, without the O(n²) storage cost.
 */
function replayToFull(steps) {
    let ctx = [];
    const lines = [];
    for (const step of steps || []) {
        const req = step.request || {};
        const line = {
            seq: step.seq,
            ts: step.ts,
            agent_id: step.agentId,
            model: step.model,
            status: step.status,
            latency_ms: step.latencyMs,
            error: step.error || null,
            response: step.response || null,
            truncated: !!req.truncated,
            replay_gap: false,
        };
        if (req.unmatched) {
            line.request = null;
            line.delta_messages = null;
            line.replay_gap = true;
            lines.push(line);
            continue;
        }
        const incoming = Array.isArray(req.messages) ? req.messages : [];
        if (req.snapshot) {
            ctx = incoming.slice();
        } else {
            const expectedBase = (Number(step.msgCount) || 0) - incoming.length;
            if (ctx.length !== expectedBase) line.replay_gap = true;
            ctx = ctx.concat(incoming);
        }
        line.msg_count = ctx.length;
        line.request = { params: req.params || {}, messages: ctx.slice() };
        // delta 行保留原始新增尾巴：并行合成调用（如 qwen memory）与真实调用
        // 交错时，线性重放的绝对位置会互相错位，提取器按 delta 原样消费才不丢消息
        line.delta_messages = req.snapshot ? null : incoming.slice();
        lines.push(line);
    }
    return lines;
}

module.exports = {
    recordRequest,
    recordResponse,
    recordFailure,
    getSteps,
    getAllSteps,
    getStats,
    subscribe,
    // exported for tests / skill pipeline consumers
    buildRequestRecord,
    parseResponseBytes,
    replayToFull,
    capRequestRecord,
    computeStats,
    isSyntheticBypassCall,
    isSyntheticUserMessage,
    samePrefix,
    getPrevMessages,
};
