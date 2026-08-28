const auth = require('../auth/index');
const userAdmin = require('../admin/UserAdminService');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq } = require('drizzle-orm');
const { sendPublicError } = require('../http/publicError');
const { t } = require('../i18n');

function sanitizeDeviceName(deviceName) {
    if (typeof deviceName !== 'string') return null;
    const trimmed = deviceName.trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, 255);
}

function registerAuthRoutes(fastify) {
    fastify.post('/api/v1/auth/register', async (request, reply) => {
        const { username, password, device_name } = request.body || {};
        const deviceName = sanitizeDeviceName(device_name);
        try {
            const { user, status, autoLogin } = await userAdmin.registerUser({ username, password });
            if (!autoLogin) {
                return reply.code(201).send({
                    message: t('auth:error.registration_submitted', {}, request.locale || 'en'),
                    user: { id: user.id, username: user.username, status },
                });
            }
            const login = await userAdmin.loginUser(username, password, deviceName);
            return {
                access_token: login.access_token,
                refresh_token: login.refresh_token,
                user: login.user,
                quotas: login.quotas,
            };
        } catch (err) {
            return sendPublicError(reply, err, 'Registration failed', 500, request.locale || 'en');
        }
    });

    fastify.post('/api/v1/auth/login', async (request, reply) => {
        const { username, password, device_name } = request.body || {};
        const deviceName = sanitizeDeviceName(device_name);
        try {
            const result = await userAdmin.loginUser(username, password, deviceName);
            return {
                access_token: result.access_token,
                refresh_token: result.refresh_token,
                user: result.user,
                quotas: result.quotas,
            };
        } catch (err) {
            // Localize well-known auth errors (code stays machine-readable).
            const code = err.code;
            if (code === 'invalid_credentials' || code === 'account_pending' || code === 'account_suspended') {
                const locale = request.locale || 'en';
                const message = t(`errors:${code}`, {}, locale);
                return reply.code(err.statusCode || 401).send({ error: message, code });
            }
            return sendPublicError(reply, err, 'Login failed', 500, request.locale || 'en');
        }
    });

    fastify.post('/api/v1/auth/refresh', async (request, reply) => {
        const { refresh_token, device_name } = request.body || {};
        const deviceName = sanitizeDeviceName(device_name);
        if (!refresh_token) {
            return reply.code(400).send({ error: t('errors:refresh_token_required', { defaultValue: 'refresh_token is required' }, request.locale || 'en') });
        }
        let userId = null;
        try {
            const tokenHash = auth.hashToken(refresh_token);
            const rows = await db.select({ userId: schema.refreshTokens.userId })
                .from(schema.refreshTokens)
                .where(eq(schema.refreshTokens.tokenHash, tokenHash));
            if (rows.length === 0) {
                return reply.code(401).send({ error: t('errors:invalid_refresh_token', { defaultValue: 'Invalid or expired refresh token' }, request.locale || 'en') });
            }
            userId = rows[0].userId;
            const user = await userAdmin.getUserById(userId);
            if (!user || user.status !== 'active') {
                return reply.code(403).send({ error: t('errors:account_inactive', {}, request.locale || 'en'), code: 'account_inactive' });
            }
            const newRefreshToken = await userAdmin.rotateRefreshToken(refresh_token, user.id, deviceName);
            if (!newRefreshToken) {
                return reply.code(401).send({ error: t('errors:invalid_refresh_token', { defaultValue: 'Invalid or expired refresh token' }, request.locale || 'en') });
            }
            const accessToken = auth.generateAccessToken(user);
            return { access_token: accessToken, refresh_token: newRefreshToken };
        } catch (err) {
            if (reply.sent) return;
            return sendPublicError(reply, err, 'Token refresh failed', 500, request.locale || 'en');
        }
    });

    fastify.get('/api/v1/auth/me', { preValidation: [fastify.authenticate] }, async (request) => {
        return userAdmin.getMe(request.user.id);
    });

    fastify.put('/api/v1/auth/password', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const { current_password, new_password } = request.body || {};
        if (!new_password || new_password.length < 8) {
            return reply.code(400).send({ error: t('errors:password_too_short', {}, request.locale || 'en') });
        }
        const user = await userAdmin.getUserById(request.user.id);
        if (!user || !auth.verifyPassword(current_password, user.passwordHash)) {
            return reply.code(401).send({ error: t('errors:current_password_incorrect', { defaultValue: 'Current password is incorrect' }, request.locale || 'en') });
        }
        try {
            await userAdmin.resetPassword(request.user.id, new_password, request.user.id);
            await userAdmin.revokeAllUserRefreshTokens(request.user.id);
            return { ok: true };
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to update password', 500, request.locale || 'en');
        }
    });
}

module.exports = { registerAuthRoutes };
