const { desc, eq } = require('drizzle-orm');
const { db, schema } = require('../../db');

async function loadLastSessionUsage(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    const rows = await db
        .select({
            promptTokens: schema.llmUsage.promptTokens,
            cachedTokens: schema.llmUsage.cachedTokens,
        })
        .from(schema.llmUsage)
        .where(eq(schema.llmUsage.sessionId, sid))
        .orderBy(desc(schema.llmUsage.createdAt), desc(schema.llmUsage.id))
        .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
        promptTokens: row.promptTokens,
        cachedTokens: row.cachedTokens,
    };
}

module.exports = { loadLastSessionUsage };
