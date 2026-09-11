const crypto = require('crypto');
const { isUniqueViolation } = require('../http/publicError');
const { t } = require('../i18n');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq, and, sql, inArray, ne, isNull, gt, gte } = require('drizzle-orm');
const auth = require('../auth/index');
const policy = require('../auth/PolicyService');
const platformSettings = require('./PlatformSettings');
const installedAgents = require('../agents/installedAgents');
const { recordEvent } = require('../events/recordEvent');
const { invalidateUserStatusCache } = require('../auth/assertActiveUser');

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function createRefreshToken(userId, deviceName = null, tx = null) {
    const raw = auth.generateRefreshTokenValue();
    const tokenHash = auth.hashToken(raw);
    const now = Date.now();
    const id = `rt_${crypto.randomBytes(8).toString('hex')}`;
    const client = tx || db;
    await client.insert(schema.refreshTokens).values({
        id,
        userId,
        tokenHash,
        deviceName,
        createdAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
    });
    return raw;
}

async function useRefreshToken(oldRawToken, userId, deviceName = null) {
    const oldHash = auth.hashToken(oldRawToken);
    const now = Date.now();
    return db.transaction(async (tx) => {
        const rows = await tx.select().from(schema.refreshTokens)
            .where(and(
                eq(schema.refreshTokens.tokenHash, oldHash),
                eq(schema.refreshTokens.userId, userId),
                isNull(schema.refreshTokens.revokedAt),
                gt(schema.refreshTokens.expiresAt, now),
            ));
        if (rows.length === 0) {
            return null;
        }
        // 不轮换：并发 refresh 友好。refresh token 一直有效到 expiresAt 或被主动撤销
        //（如改密码）。原 raw token 原样返回，access token 重新签发。安全 trade-off：
        // refresh token 泄露后最长影响至 expiresAt（30 天），但 race condition 根除
        // —— 多标签页/多 SSE 并发 refresh 不再互踢。
        return oldRawToken;
    });
}

async function revokeAllUserRefreshTokens(userId) {
    await db.update(schema.refreshTokens)
        .set({ revokedAt: Date.now() })
        .where(eq(schema.refreshTokens.userId, userId));
}

function formatUserRow(user, extras = {}) {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status || 'active',
        email: user.email || null,
        display_name: user.displayName || null,
        created_at: user.createdAt,
        last_login_at: user.lastLoginAt || null,
        ...extras,
    };
}

async function countActiveAdmins(excludeUserId = null) {
    const rows = await db
        .select({ count: sql`count(*)` })
        .from(schema.users)
        .where(and(
            eq(schema.users.role, 'admin'),
            eq(schema.users.status, 'active'),
        ));
    let count = Number(rows[0]?.count ?? 0);
    if (excludeUserId) {
        const target = await getUserById(excludeUserId);
        if (target?.role === 'admin' && target?.status === 'active') count -= 1;
    }
    return count;
}

async function getUserById(userId) {
    const rows = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    return rows[0] ?? null;
}

async function getUsageSummary(userId) {
    const usage = await policy.getUsage(userId);
    return {
        projects_count: usage.projects,
        active_sessions: usage.sessions,
        active_previews: usage.previews,
    };
}

async function listUsers() {
    const users = await db.select().from(schema.users);
    users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    // 7 天 Token 用量：单条 GROUP BY 聚合（避免每用户一次查询的 N+1）
    const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const usageRows = await db
        .select({
            userId: schema.llmUsage.userId,
            total: sql`coalesce(sum(${schema.llmUsage.totalTokens}), 0)::int`,
        })
        .from(schema.llmUsage)
        .where(gte(schema.llmUsage.createdAt, since7d))
        .groupBy(schema.llmUsage.userId);
    const usage7dByUser = new Map(usageRows.map((r) => [r.userId, Number(r.total || 0)]));
    const result = [];
    for (const user of users) {
        const usage = await getUsageSummary(user.id);
        const quota = await policy.getEffectiveQuota(user.id, user.role);
        const grantedIds = await policy.listGrantedAgentIds(user.id, user.role);
        result.push(formatUserRow(user, {
            ...usage,
            usage_7d_total_tokens: usage7dByUser.get(user.id) || 0,
            quotas: {
                max_projects: quota.max_projects,
                max_sessions: quota.max_sessions,
                max_previews: quota.max_previews,
                resource_tier: quota.resource_tier,
            },
            granted_agents_count: user.role === 'admin' ? null : grantedIds.length,
        }));
    }
    return result;
}

