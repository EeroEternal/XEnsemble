const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq, and, sql, inArray } = require('drizzle-orm');
const installedAgents = require('../agents/installedAgents');
const { probeAgent } = require('../agents/agentProbe');
const { resolveRuntimeProvider } = require('../config/runtimeProvider');

const IS_LOCAL_RUNTIME = resolveRuntimeProvider() === 'local';

const DIMENSION_LIMIT = {
    projects: 'maxProjects',
    sessions: 'maxSessions',
    previews: 'maxPreviews',
};

const DEFAULT_QUOTA = {
    maxProjects: 5,
    maxSessions: 2,
    maxPreviews: 1,
    maxRuntimes: 1,
    resourceTier: 'basic',
};

async function ensureUserQuota(userId) {
    const rows = await db.select().from(schema.userQuotas).where(eq(schema.userQuotas.userId, userId));
    if (rows.length > 0) return rows[0];

    const platformSettings = require('../admin/PlatformSettings');
    const defaults = await platformSettings.getDefaultUserQuota();
    const now = Date.now();
    const values = {
        userId,
        maxProjects: defaults.max_projects ?? defaults.maxProjects ?? DEFAULT_QUOTA.maxProjects,
        maxSessions: defaults.max_sessions ?? defaults.maxSessions ?? DEFAULT_QUOTA.maxSessions,
        maxPreviews: defaults.max_previews ?? defaults.maxPreviews ?? DEFAULT_QUOTA.maxPreviews,
        maxRuntimes: defaults.max_runtimes ?? defaults.maxRuntimes ?? DEFAULT_QUOTA.maxRuntimes,
        resourceTier: defaults.resource_tier ?? defaults.resourceTier ?? DEFAULT_QUOTA.resourceTier,
        updatedAt: now,
    };
    await db.insert(schema.userQuotas).values(values);
    return values;
}

async function getUsage(userId) {
    const [projectRow, sessionRow, previewRow] = await Promise.all([
        db.select({ count: sql`count(*)` })
            .from(schema.projects)
            .where(eq(schema.projects.userId, userId)),
        db.select({ count: sql`count(*)` })
            .from(schema.sessions)
            .where(and(
                eq(schema.sessions.userId, userId),
                inArray(schema.sessions.status, ['pending', 'running', 'idle']),
            )),
        db.select({ count: sql`count(*)` })
            .from(schema.deployments)
            .where(and(
                eq(schema.deployments.userId, userId),
                eq(schema.deployments.kind, 'preview'),
                inArray(schema.deployments.status, ['pending', 'building', 'running']),
            )),
    ]);

    return {
        projects: Number(projectRow?.[0]?.count ?? 0),
        sessions: Number(sessionRow?.[0]?.count ?? 0),
        previews: Number(previewRow?.[0]?.count ?? 0),
    };
}

function formatQuota(quotaRow, usage) {
    return {
        max_projects: quotaRow.maxProjects,
        max_sessions: quotaRow.maxSessions,
        max_previews: quotaRow.maxPreviews,
        max_runtimes: quotaRow.maxRuntimes,
        resource_tier: quotaRow.resourceTier,
        usage,
    };
}

async function getEffectiveQuota(userId, role) {
    const [quotaRow, usage] = await Promise.all([
        ensureUserQuota(userId),
        getUsage(userId),
    ]);
    const formatted = formatQuota(quotaRow, usage);
    if (role === 'admin') {
        formatted.max_projects = null;
        formatted.max_sessions = null;
        formatted.max_previews = null;
        formatted.max_runtimes = null;
    }
    return formatted;
}

async function checkQuota(userId, dimension, role) {
    if (role === 'admin') return { ok: true };

    const limitKey = DIMENSION_LIMIT[dimension];
    if (!limitKey) {
        throw new Error(`Unknown quota dimension: ${dimension}`);
    }
    const quotaRow = await ensureUserQuota(userId);
    const usage = await getUsage(userId);
    const limit = quotaRow[limitKey];
    const current = usage[dimension];
    if (current >= limit) {
        return {
            ok: false,
            error: 'quota_exceeded',
            dimension: `max_${dimension}`,
            limit,
            current,
        };
    }
    return { ok: true };
}

async function listGrantedAgentIds(userId, role) {
    const installedSet = new Set(await installedAgents.listInstalledAgentIds());
    if (role === 'admin') {
        return [...installedSet];
    }
    const grants = await db
        .select({ agentId: schema.userAgentGrants.agentId })
        .from(schema.userAgentGrants)
        .innerJoin(schema.agents, eq(schema.userAgentGrants.agentId, schema.agents.id))
        .where(eq(schema.userAgentGrants.userId, userId));
    return grants.map((g) => g.agentId).filter((id) => installedSet.has(id));
}

async function checkAgentAccess(userId, agentId, role) {
    const agentRows = await db
        .select({ id: schema.agents.id, cmd: schema.agents.cmd })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId));
    if (agentRows.length === 0) {
        return { ok: false, error: 'agent_not_found', agent_id: agentId };
    }
    if (IS_LOCAL_RUNTIME && !probeAgent(agentRows[0].cmd).installed) {
        return { ok: false, error: 'agent_not_installed', agent_id: agentId };
    }
    if (role === 'admin') return { ok: true };
    const grants = await db
        .select()
        .from(schema.userAgentGrants)
        .where(and(
            eq(schema.userAgentGrants.userId, userId),
            eq(schema.userAgentGrants.agentId, agentId),
        ));
    if (grants.length === 0) {
        return { ok: false, error: 'agent_not_granted', agent_id: agentId };
    }
    return { ok: true };
}

function quotaErrorReply(reply, result) {
    return reply.code(429).send({
        error: result.error,
        dimension: result.dimension,
        limit: result.limit,
        current: result.current,
    });
}

function agentAccessErrorReply(reply, result) {
    return reply.code(403).send({
        error: result.error,
        agent_id: result.agent_id,
    });
}

module.exports = {
    DEFAULT_QUOTA,
    ensureUserQuota,
    getUsage,
    getEffectiveQuota,
    checkQuota,
    checkAgentAccess,
    listGrantedAgentIds,
    quotaErrorReply,
    agentAccessErrorReply,
    formatQuota,
};
