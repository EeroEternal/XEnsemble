const { eq } = require('drizzle-orm');
const { db, schema } = require('../../db');

const STICKY_TTL_MS = 10 * 60 * 1000;
const FAIL_THRESHOLD = 2;

async function getSticky(sessionId) {
    const rows = await db
        .select()
        .from(schema.sessionRouteSticky)
        .where(eq(schema.sessionRouteSticky.sessionId, sessionId))
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

async function touchSticky(sessionId, { chosenModel, chosenProvider }) {
    const now = Date.now();
    const expiresAt = now + STICKY_TTL_MS;
    await db
        .insert(schema.sessionRouteSticky)
        .values({
            sessionId,
            chosenModel,
            chosenProvider,
            failCount: 0,
            expiresAt,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: schema.sessionRouteSticky.sessionId,
            set: {
                chosenModel,
                chosenProvider,
                failCount: 0,
                expiresAt,
                updatedAt: now,
            },
        });
}

async function recordStickyFailure(sessionId) {
    const rows = await db
        .select()
        .from(schema.sessionRouteSticky)
        .where(eq(schema.sessionRouteSticky.sessionId, sessionId))
        .limit(1);
    if (rows.length === 0) {
        return { failCount: 0, released: false };
    }
    const failCount = rows[0].failCount + 1;
    if (failCount >= FAIL_THRESHOLD) {
        await db
            .delete(schema.sessionRouteSticky)
            .where(eq(schema.sessionRouteSticky.sessionId, sessionId));
        return { failCount, released: true };
    }
    await db
        .update(schema.sessionRouteSticky)
        .set({ failCount, updatedAt: Date.now() })
        .where(eq(schema.sessionRouteSticky.sessionId, sessionId));
    return { failCount, released: false };
}

module.exports = {
    STICKY_TTL_MS,
    FAIL_THRESHOLD,
    getSticky,
    touchSticky,
    recordStickyFailure,
};
