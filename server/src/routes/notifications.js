/**
 * 铃铛通知中心 REST 路由（docs/proposals/agent-attention-notification.md §5）。
 *
 *  - GET  /api/v1/notifications?limit=20&before=<cursor>  游标分页列表（倒序）
 *  - GET  /api/v1/notifications/unread-count              角标 30s 轮询（轻量）
 *  - POST /api/v1/notifications/read-all                  全部已读
 *  - POST /api/v1/notifications/:id/read                  单条已读
 */

const { sendPublicError } = require('../http/publicError');
const notificationsService = require('../session/notificationsService');

function registerNotificationsRoutes(fastify) {
    const authPre = [fastify.authenticate];

    fastify.get('/api/v1/notifications', { preValidation: authPre }, async (request, reply) => {
        try {
            return await notificationsService.list({
                userId: request.user.id,
                limit: Number(request.query?.limit) || 20,
                before: request.query?.before || null,
            });
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to list notifications', 500, request.locale || 'en');
        }
    });

    fastify.get('/api/v1/notifications/unread-count', { preValidation: authPre }, async (request, reply) => {
        try {
            const count = await notificationsService.unreadCount(request.user.id);
            return { count };
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to count notifications', 500, request.locale || 'en');
        }
    });

    fastify.post('/api/v1/notifications/read-all', { preValidation: authPre }, async (request, reply) => {
        try {
            const updated = await notificationsService.readAll(request.user.id);
            return { updated };
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to mark notifications read', 500, request.locale || 'en');
        }
    });

    fastify.post('/api/v1/notifications/:id/read', { preValidation: authPre }, async (request, reply) => {
        try {
            const ok = await notificationsService.markRead(request.user.id, request.params.id);
            if (!ok) return reply.code(404).send({ error: 'notification not found', code: 'notification_not_found' });
            return { ok: true };
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to mark notification read', 500, request.locale || 'en');
        }
    });
}

module.exports = { registerNotificationsRoutes };
