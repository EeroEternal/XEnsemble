const { eq, sql, inArray, isNull, and, isNotNull } = require('drizzle-orm');
const schema = require('./schema');
const { DEFAULT_AGENTS } = require('../agents/defaultAgents');
const { seedDefaults: seedPlatformDefaults } = require('../admin/PlatformSettings');
const { backfillDefaultRuntimes } = require('./backfillRuntimes');

const REMOVED_AGENT_IDS = ['xagent', 'xagent-cli'];

/**
 * 幂等种子：平台设置、默认 Agent、用户配额/授权、Git 遗留数据回填。
 * @param {import('drizzle-orm/postgres-js').PostgresJsDatabase} db
 */
async function seedIfNeeded(db) {
    await seedPlatformDefaults(db);

    await db.update(schema.users)
        .set({ status: 'active' })
        .where(isNull(schema.users.status));

    const defaultQuota = await getDefaultQuota(db);
    const allUsers = await db.select({ id: schema.users.id, role: schema.users.role }).from(schema.users);

    const now = Date.now();
    for (const u of allUsers) {
        await db.insert(schema.userQuotas).values({
            userId: u.id,
            maxProjects: defaultQuota.max_projects ?? 5,
            maxSessions: defaultQuota.max_sessions ?? 2,
            maxPreviews: defaultQuota.max_previews ?? 5,
            maxRuntimes: defaultQuota.max_runtimes ?? 1,
            resourceTier: defaultQuota.resource_tier ?? 'basic',
            updatedAt: now,
        }).onConflictDoNothing();
    }

    for (const agent of DEFAULT_AGENTS) {
        await db.insert(schema.agents).values({
            id: agent.id,
            name: agent.name,
            cmd: agent.cmd,
            args: JSON.stringify(agent.args || []),
            envRequired: JSON.stringify(agent.env_required || []),
        }).onConflictDoNothing();

        await db.update(schema.agents).set({
            name: agent.name,
            cmd: agent.cmd,
            args: JSON.stringify(agent.args || []),
            envRequired: JSON.stringify(agent.env_required || []),
        }).where(eq(schema.agents.id, agent.id));
    }

    await db.delete(schema.userAgentGrants)
        .where(inArray(schema.userAgentGrants.agentId, REMOVED_AGENT_IDS));
    await db.delete(schema.agents)
        .where(inArray(schema.agents.id, REMOVED_AGENT_IDS));

    const agentRows = await db.select({ id: schema.agents.id }).from(schema.agents);
    const agentIds = agentRows.map((r) => r.id);
    if (agentIds.length > 0) {
        for (const u of allUsers) {
            if (u.role === 'admin') continue;
            const grants = await db.select().from(schema.userAgentGrants)
                .where(eq(schema.userAgentGrants.userId, u.id));
            if (grants.length > 0) continue;
            for (const agentId of agentIds) {
                await db.insert(schema.userAgentGrants).values({
                    userId: u.id,
                    agentId,
                    grantedAt: now,
                }).onConflictDoNothing();
            }
        }
    }

    await migrateGithubConnectionsToGit(db);
    await backfillRemoteRepoFields(db);
    await backfillDefaultRuntimes(db);
    await backfillPreviewQuotaDefault(db);
}

// 默认并发预览从 1 提升到 5：升级已固化的 default_user_quota（仅当其
// max_previews 仍是旧默认 1 时，避免覆盖 admin 手动改过的更大值）。
async function backfillPreviewQuotaDefault(db) {
    const rows = await db.select().from(schema.platformSettings)
        .where(eq(schema.platformSettings.key, 'default_user_quota'));
    if (rows.length === 0) return;
    let quota;
    try { quota = JSON.parse(rows[0].value); } catch { return; }
    if (!quota || typeof quota !== 'object') return;
    if (Number(quota.max_previews) === 1) {
        quota.max_previews = 5;
        await db.update(schema.platformSettings)
            .set({ value: JSON.stringify(quota) })
            .where(eq(schema.platformSettings.key, 'default_user_quota'));
    }
}

async function getDefaultQuota(db) {
    const rows = await db.select().from(schema.platformSettings)
        .where(eq(schema.platformSettings.key, 'default_user_quota'));
    if (rows.length === 0) {
        return {
            max_projects: 5,
            max_sessions: 2,
            max_previews: 5,
            max_runtimes: 1,
            resource_tier: 'basic',
        };
    }
    try {
        return JSON.parse(rows[0].value);
    } catch {
        return {
            max_projects: 5,
            max_sessions: 2,
            max_previews: 5,
            max_runtimes: 1,
            resource_tier: 'basic',
        };
    }
}

async function migrateGithubConnectionsToGit(db) {
    const existingGit = await db.select({ id: schema.gitConnections.id }).from(schema.gitConnections);
    const existingIds = new Set(existingGit.map((r) => r.id));
    const ghConns = await db.select().from(schema.githubConnections);
    for (const row of ghConns) {
        if (existingIds.has(row.id)) continue;
        await db.insert(schema.gitConnections).values({
            id: row.id,
            userId: row.userId,
            provider: 'github',
            remoteUserId: String(row.githubUserId),
            remoteUsername: row.githubUsername,
            remoteAvatar: row.githubAvatar,
            accessTokenEnc: row.accessTokenEnc,
            tokenScope: row.tokenScope,
            connectedAt: row.connectedAt,
            lastUsedAt: row.lastUsedAt,
            revokedAt: row.revokedAt,
        }).onConflictDoNothing();
    }
}

async function backfillRemoteRepoFields(db) {
    await db.update(schema.projects)
        .set({
            remoteRepoId: sql`CAST(${schema.projects.githubRepoId} AS TEXT)`,
            remoteFullName: schema.projects.githubFullName,
        })
        .where(and(
            isNotNull(schema.projects.githubRepoId),
            isNull(schema.projects.remoteRepoId),
        ));
}

module.exports = { seedIfNeeded };
