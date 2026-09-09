const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { eq, and, inArray, isNull } = require('drizzle-orm');
const { bootstrapTestDb } = require('../test/db');
const auth = require('../auth/index');

let ctx;
let db;
let schema;
let userAdmin;

// Reassigned per test to control what the mocked provider returns.
let mockGetAuthenticatedUser = async () => ({
    id: '42',
    username: 'octocat',
    displayName: 'Octocat',
    avatarUrl: 'https://example.com/avatar.png',
});

function installMockRegistry() {
    const registryPath = require.resolve('./providers/registry', { paths: [__dirname] });
    delete require.cache[registryPath];
    require.cache[registryPath] = {
        id: registryPath,
        filename: registryPath,
        loaded: true,
        exports: {
            listProviders: () => ['github'],
            hasProvider: (name) => name === 'github',
            getProvider: (name) => ({
                name,
                displayName: 'GitHub',
                getAuthenticatedUser: (token, opts) => mockGetAuthenticatedUser(token, opts),
            }),
        },
    };
}

describe('GitConnectionService (PAT)', { concurrency: false }, () => {
    let service;
    const createdUserIds = [];

    before(async () => {
        ctx = await bootstrapTestDb([
            '../db/index',
            '../admin/UserAdminService',
            '../admin/PlatformSettings',
        ], __dirname);
        ({ db, schema } = ctx);
        userAdmin = ctx.reloaded['../admin/UserAdminService'];

        installMockRegistry();
        const svcPath = require.resolve('./GitConnectionService', { paths: [__dirname] });
        delete require.cache[svcPath];
        ({ GitConnectionService } = require(svcPath));
        service = new GitConnectionService();
    });

    after(async () => {
        if (createdUserIds.length > 0) {
            await db.delete(schema.gitConnections).where(inArray(schema.gitConnections.userId, createdUserIds));
            await db.delete(schema.events).where(inArray(schema.events.userId, createdUserIds));
            await db.delete(schema.userQuotas).where(inArray(schema.userQuotas.userId, createdUserIds));
            await db.delete(schema.userAgentGrants).where(inArray(schema.userAgentGrants.userId, createdUserIds));
            await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
        }
        if (ctx) await ctx.teardown();
    });

    async function createUser() {
        const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const user = await userAdmin.createUser(
            { username: `pat_user_${suffix}`, password: 'Password1!' },
            null,
        );
        createdUserIds.push(user.id);
        return user.id;
    }

    async function activePatRows(userId) {
        return db.select().from(schema.gitConnections).where(and(
            eq(schema.gitConnections.userId, userId),
            eq(schema.gitConnections.providerConfig, 'pat'),
            isNull(schema.gitConnections.revokedAt),
        ));
    }

    it('connectWithPat stores the token and returns a formatted PAT connection', async () => {
        const userId = await createUser();
        mockGetAuthenticatedUser = async () => ({
            id: '42', username: 'octocat', displayName: 'Octocat',
            avatarUrl: 'https://example.com/avatar.png', tokenScope: 'repo, workflow',
        });

        const { connection, warning } = await service.connectWithPat(userId, 'github', 'ghp_testtoken_123');

        assert.equal(connection.connection_type, 'pat');
        assert.equal(connection.provider, 'github');
        assert.equal(connection.remote_username, 'octocat');
        assert.equal(connection.token_scope, 'repo, workflow');
        assert.equal(warning, undefined);

        const token = await service.getDecryptedToken(userId, 'github');
        assert.equal(token, 'ghp_testtoken_123');

        const rows = await activePatRows(userId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].providerConfig, 'pat');
        assert.equal(rows[0].refreshTokenEnc, null);
        assert.equal(rows[0].tokenExpiresAt, null);
        assert.equal(rows[0].revokedAt, null);

        const events = await db.select().from(schema.events)
            .where(and(eq(schema.events.userId, userId), eq(schema.events.type, 'git.connected')));
        assert.equal(events.length, 1);
        assert.equal(JSON.parse(events[0].data).connectionType, 'pat');
    });

    it('encrypts the token at rest', async () => {
        const userId = await createUser();
        await service.connectWithPat(userId, 'github', 'ghp_secret_encryption_check');

        const rows = await db.select().from(schema.gitConnections)
            .where(and(eq(schema.gitConnections.userId, userId), isNull(schema.gitConnections.revokedAt)));
        assert.equal(rows.length, 1);
        assert.notEqual(rows[0].accessTokenEnc, 'ghp_secret_encryption_check');
        assert.ok(!rows[0].accessTokenEnc.includes('ghp_secret_encryption_check'));
    });

    it('replaces a prior PAT row and the new token takes effect immediately', async () => {
        const userId = await createUser();
        await service.connectWithPat(userId, 'github', 'ghp_first_token');
        // Warm the cache so the stale token would be served if not invalidated.
        assert.equal(await service.getDecryptedToken(userId, 'github'), 'ghp_first_token');

        await service.connectWithPat(userId, 'github', 'ghp_second_token');

        const active = await activePatRows(userId);
        assert.equal(active.length, 1);
        assert.equal(active[0].remoteUsername, 'octocat');

        // The prior PAT row was hard-deleted (unique constraint counts it).
        const allPat = await db.select().from(schema.gitConnections)
            .where(and(eq(schema.gitConnections.userId, userId), eq(schema.gitConnections.providerConfig, 'pat')));
        assert.equal(allPat.length, 1);

        // Cache was invalidated: the new token is returned without waiting for TTL.
        assert.equal(await service.getDecryptedToken(userId, 'github'), 'ghp_second_token');
    });

    it('rejects an invalid token and stores nothing', async () => {
        const userId = await createUser();
        mockGetAuthenticatedUser = async () => {
            const err = new Error('Bad credentials');
            err.code = 'token_expired';
            err.status = 401;
            throw err;
        };

        await assert.rejects(
            service.connectWithPat(userId, 'github', 'ghp_invalid'),
            /invalid, expired, or revoked/,
        );
        const rows = await db.select().from(schema.gitConnections)
            .where(eq(schema.gitConnections.userId, userId));
        assert.equal(rows.length, 0);
    });

    it('maps permission errors to a friendly message', async () => {
        const userId = await createUser();
        mockGetAuthenticatedUser = async () => {
            const err = new Error('Resource not accessible');
            err.code = 'insufficient_scope';
            err.status = 403;
            throw err;
        };

        await assert.rejects(
            service.connectWithPat(userId, 'github', 'ghp_noscope'),
            /lacks permission to read your profile/,
        );
    });

    it('validates inputs', async () => {
        const userId = await createUser();
        await assert.rejects(service.connectWithPat(userId, 'github', ''), /valid personal access token/);
        await assert.rejects(service.connectWithPat(userId, 'github', '   '), /valid personal access token/);
        await assert.rejects(service.connectWithPat(userId, 'github', 12345), /valid personal access token/);
        await assert.rejects(service.connectWithPat(userId, 'github', 'x'.repeat(513)), /valid personal access token/);
        await assert.rejects(service.connectWithPat(userId, 'gitlab', 'ghp_whatever'), /Unknown provider/);
    });

    it('resolves the newest connection when OAuth and PAT rows coexist (ORDER BY)', async () => {
        // PAT connected after OAuth → PAT wins.
        const userId = await createUser();
        mockGetAuthenticatedUser = async () => ({
            id: '7', username: 'pat-user', displayName: 'PAT', avatarUrl: null, tokenScope: 'repo',
        });
        await db.insert(schema.gitConnections).values({
            id: 'gitconn_oauth_old',
            userId,
            provider: 'github',
            providerConfig: null,
            remoteUserId: '1',
            remoteUsername: 'oauth-user',
            remoteAvatar: null,
            accessTokenEnc: auth.encryptSecrets({ token: 'enc-oauth-old' }),
            refreshTokenEnc: null,
            tokenScope: 'repo',
            tokenExpiresAt: null,
            connectedAt: Date.now() - 60_000,
            lastUsedAt: Date.now() - 60_000,
            revokedAt: null,
        });
        await service.connectWithPat(userId, 'github', 'ghp_newer_pat');

        assert.equal(await service.getDecryptedToken(userId, 'github'), 'ghp_newer_pat');
        const conn = await service.getConnection(userId, 'github');
        assert.equal(conn.connection_type, 'pat');
        assert.equal(conn.remote_username, 'pat-user');

        // OAuth connected after PAT → OAuth wins.
        const userId2 = await createUser();
        await service.connectWithPat(userId2, 'github', 'ghp_older_pat');
        await db.insert(schema.gitConnections).values({
            id: 'gitconn_oauth_new',
            userId: userId2,
            provider: 'github',
            providerConfig: null,
            remoteUserId: '2',
            remoteUsername: 'oauth-user-2',
            remoteAvatar: null,
            accessTokenEnc: auth.encryptSecrets({ token: 'enc-oauth-new' }),
            refreshTokenEnc: null,
            tokenScope: 'repo',
            tokenExpiresAt: null,
            connectedAt: Date.now() + 60_000,
            lastUsedAt: Date.now(),
            revokedAt: null,
        });

        const token2 = await service.getDecryptedToken(userId2, 'github');
        assert.equal(token2, 'enc-oauth-new');
        const conn2 = await service.getConnection(userId2, 'github');
        assert.equal(conn2.connection_type, 'oauth');
    });

    it('leaves the OAuth row untouched when a PAT is added', async () => {
        const userId = await createUser();
        await db.insert(schema.gitConnections).values({
            id: 'gitconn_oauth_keep',
            userId,
            provider: 'github',
            providerConfig: null,
            remoteUserId: '3',
            remoteUsername: 'oauth-user',
            remoteAvatar: null,
            accessTokenEnc: 'enc-oauth-keep',
            refreshTokenEnc: null,
            tokenScope: 'repo',
            tokenExpiresAt: null,
            connectedAt: Date.now() - 30_000,
            lastUsedAt: Date.now(),
            revokedAt: null,
        });
        await service.connectWithPat(userId, 'github', 'ghp_alongside');

        const oauthRow = await db.select().from(schema.gitConnections)
            .where(eq(schema.gitConnections.id, 'gitconn_oauth_keep'));
        assert.equal(oauthRow.length, 1);
        assert.equal(oauthRow[0].revokedAt, null);
        const patRows = await activePatRows(userId);
        assert.equal(patRows.length, 1);
    });

    it('warns only when a GitHub classic PAT lacks push-capable scopes', async () => {
        const userId = await createUser();

        mockGetAuthenticatedUser = async () => ({
            id: '5', username: 'u', displayName: 'U', avatarUrl: null, tokenScope: 'repo, workflow',
        });
        const ok = await service.connectWithPat(userId, 'github', 'ghp_a');
        assert.equal(ok.warning, undefined);

        const userId2 = await createUser();
        mockGetAuthenticatedUser = async () => ({
            id: '6', username: 'u2', displayName: 'U2', avatarUrl: null, tokenScope: 'read:org',
        });
        const warned = await service.connectWithPat(userId2, 'github', 'ghp_b');
        assert.equal(warned.warning?.code, 'missing_repo_scope');
        assert.match(warned.warning.message, /"repo" scope/);

        const userId3 = await createUser();
        mockGetAuthenticatedUser = async () => ({
            id: '8', username: 'u3', displayName: 'U3', avatarUrl: null, tokenScope: 'fine-grained',
        });
        const fine = await service.connectWithPat(userId3, 'github', 'ghp_c');
        assert.equal(fine.warning, undefined);
    });

    // ── provider 识别 & 凭据候选链 ──

    it('matchProviderByUrl maps known public hosts', async () => {
        assert.equal(await service.matchProviderByUrl('https://github.com/owner/repo.git'), 'github');
        assert.equal(await service.matchProviderByUrl('https://gitlab.com/group/sub/repo.git'), 'gitlab');
        assert.equal(await service.matchProviderByUrl('https://gitea.com/x/y.git'), 'gitea');
        assert.equal(await service.matchProviderByUrl('https://codeberg.org/x/y.git'), 'gitea');
        // www 前缀、协议无关、无 .git 后缀均不影响
        assert.equal(await service.matchProviderByUrl('http://www.github.com/owner/repo'), 'github');
    });

    it('matchProviderByUrl returns null for unknown hosts', async () => {
        assert.equal(await service.matchProviderByUrl('https://git.schkzy.com/owner/repo.git'), null);
        assert.equal(await service.matchProviderByUrl('not a url'), null);
        assert.equal(await service.matchProviderByUrl(''), null);
    });

    it('resolveTokenCandidates returns the connected provider with PAT username', async () => {
        const userId = await createUser();
        mockGetAuthenticatedUser = async () => ({
            id: '42', username: 'octocat', displayName: 'Octocat', avatarUrl: null, tokenScope: 'repo',
        });
        await service.connectWithPat(userId, 'github', 'ghp_chain_token');

        const candidates = await service.resolveTokenCandidates(
            userId, 'https://github.com/owner/repo.git', undefined,
        );
        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].provider, 'github');
        assert.equal(candidates[0].token, 'ghp_chain_token');
        assert.equal(candidates[0].username, 'octocat'); // PAT → 远端用户名
    });

    it('resolveTokenCandidates yields nothing when no provider is connected', async () => {
        const userId = await createUser();
        const candidates = await service.resolveTokenCandidates(
            userId, 'https://git.schkzy.com/owner/repo.git', 'url',
        );
        assert.deepEqual(candidates, []);
    });

    it('resolveTokenCandidates prefers the explicit provider over the matched one', async () => {
        const userId = await createUser();
        mockGetAuthenticatedUser = async () => ({
            id: '43', username: 'octocat', displayName: 'Octocat', avatarUrl: null, tokenScope: 'repo',
        });
        await service.connectWithPat(userId, 'github', 'ghp_preferred');
        const candidates = await service.resolveTokenCandidates(
            userId, 'https://github.com/owner/repo.git', 'github',
        );
        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].provider, 'github');
        assert.equal(candidates[0].token, 'ghp_preferred');
    });

    it('OAuth connection for gitlab/gitea uses oauth2 username', async () => {
        const userId = await createUser();
        await db.insert(schema.gitConnections).values({
            id: `gitconn_oauth_${userId}`,
            userId,
            provider: 'gitlab',
            providerConfig: null,
            remoteUserId: '9',
            remoteUsername: 'gl-user',
            remoteAvatar: null,
            accessTokenEnc: auth.encryptSecrets({ token: 'enc-gitlab-oauth' }),
            refreshTokenEnc: null,
            tokenScope: 'api',
            tokenExpiresAt: null,
            connectedAt: Date.now(),
            lastUsedAt: Date.now(),
            revokedAt: null,
        });
        const candidates = await service.resolveTokenCandidates(
            userId, 'https://git.schkzy.com/owner/repo.git', undefined,
        );
        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].provider, 'gitlab');
        assert.equal(candidates[0].username, 'oauth2'); // OAuth → oauth2
    });
});
