const { and, eq } = require('drizzle-orm');
const { db, schema } = require('../../db');

async function insertDecision(row) {
    await db.insert(schema.routingDecisions).values({
        ...row,
        demand: null,
        createdAt: row.createdAt ?? Date.now(),
    });
}

async function patchDecisionUsage({
    sessionId,
    seq,
    promptTokens,
    cachedTokens,
    completionTokens,
    latencyMs,
    statusCode,
    error,
}) {
    await db
        .update(schema.routingDecisions)
        .set({
            promptTokens,
            cachedTokens,
            completionTokens,
            latencyMs,
            statusCode,
            error,
        })
        .where(and(
            eq(schema.routingDecisions.sessionId, sessionId),
            eq(schema.routingDecisions.seq, seq),
        ));
}

module.exports = {
    insertDecision,
    patchDecisionUsage,
};
