const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { eq } = require('drizzle-orm');
const { bootstrapTestDb } = require('../test/db');

const TEST_USERNAME = 'test_refresh_user';
const TEST_PASSWORD = 'test-password-123';

let ctx;
let auth;
let userAdmin;
let db;
let schema;
let userId;

before(async () => {
    ctx = await bootstrapTestDb([
        '../db/index',
        '../admin/UserAdminService',
        '../auth/index',
    ], __dirname);
    ({ db, schema } = ctx);
    auth = ctx.reloaded['../auth/index'];
    userAdmin = ctx.reloaded['../admin/UserAdminService'];

    const users = await db.select().from(schema.users).where(eq(schema.users.username, TEST_USERNAME));
    if (users.length > 0) {
        userId = users[0].id;
    } else {
        const user = await userAdmin.createUser(
            { username: TEST_USERNAME, password: TEST_PASSWORD, role: 'user' },
            null,
        );
        userId = user.id;
    }
});

after(async () => {
    if (!db || !userId) return;
    await db.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, userId));
    await db.delete(schema.userAgentGrants).where(eq(schema.userAgentGrants.userId, userId));
    await db.delete(schema.userQuotas).where(eq(schema.userQuotas.userId, userId));
    await db.delete(schema.events).where(eq(schema.events.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    if (ctx) await ctx.teardown();
});

test('access token expires quickly', () => {
    const token = auth.generateAccessToken({ id: 'u1', username: 'a', role: 'user', status: 'active' });
    const payload = auth.verifyAccessToken(token);
    assert.ok(payload.exp - payload.iat <= 900, 'expires in 15 minutes');
});

test('refresh token creation and hash verification', async () => {
    await userAdmin.revokeAllUserRefreshTokens(userId);
    const raw = await userAdmin.createRefreshToken(userId, 'test-device');
    const hash = auth.hashToken(raw);
    const rows = await db.select().from(schema.refreshTokens).where(eq(schema.refreshTokens.userId, userId));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].tokenHash, hash);
    assert.ok(rows[0].expiresAt > Date.now());
});

test('refresh token is reused (no rotation) for concurrent-refresh safety', async () => {
    await userAdmin.revokeAllUserRefreshTokens(userId);
    const raw1 = await userAdmin.createRefreshToken(userId, 'test-device');
    // 不轮换：同一个 refresh token 可以被并发使用
    const raw2 = await userAdmin.useRefreshToken(raw1, userId, 'test-device');
    assert.strictEqual(raw2, raw1, 'refresh token is reused unchanged');
    // 并发场景：另一个标签页用同一个 token refresh 也成功
    const raw3 = await userAdmin.useRefreshToken(raw1, userId, 'test-device');
    assert.strictEqual(raw3, raw1, 'concurrent refresh returns same token');
});

test('revoked or expired refresh token returns null', async () => {
    await userAdmin.revokeAllUserRefreshTokens(userId);

    const revokedRaw = await userAdmin.createRefreshToken(userId, 'test-device');
    await userAdmin.revokeAllUserRefreshTokens(userId);
    const rotatedFromRevoked = await userAdmin.useRefreshToken(revokedRaw, userId, 'test-device');
    assert.strictEqual(rotatedFromRevoked, null, 'revoked token cannot be rotated');

    const expiredRaw = auth.generateRefreshTokenValue();
    const expiredHash = auth.hashToken(expiredRaw);
    await db.insert(schema.refreshTokens).values({
        id: `rt_expired_${Date.now()}`,
        userId,
        tokenHash: expiredHash,
        deviceName: 'test-device',
        createdAt: Date.now() - 2 * 30 * 24 * 60 * 60 * 1000,
        expiresAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });
    const rotatedFromExpired = await userAdmin.useRefreshToken(expiredRaw, userId, 'test-device');
    assert.strictEqual(rotatedFromExpired, null, 'expired token cannot be rotated');
});

test('revokeAllUserRefreshTokens revokes all tokens', async () => {
    await userAdmin.revokeAllUserRefreshTokens(userId);
    const raw1 = await userAdmin.createRefreshToken(userId, 'device-a');
    const raw2 = await userAdmin.createRefreshToken(userId, 'device-b');
    await userAdmin.revokeAllUserRefreshTokens(userId);
    assert.strictEqual(await userAdmin.useRefreshToken(raw1, userId, 'device-a'), null);
    assert.strictEqual(await userAdmin.useRefreshToken(raw2, userId, 'device-b'), null);
});

test('password hash upgrade', () => {
    const legacy = 'salt:hash';
    assert.strictEqual(auth.needsRehash(legacy), true);
    const modern = auth.hashPassword('password123');
    assert.strictEqual(auth.needsRehash(modern), false);
    assert.ok(auth.verifyPassword('password123', modern));
});

test('access token verification rejects invalid token', () => {
    assert.strictEqual(auth.verifyAccessToken('not-a-token'), null);
});
