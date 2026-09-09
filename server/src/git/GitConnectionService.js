const crypto = require('crypto');
const { eq, and, isNull, lte, desc } = require('drizzle-orm');

const { db } = require('../db/index');
const schema = require('../db/schema');
const auth = require('../auth/index');
const { recordEvent } = require('../events/recordEvent');
const PlatformSettings = require('../admin/PlatformSettings');
const PlatformSecrets = require('../admin/PlatformSecrets');
const { getProvider, hasProvider, listProviders } = require('./providers/registry');

const STATE_TTL_MS = 5 * 60 * 1000;

// Token cache: `${userId}:${providerName}` -> { token, connectionId, expiresAt }
const TOKEN_CACHE_TTL_MS = 30_000;
const tokenCache = new Map();

// Throttle for fire-and-forget lastUsedAt writes: connectionId -> lastWriteTime
const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedWriteThrottle = new Map();

function tokenCacheKey(userId, providerName) {
    return `${userId}:${providerName || '*'}`;
}

/**
 * Fire-and-forget lastUsedAt update, throttled per connection to at most once
 * per LAST_USED_THROTTLE_MS. This avoids DB write contention when multiple git
 * subcommands run in parallel within getStatus().
 */
function scheduleLastUsedUpdate(connectionId) {
    const now = Date.now();
    const lastWrite = lastUsedWriteThrottle.get(connectionId) || 0;
    if (now - lastWrite < LAST_USED_THROTTLE_MS) return;
    lastUsedWriteThrottle.set(connectionId, now);
    db.update(schema.gitConnections)
        .set({ lastUsedAt: now })
        .where(eq(schema.gitConnections.id, connectionId))
        .catch(() => { /* fire-and-forget */ });
}

function invalidateTokenCache(userId, providerName) {
    if (providerName) {
        tokenCache.delete(tokenCacheKey(userId, providerName));
    } else {
        // Invalidate all providers for this user
        const prefix = `${userId}:`;
        for (const key of tokenCache.keys()) {
            if (key.startsWith(prefix)) tokenCache.delete(key);
        }
    }
}

async function getProviderConfig(providerName) {
    const configKey = `GIT_PROVIDER_${providerName.toUpperCase()}_CONFIG`;
    const raw = await PlatformSettings.get(configKey);
    if (raw) {
        try { return JSON.parse(raw); } catch { /* fall through */ }
    }

    // Fallback: read legacy provider-specific settings
    const legacyProviders = ['github', 'gitlab', 'gitea'];
    if (legacyProviders.includes(providerName)) {
        const prefix = providerName.toUpperCase();
        const clientId = await PlatformSettings.get(`${prefix}_CLIENT_ID`);
        const encryptedSecret = await PlatformSettings.get(`${prefix}_CLIENT_SECRET`);
        const clientSecret = encryptedSecret ? PlatformSecrets.getPlatformSecret(encryptedSecret) : null;
        const apiBase = await PlatformSettings.get(`${prefix}_API_BASE`);
        const callbackUrl = await PlatformSettings.get(`${prefix}_CALLBACK_URL`);
        if (clientId) {
            return {
                provider: providerName,
                enabled: true,
                clientId: String(clientId).trim(),
                clientSecret: clientSecret ? String(clientSecret).trim() : null,
                apiBase: apiBase ? String(apiBase).trim() : undefined,
                callbackUrl: callbackUrl ? String(callbackUrl) : undefined,
                scope: providerName === 'github' ? 'repo' : 'api',
            };
        }
    }

    return null;
}

