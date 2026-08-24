const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq, and } = require('drizzle-orm');
const { hasBoxImage } = require('../runtime/agentBoxImages');

async function listInstalledAgentRows() {
    const rows = await db.select().from(schema.agents);
    const activeRefs = await db.select({ agentId: schema.agentBoxImages.agentId })
        .from(schema.agentBoxImages)
        .where(and(
            eq(schema.agentBoxImages.isActive, true),
            eq(schema.agentBoxImages.status, 'ready'),
        ));
    const activeSet = new Set(activeRefs.map((r) => r.agentId));
    return rows.filter((row) => activeSet.has(row.id) || hasBoxImage(row.id));
}

async function listInstalledAgentIds() {
    const rows = await listInstalledAgentRows();
    return rows.map((row) => row.id);
}

module.exports = {
    listInstalledAgentRows,
    listInstalledAgentIds,
};
