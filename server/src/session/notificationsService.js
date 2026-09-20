/**
 * 铃铛通知中心（PG 持久化）。
 *
 * 设计：docs/proposals/agent-attention-notification.md §4。
 * - 未读红点 / 角标数必须跨刷新、跨标签存活 → PostgreSQL（遵守 no-redis 规则）；
 * - 正文不落库：只存结构化 payload，文案由前端 t() 渲染（i18n 插值）；
 * - 防轰炸：session 类通知按 (userId, type, sessionId) 未读去重（覆盖更新）；
 * - 上限：每用户硬上限 MAX_PER_USER，写入时裁剪（先删最旧已读，再删最旧未读）；
 * - 通知绝不阻断主链路：所有失败只打日志。
 */

const crypto = require('crypto');

const MAX_PER_USER = Number(process.env.NOTIFICATIONS_MAX_PER_USER) || 200;
// 会话类通知做覆盖去重；skill 类不去重（每次提炼都是独立事件）。
const SESSION_TYPES = new Set(['session_completed', 'session_waiting']);

let dbOverride = null;
function getDb() {
    return dbOverride ?? require('../db/index').db;
}
function getSchema() {
    return require('../db/schema');
}

function newNotificationId() {
    return `ntf_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * 纯函数：给定某用户全部通知（按 createdAt 升序），选出超出上限需要删除的 id。
 * 策略：先删「最旧的已读」，仍超出再删「最旧的未读」（未读尽量保留）。
 */
function pickIdsToTrim(rows, cap = MAX_PER_USER) {
    if (!Array.isArray(rows) || rows.length <= cap) return [];
    let overflow = rows.length - cap;
    const toDelete = [];
    for (const r of rows) {
        if (overflow <= 0) break;
        if (r.readAt != null) { toDelete.push(r.id); overflow -= 1; }
    }
    const chosen = new Set(toDelete);
    for (const r of rows) {
        if (overflow <= 0) break;
        if (r.readAt == null && !chosen.has(r.id)) { chosen.add(r.id); overflow -= 1; }
    }
    return [...chosen];
}

function encodeCursor(createdAt, id) {
    return `${createdAt}_${id}`;
}

function decodeCursor(cursor) {
    const m = /^(\d+)_(.+)$/.exec(String(cursor || ''));
    if (!m) return null;
    const ts = Number(m[1]);
    if (!Number.isFinite(ts)) return null;
    return { ts, id: m[2] };
}

/**
 * 写入一条通知。
 * @returns {Promise<string|null>} notification id（失败返回 null，不抛出）
 */
async function notify({ userId, type, payload = {} }) {
    if (!userId || !type) return null;
    const db = getDb();
    const schema = getSchema();
    const now = Date.now();
    try {
        if (SESSION_TYPES.has(type) && payload.sessionId) {
            // 覆盖去重：同会话同类型未读只保留一条（更新时间与 payload 快照）。
            const { and, eq, isNull, sql } = require('drizzle-orm');
            const existing = await db
                .select({ id: schema.notifications.id })
                .from(schema.notifications)
                .where(and(
                    eq(schema.notifications.userId, userId),
                    eq(schema.notifications.type, type),
                    isNull(schema.notifications.readAt),
                    sql`(${schema.notifications.payload}->>'sessionId') = ${String(payload.sessionId)}`,
                ))
                .limit(1);
            if (existing[0]) {
                await db.update(schema.notifications)
                    .set({ payload, createdAt: now })
                    .where(eq(schema.notifications.id, existing[0].id));
                return existing[0].id;
            }
        }
        const id = newNotificationId();
        await db.insert(schema.notifications).values({
            id,
            userId,
            type,
            payload,
            readAt: null,
            createdAt: now,
        });
        await trimForUser(userId);
        return id;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[notifications] notify failed:', err?.message || err);
        return null;
    }
}

/**
 * 自动提炼产出新 skill → skill_created 通知。
 * payload 里的 sessionTitle / projectName 是时间点快照（会话改名/删除后文案不悬空）。
 */
async function notifySkillCreated({ userId, skill }) {
    if (!userId || !skill) return null;
    let sessionTitle = null;
    let projectName = null;
    try {
        const db = getDb();
        const schema = getSchema();
        const { eq } = require('drizzle-orm');
        if (skill.sessionId) {
            const rows = await db
                .select({ title: schema.sessions.title })
                .from(schema.sessions)
                .where(eq(schema.sessions.id, skill.sessionId))
                .limit(1);
            sessionTitle = rows[0]?.title || null;
        }
        if (skill.projectId) {
            const rows = await db
                .select({ name: schema.projects.name })
                .from(schema.projects)
                .where(eq(schema.projects.id, skill.projectId))
                .limit(1);
            projectName = rows[0]?.name || null;
        }
    } catch (_) { /* 快照缺省不阻塞 */ }
    return notify({
        userId,
        type: 'skill_created',
        payload: {
            skillId: skill.id,
            skillTitle: skill.title,
            sessionId: skill.sessionId || null,
            sessionTitle,
            projectName,
        },
    });
}

/** 写入后裁剪：保持每用户 ≤ MAX_PER_USER 条（最新优先保留）。 */
async function trimForUser(userId) {
    const db = getDb();
    const schema = getSchema();
    const { asc, eq, inArray } = require('drizzle-orm');
    const rows = await db
        .select({ id: schema.notifications.id, readAt: schema.notifications.readAt })
        .from(schema.notifications)
        .where(eq(schema.notifications.userId, userId))
        .orderBy(asc(schema.notifications.createdAt));
    const ids = pickIdsToTrim(rows, MAX_PER_USER);
    if (ids.length > 0) {
        const { and } = require('drizzle-orm');
        await db.delete(schema.notifications)
            .where(and(eq(schema.notifications.userId, userId), inArray(schema.notifications.id, ids)));
    }
}

/**
 * 游标分页列表（倒序）。before 缺省 = 第一页。
 * @returns {Promise<{items, nextCursor, unreadCount}>}
 */
async function list({ userId, limit = 20, before = null } = {}) {
    const db = getDb();
    const schema = getSchema();
    const { and, desc, eq, lt, or } = require('drizzle-orm');
    const l = Math.min(100, Math.max(1, Number(limit) || 20));
    const conds = [eq(schema.notifications.userId, userId)];
    const cur = decodeCursor(before);
    if (cur) {
        conds.push(or(
            lt(schema.notifications.createdAt, cur.ts),
            and(eq(schema.notifications.createdAt, cur.ts), lt(schema.notifications.id, cur.id)),
        ));
    }
    const rows = await db
        .select()
        .from(schema.notifications)
        .where(and(...conds))
        .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
        .limit(l + 1);
    const hasMore = rows.length > l;
    const items = rows.slice(0, l).map((r) => ({
        id: r.id,
        type: r.type,
        payload: r.payload || {},
        readAt: r.readAt ?? null,
        createdAt: r.createdAt,
    }));
    const unread = await unreadCount(userId);
    return {
        items,
        nextCursor: hasMore ? encodeCursor(rows[l - 1].createdAt, rows[l - 1].id) : null,
        unreadCount: unread,
    };
}

async function unreadCount(userId) {
    const db = getDb();
    const schema = getSchema();
    const { and, eq, isNull, sql } = require('drizzle-orm');
    const rows = await db
        .select({ n: sql`count(*)::int` })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
    return Number(rows[0]?.n ?? 0);
}

/** 全部已读。@returns {Promise<number>} 更新条数 */
async function readAll(userId) {
    const db = getDb();
    const schema = getSchema();
    const { and, eq, isNull } = require('drizzle-orm');
    const updated = await db
        .update(schema.notifications)
        .set({ readAt: Date.now() })
        .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)))
        .returning({ id: schema.notifications.id });
    return updated.length;
}

/** 单条已读（只允许自己的通知）。@returns {Promise<boolean>} */
async function markRead(userId, id) {
    if (!userId || !id) return false;
    const db = getDb();
    const schema = getSchema();
    const { and, eq, isNull } = require('drizzle-orm');
    const updated = await db
        .update(schema.notifications)
        .set({ readAt: Date.now() })
        .where(and(
            eq(schema.notifications.userId, userId),
            eq(schema.notifications.id, id),
            isNull(schema.notifications.readAt),
        ))
        .returning({ id: schema.notifications.id });
    return updated.length > 0;
}

// 便于单测注入假 db（与 TranscriptStore options.db 同思路）。
function _setDbForTest(db) { dbOverride = db; }

module.exports = {
    notify,
    notifySkillCreated,
    list,
    unreadCount,
    readAll,
    markRead,
    pickIdsToTrim,
    encodeCursor,
    decodeCursor,
    MAX_PER_USER,
    _setDbForTest,
};