class GitConnectionService {
    async initiateOAuth(userId, providerName = 'github') {
        if (!userId) throw new Error('userId is required');
        if (!hasProvider(providerName)) throw new Error(`Unknown provider: ${providerName}`);

        await this._pruneExpiredStates();

        const config = await getProviderConfig(providerName);
        if (!config || !config.clientId) {
            throw new Error(`${providerName} OAuth is not configured`);
        }

        const state = crypto.randomBytes(16).toString('hex');
        const expiresAt = Date.now() + STATE_TTL_MS;

        await db.insert(schema.gitOAuthStates).values({
            state,
            userId,
            provider: providerName,
            expiresAt,
        });

        const callbackUrl = config.callbackUrl
            || (process.env.CONTROL_PLANE_PUBLIC_URL
                ? `${process.env.CONTROL_PLANE_PUBLIC_URL}/api/v1/git/callback`
                : undefined);

        const provider = getProvider(providerName);
        const authUrl = provider.buildAuthUrl({
            clientId: config.clientId,
            callbackUrl,
            state,
            scope: config.scope,
            apiBase: config.apiBase,
        });

        return { authUrl, state, provider: providerName };
    }

    async completeOAuthFromCallback(code, state) {
        const stateRow = await this._consumeState(state);
        return this._finishConnection(stateRow.userId, stateRow.provider, code);
    }

    async completeOAuthFromDesktop(userId, code, state) {
        const stateRow = await this._consumeState(state);
        if (stateRow.userId !== userId) {
            throw new Error('OAuth state does not match the authenticated user');
        }
        return this._finishConnection(stateRow.userId, stateRow.provider, code);
    }

    /**
     * Connect using a pasted personal access token (PAT).
     * PAT connections share the git_connections table with OAuth rows via the
     * providerConfig='pat' discriminator (UNIQUE(user_id, provider, provider_config)
     * lets both coexist). The newest row wins for token resolution (ORDER BY
     * connectedAt DESC), so pasting a PAT while an OAuth connection exists
     * switches push credentials without disconnecting OAuth.
     *
     * @param {string} userId
     * @param {string} providerName
     * @param {string} token
     * @returns {Promise<{ connection: object, warning?: { code: string, message: string } }>}
     */
    async connectWithPat(userId, providerName, token) {
        if (!userId) throw new Error('userId is required');
        if (!hasProvider(providerName)) throw new Error(`Unknown provider: ${providerName}`);
        if (!token || typeof token !== 'string' || !token.trim() || token.length > 512) {
            throw new Error('A valid personal access token is required');
        }

        const provider = getProvider(providerName);
        const config = await getProviderConfig(providerName);

        // Validate the token and resolve the remote user profile. GitHub's
        // adapter also surfaces X-OAuth-Scopes for classic PATs.
        let user;
        try {
            user = await provider.getAuthenticatedUser(token.trim(), { apiBase: config?.apiBase });
        } catch (err) {
            if (err.code === 'token_expired' || err.status === 401) {
                throw new Error(`${provider.displayName} rejected this token — it is invalid, expired, or revoked.`);
            }
            if (err.code === 'insufficient_scope' || err.status === 403) {
                throw new Error(`${provider.displayName} rejected this token — it lacks permission to read your profile.`);
            }
            throw new Error(`Could not validate this token with ${provider.displayName}: ${err.message}`);
        }

        // Clear the 30s token cache so the new token is picked up immediately.
        invalidateTokenCache(userId, providerName);
        const now = Date.now();

        // Remove any prior PAT row for this provider: the UNIQUE
        // (user_id, provider, provider_config) constraint counts revoked rows,
        // so a soft-delete would collide on the next insert (same as the
        // OAuth path in _finishConnection, which also hard-deletes first).
        await db.delete(schema.gitConnections)
            .where(and(
                eq(schema.gitConnections.userId, userId),
                eq(schema.gitConnections.provider, providerName),
                eq(schema.gitConnections.providerConfig, 'pat'),
            ));

        const encrypted = auth.encryptSecrets({ token: token.trim() });
        const id = `gitconn_${crypto.randomBytes(8).toString('hex')}`;
        const connection = {
            id,
            userId,
            provider: providerName,
            providerConfig: 'pat',
            remoteUserId: user.id,
            remoteUsername: user.username,
            remoteAvatar: user.avatarUrl || null,
            accessTokenEnc: encrypted,
            refreshTokenEnc: null,          // PATs have no refresh semantics
            tokenScope: user.tokenScope ?? null,
            tokenExpiresAt: null,           // PATs never expire server-side
            connectedAt: now,
            lastUsedAt: now,
            revokedAt: null,
        };

        await db.insert(schema.gitConnections).values(connection);

        await recordEvent({
            userId,
            subjectType: 'git_connection',
            subjectId: id,
            type: 'git.connected',
            data: {
                provider: providerName,
                connectionType: 'pat',
                remoteUserId: user.id,
                remoteUsername: user.username,
            },
        });

        const warning = this._patScopeWarning(providerName, user.tokenScope);
        return { connection: this._formatConnection(connection), ...(warning ? { warning } : {}) };
    }

