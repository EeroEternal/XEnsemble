const auth = require('./index');
const { assertActiveUser } = require('./assertActiveUser');

function registerAuthHooks(fastify) {
    fastify.decorate('authenticate', async function authenticate(request, reply) {
        try {
            // Prefer Authorization header; fall back to ?access_token= query
            // param (needed by EventSource/SSE, which cannot set headers).
            const token = request.headers.authorization?.replace('Bearer ', '')
                || request.query?.access_token
                || null;
            if (!token) throw new Error('Missing token');
            const payload = auth.verifyAccessToken(token);
            if (!payload?.id) throw new Error('Invalid token');

            // Pass the already-verified payload to avoid a redundant second
            // JWT verification inside assertActiveUser.
            const active = await assertActiveUser(payload);
            if (active.error) {
                if (active.status === 401) throw new Error(active.error);
                return reply.code(active.status).send({ error: active.code });
            }

            request.user = {
                id: active.user.id,
                username: payload.username,
                role: payload.role,
                status: active.user.status,
            };
        } catch (err) {
            if (!reply.sent) {
                reply.code(401).send({ error: 'Unauthorized', code: 'unauthorized' });
            }
        }
    });

    fastify.decorate('requireActive', async function requireActive(request, reply) {
        if (reply.sent) return;
        if (!request.user || request.user.status !== 'active') {
            return reply.code(403).send({ error: 'account_inactive' });
        }
    });

    fastify.decorate('requireAdmin', async function requireAdmin(request, reply) {
        if (reply.sent) return;
        if (!request.user || request.user.role !== 'admin') {
            return reply.code(403).send({ error: 'Forbidden' });
        }
    });
}

module.exports = { registerAuthHooks };