async function getUserDetail(userId) {
    const user = await getUserById(userId);
    if (!user) return null;
    const quota = await policy.getEffectiveQuota(userId, user.role);
    const grants = await policy.listGrantedAgentIds(userId, user.role);
    return {
        ...formatUserRow(user, await getUsageSummary(userId)),
        quotas: quota,
        granted_agent_ids: grants,
    };
}

async function createUser({ username, password, role = 'user', status = 'active', displayName, email, quota, agentIds }, createdBy) {
    if (!username || !password) {
        throw Object.assign(new Error('username and password are required'), { statusCode: 400, code: 'username_password_required' });
    }
    if (password.length < 8) {
        throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400, code: 'password_too_short' });
    }

    const userId = `usr_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const usersCount = await db.select({ count: sql`count(*)` }).from(schema.users);
    // postgres-js 返回 count 为字符串，须转数字再比较
    const isFirstUser = Number(usersCount[0].count) === 0;
    const effectiveRole = isFirstUser ? 'admin' : role;
    const effectiveStatus = isFirstUser ? 'active' : status;

    try {
        await db.insert(schema.users).values({
            id: userId,
            username,
            passwordHash: auth.hashPassword(password),
            role: effectiveRole,
            status: effectiveStatus,
            email: email || null,
            displayName: displayName || null,
            createdAt: now,
            updatedAt: now,
        });
    } catch (err) {
        if (isUniqueViolation(err)) {
            throw Object.assign(new Error('Username already exists'), { statusCode: 400, code: 'username_exists' });
        }
        throw err;
    }

    const defaults = await platformSettings.getDefaultUserQuota();
    await db.insert(schema.userQuotas).values({
        userId,
        maxProjects: quota?.max_projects ?? defaults.max_projects ?? policy.DEFAULT_QUOTA.maxProjects,
        maxSessions: quota?.max_sessions ?? defaults.max_sessions ?? policy.DEFAULT_QUOTA.maxSessions,
        maxPreviews: quota?.max_previews ?? defaults.max_previews ?? policy.DEFAULT_QUOTA.maxPreviews,
        maxRuntimes: quota?.max_runtimes ?? defaults.max_runtimes ?? policy.DEFAULT_QUOTA.maxRuntimes,
        resourceTier: quota?.resource_tier ?? defaults.resource_tier ?? policy.DEFAULT_QUOTA.resourceTier,
        updatedBy: createdBy ?? null,
        updatedAt: now,
    });

    if (effectiveRole !== 'admin') {
        let idsToGrant = agentIds;
        if (!Array.isArray(agentIds)) {
            idsToGrant = await installedAgents.listInstalledAgentIds();
        }
        if (idsToGrant.length > 0) {
            await setUserAgents(userId, idsToGrant, createdBy);
        }
    }

    await recordEvent({
        userId: createdBy,
        subjectType: 'user',
        subjectId: userId,
        type: 'created',
        data: { username, role: effectiveRole, status: effectiveStatus },
    });

    return getUserDetail(userId);
}

async function registerUser({ username, password }) {
    if (!username || !password) {
        throw Object.assign(new Error('username and password are required'), { statusCode: 400, code: 'username_password_required' });
    }
    if (password.length < 8) {
        throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400, code: 'password_too_short' });
    }

    const mode = await platformSettings.getRegistrationMode();
    if (mode === 'admin_only') {
        throw Object.assign(new Error('Registration is disabled. Contact an administrator.'), { statusCode: 403, code: 'registration_disabled' });
    }
    if (mode === 'invite_only') {
        throw Object.assign(new Error('Registration requires an invite.'), { statusCode: 403, code: 'registration_requires_invite' });
    }

    const usersCount = await db.select({ count: sql`count(*)` }).from(schema.users);
    const isFirst = Number(usersCount[0].count) === 0;
    const role = isFirst ? 'admin' : 'user';
    const status = mode === 'approval' && !isFirst ? 'pending' : 'active';

    const user = await createUser({ username, password, role, status }, null);
    return { user, status, autoLogin: status === 'active' };
}

async function updateUser(userId, patch, actorId) {
    const user = await getUserById(userId);
    if (!user) return null;

    const updates = { updatedAt: Date.now() };
    if (patch.display_name !== undefined) updates.displayName = patch.display_name || null;
    if (patch.email !== undefined) updates.email = patch.email || null;

    if (patch.role !== undefined && patch.role !== user.role) {
        if (user.role === 'admin' && patch.role !== 'admin') {
            const admins = await countActiveAdmins(userId);
            if (admins < 1) {
                throw Object.assign(new Error('Cannot demote the last active administrator'), { statusCode: 400, code: 'cannot_demote_last_admin' });
            }
        }
        updates.role = patch.role;
    }

    if (patch.status !== undefined && patch.status !== user.status) {
        if (user.role === 'admin' && patch.status !== 'active') {
            const admins = await countActiveAdmins(userId);
            if (admins < 1) {
                throw Object.assign(new Error('Cannot suspend the last active administrator'), { statusCode: 400, code: 'cannot_suspend_last_admin' });
            }
        }
        updates.status = patch.status;
        await recordEvent({
            userId: actorId,
            subjectType: 'user',
            subjectId: userId,
            type: patch.status === 'active' ? 'activated' : 'suspended',
            data: { from: user.status, to: patch.status },
        });
    }

    if (Object.keys(updates).length > 1) {
        await db.update(schema.users).set(updates).where(eq(schema.users.id, userId));
        // Invalidate the cached user status so the next request picks up the change.
        if (updates.status) {
            invalidateUserStatusCache(userId);
        }
    }

    return getUserDetail(userId);
}

async function suspendUser(userId, actorId) {
    return updateUser(userId, { status: 'suspended' }, actorId);
}

async function setUserQuota(userId, quotaPatch, actorId) {
    await policy.ensureUserQuota(userId);
    const before = await policy.ensureUserQuota(userId);
    const updates = { updatedBy: actorId, updatedAt: Date.now() };

    if (quotaPatch.max_projects !== undefined) updates.maxProjects = quotaPatch.max_projects;
    if (quotaPatch.max_sessions !== undefined) updates.maxSessions = quotaPatch.max_sessions;
    if (quotaPatch.max_previews !== undefined) updates.maxPreviews = quotaPatch.max_previews;
    if (quotaPatch.max_runtimes !== undefined) updates.maxRuntimes = quotaPatch.max_runtimes;
    if (quotaPatch.resource_tier !== undefined) updates.resourceTier = quotaPatch.resource_tier;

    await db.update(schema.userQuotas).set(updates).where(eq(schema.userQuotas.userId, userId));

    await recordEvent({
        userId: actorId,
        subjectType: 'user',
        subjectId: userId,
        type: 'quota_updated',
        data: { before: policy.formatQuota(before, await policy.getUsage(userId)), patch: quotaPatch },
    });

    return policy.getEffectiveQuota(userId);
}

async function setUserAgents(userId, agentIds, actorId) {
    const uniqueIds = [...new Set(agentIds)];
    if (uniqueIds.length > 0) {
        const existing = await db.select({ id: schema.agents.id }).from(schema.agents)
            .where(inArray(schema.agents.id, uniqueIds));
        const found = new Set(existing.map((a) => a.id));
        const missing = uniqueIds.filter((id) => !found.has(id));
        if (missing.length > 0) {
            throw Object.assign(new Error(`Unknown agent(s): ${missing.join(', ')}`), { statusCode: 400 });
        }
    }

    await db.delete(schema.userAgentGrants).where(eq(schema.userAgentGrants.userId, userId));

    const now = Date.now();
    for (const agentId of uniqueIds) {
        await db.insert(schema.userAgentGrants).values({
            userId,
            agentId,
            grantedBy: actorId,
            grantedAt: now,
        });
    }

    await recordEvent({
        userId: actorId,
        subjectType: 'user',
        subjectId: userId,
        type: 'agent_granted',
        data: { agent_ids: uniqueIds },
    });

    return uniqueIds;
}

async function grantAgent(userId, agentId, actorId) {
    const grants = await db.select().from(schema.userAgentGrants)
        .where(and(eq(schema.userAgentGrants.userId, userId), eq(schema.userAgentGrants.agentId, agentId)));
    if (grants.length > 0) return grants[0];

    const now = Date.now();
    await db.insert(schema.userAgentGrants).values({
        userId,
        agentId,
        grantedBy: actorId,
        grantedAt: now,
    });

    await recordEvent({
        userId: actorId,
        subjectType: 'user',
        subjectId: userId,
        type: 'agent_granted',
        data: { agent_id: agentId },
    });

    return { userId, agentId };
}

/**
 * Grant one agent to every non-admin user who does not already have it.
 * Used after a successful server install and on startup backfill.
 */
async function grantAgentToAllNonAdminUsers(agentId, actorId = null, { recordEvent: shouldRecord = true } = {}) {
    const agentRows = await db.select({ id: schema.agents.id }).from(schema.agents)
        .where(eq(schema.agents.id, agentId));
    if (agentRows.length === 0) {
        throw Object.assign(new Error(`Unknown agent: ${agentId}`), { statusCode: 400 });
    }

    const users = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(ne(schema.users.role, 'admin'));
    if (users.length === 0) {
        return { granted_count: 0, user_count: 0 };
    }

    const existing = await db
        .select({ userId: schema.userAgentGrants.userId })
        .from(schema.userAgentGrants)
        .where(eq(schema.userAgentGrants.agentId, agentId));
    const existingSet = new Set(existing.map((row) => row.userId));

    const now = Date.now();
    let grantedCount = 0;
    for (const user of users) {
        if (existingSet.has(user.id)) continue;
        await db.insert(schema.userAgentGrants).values({
            userId: user.id,
            agentId,
            grantedBy: actorId,
            grantedAt: now,
        });
        grantedCount += 1;
    }

    if (shouldRecord && grantedCount > 0) {
        await recordEvent({
            userId: actorId,
            subjectType: 'agent',
            subjectId: agentId,
            type: 'agent_granted',
            data: { granted_to_all_users: true, user_count: grantedCount },
        });
    }

    return { granted_count: grantedCount, user_count: users.length };
}

/** Ensure every installed agent is granted to all non-admin users (idempotent). */
async function syncInstalledAgentGrantsForAllUsers(actorId = null) {
    const agentIds = await installedAgents.listInstalledAgentIds();
    let grantedCount = 0;
    for (const agentId of agentIds) {
        const result = await grantAgentToAllNonAdminUsers(agentId, actorId, { recordEvent: false });
        grantedCount += result.granted_count;
    }
    if (grantedCount > 0) {
        await recordEvent({
            userId: actorId,
            subjectType: 'platform',
            subjectId: 'agent_grants',
            type: 'agent_granted',
            data: { sync_installed_agents: true, grant_count: grantedCount, agent_count: agentIds.length },
        });
    }
    return { agent_count: agentIds.length, granted_count: grantedCount };
}

async function revokeAgent(userId, agentId, actorId) {
    await db.delete(schema.userAgentGrants).where(and(
        eq(schema.userAgentGrants.userId, userId),
        eq(schema.userAgentGrants.agentId, agentId),
    ));

    await recordEvent({
        userId: actorId,
        subjectType: 'user',
        subjectId: userId,
        type: 'agent_revoked',
        data: { agent_id: agentId },
    });

    return { ok: true };
}

async function resetPassword(userId, newPassword, actorId) {
    if (!newPassword || newPassword.length < 8) {
        throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400, code: 'password_too_short' });
    }
    const user = await getUserById(userId);
    if (!user) return null;

    await db.update(schema.users).set({
        passwordHash: auth.hashPassword(newPassword),
        updatedAt: Date.now(),
    }).where(eq(schema.users.id, userId));

    await recordEvent({
        userId: actorId,
        subjectType: 'user',
        subjectId: userId,
        type: 'password_reset',
        data: { by_admin: actorId !== userId },
    });

    return { ok: true };
}

async function loginUser(username, password, deviceName = null) {
    const users = await db.select().from(schema.users).where(eq(schema.users.username, username));
    if (users.length === 0 || !auth.verifyPassword(password, users[0].passwordHash)) {
        throw Object.assign(new Error('Invalid credentials'), { statusCode: 401, code: 'invalid_credentials' });
    }
    const user = users[0];
    const status = user.status || 'active';

    if (status === 'pending') {
        throw Object.assign(new Error('Account pending approval'), { statusCode: 403, code: 'account_pending' });
    }
    if (status === 'suspended') {
        throw Object.assign(new Error('Account suspended'), { statusCode: 403, code: 'account_suspended' });
    }

    // Ensure quota row exists before the login transaction; it does not accept a tx handle.
    await policy.ensureUserQuota(user.id);

    const refreshToken = await db.transaction(async (tx) => {
        // Transparently upgrade legacy password hashes on successful login
        if (auth.needsRehash(user.passwordHash)) {
            await tx.update(schema.users)
                .set({ passwordHash: auth.hashPassword(password), updatedAt: Date.now() })
                .where(eq(schema.users.id, user.id));
        }

        await tx.update(schema.users)
            .set({ lastLoginAt: Date.now() })
            .where(eq(schema.users.id, user.id));

        return createRefreshToken(user.id, deviceName, tx);
    });

    const accessToken = auth.generateAccessToken(user);
    const quotas = await policy.getEffectiveQuota(user.id, user.role);
    const llmAuthMode = await platformSettings.getLlmAuthMode();
    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
            id: user.id,
            username: user.username,
            role: user.role,
            status,
            llm_auth_mode: llmAuthMode,
        },
        quotas,
    };
}

async function getMe(userId) {
    const user = await getUserById(userId);
    if (!user) return null;
    const [quotas, granted, llmAuthMode] = await Promise.all([
        policy.getEffectiveQuota(userId, user.role),
        policy.listGrantedAgentIds(userId, user.role),
        platformSettings.getLlmAuthMode(),
    ]);
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status || 'active',
        display_name: user.displayName || null,
        email: user.email || null,
        quotas,
        granted_agents_count: user.role === 'admin' ? null : granted.length,
        llm_auth_mode: llmAuthMode,
    };
}

module.exports = {
    listUsers,
    getUserDetail,
    getUserById,
    createUser,
    registerUser,
    updateUser,
    suspendUser,
    setUserQuota,
    setUserAgents,
    grantAgent,
    grantAgentToAllNonAdminUsers,
    syncInstalledAgentGrantsForAllUsers,
    revokeAgent,
    resetPassword,
    loginUser,
    getMe,
    createRefreshToken,
    useRefreshToken,
    revokeAllUserRefreshTokens,
};