    /**
     * Warn when a GitHub classic PAT lacks push-capable scopes. Fine-grained
     * PATs expose no scope list, so they are never warned about.
     * @returns {{ code: string, message: string } | null}
     */
    _patScopeWarning(providerName, tokenScope) {
        if (providerName !== 'github' || !tokenScope || tokenScope === 'fine-grained') return null;
        const scopes = tokenScope.split(',').map((s) => s.trim());
        if (!scopes.includes('repo') && !scopes.includes('public_repo')) {
            return {
                code: 'missing_repo_scope',
                message: 'This token may not be able to push to private repositories. Grant the "repo" scope (or "public_repo" for public repos only).',
            };
        }
        return null;
    }

    async getConnection(userId, providerName) {
        const where = [
            eq(schema.gitConnections.userId, userId),
            isNull(schema.gitConnections.revokedAt),
        ];
        if (providerName) {
            where.push(eq(schema.gitConnections.provider, providerName));
        }

        const rows = await db.select().from(schema.gitConnections)
            .where(and(...where))
            .orderBy(desc(schema.gitConnections.connectedAt));
        if (rows.length > 0) return this._formatConnection(rows[0]);

        // Legacy fallback: users who only connected via /api/v1/github/*
        if (providerName === 'github' || !providerName) {
            const legacy = await this._getLegacyGithubConnection(userId);
            if (legacy) return legacy;
        }
        return null;
    }

    async _getLegacyGithubConnection(userId) {
        const rows = await db.select().from(schema.githubConnections)
            .where(and(
                eq(schema.githubConnections.userId, userId),
                isNull(schema.githubConnections.revokedAt),
            ))
            .orderBy(desc(schema.githubConnections.connectedAt));
        if (rows.length === 0) return null;
        const row = rows[0];
        return this._formatConnection({
            id: row.id,
            userId: row.userId,
            provider: 'github',
            providerConfig: null,
            remoteUserId: String(row.githubUserId ?? ''),
            remoteUsername: row.githubUsername,
            remoteAvatar: row.githubAvatar,
            tokenScope: row.tokenScope,
            connectedAt: row.connectedAt,
            lastUsedAt: row.lastUsedAt,
        });
    }

    async listConnections(userId) {
        const rows = await db.select().from(schema.gitConnections)
            .where(and(
                eq(schema.gitConnections.userId, userId),
                isNull(schema.gitConnections.revokedAt),
            ));
        return rows.map((r) => this._formatConnection(r));
    }

    async getDecryptedToken(userId, providerName) {
        const cacheKey = tokenCacheKey(userId, providerName);

        // Check cache first to avoid DB SELECT + AES decrypt on every git subcommand.
        const cached = tokenCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            scheduleLastUsedUpdate(cached.connectionId);
            return cached.token;
        }

        const where = [
            eq(schema.gitConnections.userId, userId),
            isNull(schema.gitConnections.revokedAt),
        ];
        if (providerName) {
            where.push(eq(schema.gitConnections.provider, providerName));
        }

