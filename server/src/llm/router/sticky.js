const { and, eq } = require('drizzle-orm');
const { db, schema } = require('../../db');

const STICKY_TTL_MS = 10 * 60 * 1000;
const FAIL_THRESHOLD = 2;

/**
 * 粘性按 (sessionId, lineKey) 定位：一个 session 下可有多条并行对话线
 * （Agent 派生的并行子任务共用 sessionId），各自独立粘性，互不覆盖。
 * lineKey 为空串时退化为「一个 session 一条粘性」（历史行/无线索请求）。
 */
function stickyKey(sessionId, lineKey) {
    return { sessionId, lineKey: lineKey || '' };
}

async function getSticky(sessionId, lineKey) {
    const rows = await db
        .select()
        .from(schema.sessionRouteSticky)
        .where(and(
            eq(schema.sessionRouteSticky.sessionId, sessionId),
            eq(schema.sessionRouteSticky.lineKey, lineKey || ''),
        ))
        .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt <= Date.now()) return null;
    return {
        chosenModel: row.chosenModel,
        chosenProvider: row.chosenProvider,
        failCount: row.failCount,
        expiresAt: row.expiresAt,
    };
}

async function touchSticky(sessionId, lineKey, { chosenModel, chosenProvider }) {
    const now = Date.now();
    const expiresAt = now + STICKY_TTL_MS;
    const key = stickyKey(sessionId, lineKey);
    await db
        .insert(schema.sessionRouteSticky)
        .values({
            ...key,
            chosenModel,
            chosenProvider,
            failCount: 0,
            expiresAt,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: [schema.sessionRouteSticky.sessionId, schema.sessionRouteSticky.lineKey],
            set: {
                chosenModel,
                chosenProvider,
                failCount: 0,
                expiresAt,
                updatedAt: now,
            },
        });
}

async function recordStickyFailure(sessionId, lineKey) {
    const rows = await db
        .select()
        .from(schema.sessionRouteSticky)
        .where(and(
            eq(schema.sessionRouteSticky.sessionId, sessionId),
            eq(schema.sessionRouteSticky.lineKey, lineKey || ''),
        ))
        .limit(1);
    if (rows.length === 0) {
        return { failCount: 0, released: false };
    }
    const failCount = rows[0].failCount + 1;
    await db
        .update(schema.sessionRouteSticky)
        .set({ failCount, updatedAt: Date.now() })
        .where(and(
            eq(schema.sessionRouteSticky.sessionId, sessionId),
            eq(schema.sessionRouteSticky.lineKey, lineKey || ''),
        ));
    return { failCount, released: failCount >= FAIL_THRESHOLD };
}

module.exports = {
    STICKY_TTL_MS,
    FAIL_THRESHOLD,
    getSticky,
    touchSticky,
    recordStickyFailure,
};
