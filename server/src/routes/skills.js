/**
 * Skills REST 路由（P3 市场 MVP）。
 *
 * 端点概览：
 *  - GET    /api/v1/skills/market         市场浏览（公开已发布，分页/筛选/搜索/排序）
 *  - POST   /api/v1/skills/market/:id/install  安装（复制为私有 draft）
 *  - GET    /api/v1/skills                我的 skill 列表（可传 status/q）
 *  - POST   /api/v1/skills                创建（手动）
 *  - GET    /api/v1/skills/:id            详情
 *  - PUT    /api/v1/skills/:id            编辑
 *  - PATCH  /api/v1/skills/:id/status     状态机（activate/archive/restore）
 *  - DELETE /api/v1/skills/:id            删除
 *  - POST   /api/v1/skills/:id/publish    发布到市场
 *  - POST   /api/v1/skills/:id/unpublish  下架
 */

const { sendPublicError } = require('../http/publicError');
const { t } = require('../i18n');
const skillService = require('../skills/skillService');

function registerSkillRoutes(fastify) {
    const authPre = [fastify.authenticate];

    // 市场浏览
    fastify.get('/api/v1/skills/market', { preValidation: authPre }, async (request, reply) => {
        try {
            const q = String(request.query?.q ?? '').trim();
            const category = String(request.query?.category ?? '').trim() || null;
            const sort = String(request.query?.sort ?? 'hot').trim();
            const page = Number(request.query?.page) || 1;
            const pageSize = Math.min(100, Number(request.query?.pageSize) || 20);
            return await skillService.listMarket({ q, category, sort, page, pageSize, excludeUserId: request.user.id });
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to list skills market', 500, request.locale || 'en');
        }
    });

    // 安装（复制为私有 draft）
    fastify.post('/api/v1/skills/market/:id/install', { preValidation: authPre }, async (request, reply) => {
        try {
            const skill = await skillService.installSkill(request.user.id, request.params.id);
            return reply.code(201).send(skill);
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to install skill', 500, request.locale || 'en');
        }
    });

    // 我的 skill 列表
    fastify.get('/api/v1/skills', { preValidation: authPre }, async (request, reply) => {
        try {
            const status = String(request.query?.status ?? '').trim() || null;
            const q = String(request.query?.q ?? '').trim();
            return await skillService.listMySkills(request.user.id, { status, q });
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to list skills', 500, request.locale || 'en');
        }
    });

    // 创建（手动）
    fastify.post('/api/v1/skills', { preValidation: authPre }, async (request, reply) => {
        try {
            const body = request.body || {};
            const skill = await skillService.createSkill({
                userId: request.user.id,
                title: body.title,
                content: body.content,
                tags: body.tags,
                category: body.category,
                projectId: body.projectId || null,
                source: 'manual',
            });
            return reply.code(201).send(skill);
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to create skill', 500, request.locale || 'en');
        }
    });

    // 详情
    fastify.get('/api/v1/skills/:id', { preValidation: authPre }, async (request, reply) => {
        try {
            return await skillService.getSkill(request.user.id, request.params.id, { allowPublic: true });
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to get skill', 500, request.locale || 'en');
        }
    });

    // 编辑
    fastify.put('/api/v1/skills/:id', { preValidation: authPre }, async (request, reply) => {
        try {
            return await skillService.updateSkill(request.user.id, request.params.id, request.body || {});
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to update skill', 500, request.locale || 'en');
        }
    });

    // 状态机转移
    fastify.patch('/api/v1/skills/:id/status', { preValidation: authPre }, async (request, reply) => {
        try {
            const { action } = request.body || {};
            if (!action) {
                return reply.code(400).send({ code: 'skill_validation_failed', error: t('errors:required_field_missing', {}, request.locale || 'en') });
            }
            return await skillService.changeStatus(request.user.id, request.params.id, action);
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to change skill status', 500, request.locale || 'en');
        }
    });

    // 删除
    fastify.delete('/api/v1/skills/:id', { preValidation: authPre }, async (request, reply) => {
        try {
            await skillService.deleteSkill(request.user.id, request.params.id);
            return reply.code(204).send();
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to delete skill', 500, request.locale || 'en');
        }
    });

    // 发布到市场
    fastify.post('/api/v1/skills/:id/publish', { preValidation: authPre }, async (request, reply) => {
        try {
            return await skillService.publishSkill(request.user.id, request.params.id);
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to publish skill', 500, request.locale || 'en');
        }
    });

    // 下架
    fastify.post('/api/v1/skills/:id/unpublish', { preValidation: authPre }, async (request, reply) => {
        try {
            return await skillService.unpublishSkill(request.user.id, request.params.id);
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to unpublish skill', 500, request.locale || 'en');
        }
    });

    // 从会话手动提炼（US-3，跳过 L1-L3 直达 L4）
    fastify.post('/api/v1/skills/from-session', { preValidation: authPre }, async (request, reply) => {
        try {
            const { sessionId } = request.body || {};
            if (!sessionId) {
                return reply.code(400).send({
                    code: 'skill_validation_failed',
                    error: t('errors:required_field_missing', {}, request.locale || 'en'),
                });
            }
            const pipeline = require('../skills/skillPipeline');
            const skill = await pipeline.extractFromSession(sessionId, {
                userId: request.user.id,
                log: request.log,
            });
            return reply.code(201).send(skill);
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to extract skill from session', 500, request.locale || 'en');
        }
    });

    // auto draft 未读数（FR-4.5）
    fastify.get('/api/v1/skills/drafts/unread-count', { preValidation: authPre }, async (request, reply) => {
        try {
            const lastSeenAt = await skillService.getDraftsLastSeenAt(request.user.id);
            const count = await skillService.countUnseenAutoDrafts(request.user.id, lastSeenAt);
            return { count };
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to get drafts unread count', 500, request.locale || 'en');
        }
    });

    // 标记 auto draft 已读（进入 Skills 页时调用）
    fastify.post('/api/v1/skills/drafts/mark-seen', { preValidation: authPre }, async (request, reply) => {
        try {
            await skillService.markDraftsSeen(request.user.id);
            return reply.code(204).send();
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to mark drafts seen', 500, request.locale || 'en');
        }
    });
}

module.exports = { registerSkillRoutes };