        let rows = await db.select().from(schema.gitConnections)
            .where(and(...where))
            .orderBy(desc(schema.gitConnections.connectedAt));
        if (rows.length === 0 && (providerName === 'github' || !providerName)) {
            const legacyRows = await db.select().from(schema.githubConnections)
                .where(and(
                    eq(schema.githubConnections.userId, userId),
                    isNull(schema.githubConnections.revokedAt),
                ))
                .orderBy(desc(schema.githubConnections.connectedAt));
            if (legacyRows.length > 0) {
                const legacy = legacyRows[0];
                const secrets = auth.decryptSecrets(legacy.accessTokenEnc);
                const token = secrets.token ?? null;
                tokenCache.set(cacheKey, {
                    token,
                    connectionId: legacy.id,
                    expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
                });
                return token;
            }
        }
        if (rows.length === 0) throw new Error(`${providerName || 'git'}_not_connected`);

        const row = rows[0];
        const secrets = auth.decryptSecrets(row.accessTokenEnc);

        // Auto-refresh if token is expiring soon
        let token = secrets.token ?? null;
        if (row.tokenExpiresAt && row.refreshTokenEnc) {
            const expiresIn = row.tokenExpiresAt - Date.now();
            if (expiresIn < 5 * 60 * 1000) {
                try {
                    token = await this._refreshToken(row);
                    // After refresh, cache the new token and return early.
                    tokenCache.set(cacheKey, {
                        token,
                        connectionId: row.id,
                        expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
                    });
                    scheduleLastUsedUpdate(row.id);
                    return token;
                } catch (refreshErr) {
                    // Refresh failed (refresh_token expired, revoked, etc.).
                    // Do NOT fall through with the stale access token - that
                    // produces confusing "HTTP Basic: Access denied" errors
                    // from the git provider. Surface the real problem instead.
                    throw new Error(
                        `${providerName || 'git'} token 已过期且自动刷新失败，请重新认证`,
                    );
                }
            }
        }

        // Cache the decrypted token so parallel git subcommands don't each hit the DB.
        tokenCache.set(cacheKey, {
            token,
            connectionId: row.id,
            expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
        });

        // Fire-and-forget, throttled per connection.
        scheduleLastUsedUpdate(row.id);

        return token;
    }

    async disconnect(userId, providerName) {
        invalidateTokenCache(userId, providerName);

        const where = [
            eq(schema.gitConnections.userId, userId),
            isNull(schema.gitConnections.revokedAt),
        ];
        if (providerName) {
            where.push(eq(schema.gitConnections.provider, providerName));
        }

        const rows = await db.select().from(schema.gitConnections)
            .where(and(...where));
        const now = Date.now();
        for (const row of rows) {
            await db.update(schema.gitConnections)
                .set({ revokedAt: now })
                .where(eq(schema.gitConnections.id, row.id));

            await recordEvent({
                userId,
                subjectType: 'git_connection',
                subjectId: row.id,
                type: 'git.disconnected',
                data: { provider: row.provider },
            });
        }

        if (providerName === 'github' || !providerName) {
            try {
                await db.update(schema.githubConnections)
                    .set({ revokedAt: now })
                    .where(and(
                        eq(schema.githubConnections.userId, userId),
                        isNull(schema.githubConnections.revokedAt),
                    ));
            } catch { /* legacy table optional */ }
        }
    }

    async _consumeState(state) {
        if (!state) throw new Error('state is required');
        await this._pruneExpiredStates();

        const rows = await db.select().from(schema.gitOAuthStates)
            .where(eq(schema.gitOAuthStates.state, state));
        if (rows.length === 0) throw new Error('Invalid or expired OAuth state');

        await db.delete(schema.gitOAuthStates)
            .where(eq(schema.gitOAuthStates.state, state));
        return rows[0];
    }

    async _finishConnection(userId, providerName, code) {
        invalidateTokenCache(userId, providerName);
        const config = await getProviderConfig(providerName);
        if (!config) throw new Error(`${providerName} OAuth is not configured`);

        const provider = getProvider(providerName);
        const tokenResult = await provider.exchangeCode(code, {
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            callbackUrl: config.callbackUrl,
            apiBase: config.apiBase,
        });

        const user = await provider.getAuthenticatedUser(tokenResult.accessToken, {
            apiBase: config.apiBase,
        });

        const encrypted = auth.encryptSecrets({ token: tokenResult.accessToken });
        const refreshEnc = tokenResult.refreshToken
            ? auth.encryptSecrets({ token: tokenResult.refreshToken })
            : null;

        const now = Date.now();
        const id = `gitconn_${crypto.randomBytes(8).toString('hex')}`;

        const connection = {
            id,
            userId,
            provider: providerName,
            providerConfig: null,
            remoteUserId: user.id,
            remoteUsername: user.username,
            remoteAvatar: user.avatarUrl || null,
            accessTokenEnc: encrypted,
            refreshTokenEnc: refreshEnc,
            tokenScope: tokenResult.scope || config.scope || null,
            tokenExpiresAt: tokenResult.expiresIn
                ? now + tokenResult.expiresIn * 1000
                : null,
            connectedAt: now,
            lastUsedAt: now,
            revokedAt: null,
        };

        // Wrap DELETE + INSERT in a transaction so concurrent getDecryptedToken
        // calls always see either the old or new row — never an empty gap.
        await db.transaction(async (tx) => {
            await tx.delete(schema.gitConnections)
                .where(and(
                    eq(schema.gitConnections.userId, userId),
                    eq(schema.gitConnections.provider, providerName),
                ));

            await tx.insert(schema.gitConnections).values(connection);

            // Also sync to legacy github_connections for backward compat
            if (providerName === 'github') {
                try {
                    await tx.delete(schema.githubConnections)
                        .where(eq(schema.githubConnections.userId, userId));
                    await tx.insert(schema.githubConnections).values({
                        id,
                        userId,
                        githubUserId: Number(user.id) || 0,
                        githubUsername: user.username,
                        githubAvatar: user.avatarUrl || null,
                        accessTokenEnc: encrypted,
                        tokenScope: tokenResult.scope || 'repo',
                        connectedAt: now,
                        lastUsedAt: now,
                        revokedAt: null,
                    });
                } catch { /* ignore legacy table sync failures */ }
            }
        });

        await recordEvent({
            userId,
            subjectType: 'git_connection',
            subjectId: id,
            type: 'git.connected',
            data: {
                provider: providerName,
                remoteUserId: user.id,
                remoteUsername: user.username,
            },
        });

        return this._formatConnection(connection);
    }

    async _refreshToken(connectionRow) {
        invalidateTokenCache(connectionRow.userId, connectionRow.provider);
        const config = await getProviderConfig(connectionRow.provider);
        if (!config) throw new Error('provider config not found');

        const provider = getProvider(connectionRow.provider);
        const refreshSecrets = auth.decryptSecrets(connectionRow.refreshTokenEnc);

        const result = await provider.refreshAccessToken(refreshSecrets.token, {
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            apiBase: config.apiBase,
        });

        const now = Date.now();
        const newEnc = auth.encryptSecrets({ token: result.accessToken });
        const newRefreshEnc = result.refreshToken
            ? auth.encryptSecrets({ token: result.refreshToken })
            : connectionRow.refreshTokenEnc;

        await db.update(schema.gitConnections)
            .set({
                accessTokenEnc: newEnc,
                refreshTokenEnc: newRefreshEnc,
                tokenExpiresAt: result.expiresIn ? now + result.expiresIn * 1000 : null,
                lastUsedAt: now,
            })
            .where(eq(schema.gitConnections.id, connectionRow.id));

        return result.accessToken;
    }

    _formatConnection(row) {
        return {
            id: row.id,
            user_id: row.userId,
            provider: row.provider,
            connection_type: row.providerConfig === 'pat' ? 'pat' : 'oauth',
            remote_user_id: row.remoteUserId,
            remote_username: row.remoteUsername,
            remote_avatar: row.remoteAvatar,
            token_scope: row.tokenScope,
            connected_at: row.connectedAt,
            last_used_at: row.lastUsedAt,
            // Backward compat for GitHub clients
            github_user_id: row.provider === 'github' ? row.remoteUserId : undefined,
            github_username: row.provider === 'github' ? row.remoteUsername : undefined,
            github_avatar: row.provider === 'github' ? row.remoteAvatar : undefined,
        };
    }

    /**
     * 根据仓库 URL 推断应使用哪个 provider 的凭据：
     * 1) 公开托管域名（github.com / gitlab.com / gitea.com / codeberg.org）直接映射；
     * 2) 自建实例与各 provider 配置的 apiBase 主机名比对（如 gitlab apiBase
     *    配置为 http://git.schkzy.com 时，该域名的仓库即视为 gitlab）；
     * 3) 均未命中返回 null —— 调用方可按"默认 gitlab / 遍历全部已连接 provider"兜底。
     */
    async matchProviderByUrl(repoUrl) {
        let hostname = null;
        try {
            hostname = new URL(String(repoUrl || '')).hostname.toLowerCase().replace(/^www\./, '');
        } catch {
            return null;
        }
        if (!hostname) return null;

        const knownHosts = {
            'github.com': 'github',
            'gitlab.com': 'gitlab',
            'gitea.com': 'gitea',
            'codeberg.org': 'gitea',
        };
        if (knownHosts[hostname]) return knownHosts[hostname];

        for (const name of listProviders()) {
            const config = await getProviderConfig(name);
            if (!config || !config.apiBase) continue;
            try {
                const apiHost = new URL(config.apiBase).hostname.toLowerCase().replace(/^www\./, '');
                if (apiHost === hostname) return name;
            } catch { /* apiBase 非法则跳过 */ }
        }
        return null;
    }

    /**
     * 构建某用户针对该仓库的凭据候选链（按优先级；clone/fetch 在凭据失败时
     * 依序换用下一项重试）：
     *   1. 项目已确定的 provider（preferredProvider）
     *   2. 按仓库 URL 主机名匹配到的 provider（matchProviderByUrl）
     *   3. 默认 gitlab（识别不出时按用户约定兜底猜测）
     *   4. 其余所有已连接的 provider
     * 只收录"已连接"的 provider；未连接 / 无有效 token 自动跳过。
     * 每项为 { provider, token, username } —— username 供 git HTTP Basic 使用
     * （GitLab/Gitea OAuth 必须是 'oauth2'，PAT 用远端用户名，GitHub 任意）。
     */
    async resolveTokenCandidates(userId, repoUrl, preferredProvider) {
        const candidates = [];
        const seen = new Set();
        const isRealProvider = (name) => name && !['url', 'none', 'local_git'].includes(name);
        const push = async (name) => {
            if (!name || seen.has(name)) return;
            seen.add(name);
            try {
                const token = await this.getDecryptedToken(userId, name);
                if (!token) return;
                const connection = await this.getConnection(userId, name);
                candidates.push({
                    provider: name,
                    token,
                    username: this._credentialUsername(name, connection),
                });
            } catch { /* 未连接 / token 无效，跳过该候选 */ }
        };

        if (isRealProvider(preferredProvider)) await push(preferredProvider);
        const matched = await this.matchProviderByUrl(repoUrl);
        if (matched && matched !== preferredProvider) await push(matched);
        await push('gitlab');
        const connections = await this.listConnections(userId).catch(() => []);
        for (const c of connections) await push(c.provider);
        return candidates;
    }

    _credentialUsername(providerName, connection) {
        if (!connection) return null;
        // PAT：HTTP Basic 用户名用远端用户名（GitLab/Gitea 接受任意非空用户名 + PAT 作密码）
        if (connection.connection_type === 'pat') {
            return connection.remote_username || null;
        }
        // OAuth token 作密码时，GitLab/Gitea 的 HTTP Basic 用户名必须是 'oauth2'
        if (providerName === 'gitlab' || providerName === 'gitea') return 'oauth2';
        return null; // GitHub：用户名任意，askpass 会回退用 token
    }

    async _pruneExpiredStates() {
        await db.delete(schema.gitOAuthStates)
            .where(lte(schema.gitOAuthStates.expiresAt, Date.now()));
    }
}

module.exports = { GitConnectionService, getProviderConfig };
