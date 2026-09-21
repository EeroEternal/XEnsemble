const platformSettings = require('../admin/PlatformSettings');
const userPreferences = require('../admin/UserPreferences');
const usageService = require('../admin/UsageService');
const routingService = require('../admin/RoutingService');
const terminalThemes = require('../config/terminalThemes');
const { previewSpawnEnv } = require('../agents/agentEnv');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq } = require('drizzle-orm');
const { sendPublicError } = require('../http/publicError');
const { t } = require('../i18n');

function registerUserRoutes(fastify) {
    fastify.get('/api/v1/terminal-themes', { preValidation: [fastify.authenticate] }, async () => {
        const settings = await platformSettings.getAll();
        return terminalThemes.listPublicThemes({
            platformDefaultId: settings.default_terminal_theme_id,
            disabledIds: settings.disabled_terminal_theme_ids || [],
        });
    });

    fastify.get('/api/v1/user/preferences', { preValidation: [fastify.authenticate] }, async (request) => {
        return userPreferences.getPreferences(request.user.id);
    });

    fastify.put('/api/v1/user/preferences', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            return await userPreferences.updatePreferences(request.user.id, request.body || {});
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to update preferences', 400, request.locale || 'en');
        }
    });

    // 本人智能路由统计（路由分析页；self 过滤，仅可见自己的路由决策）
    fastify.get('/api/v1/routing/me', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const { days } = request.query || {};
            return await routingService.getMyRoutingOverview(request.user.id, { days });
        } catch (err) {
            request.log.error({ err, userId: request.user.id }, '[routing] failed to query routing overview');
            return sendPublicError(reply, err, 'Failed to query routing analytics', 500, request.locale || 'en');
        }
    });

    // 本人 Token 用量（用户自助：强制 self 过滤，仅可见自己的数据）
    fastify.get('/api/v1/usage/me', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        try {
            const { days } = request.query || {};
            const range = usageService.normalizeRange(days);
            const [summary, byProject, trend, prevTotal, byAgent, bySource, internalByFeature] = await Promise.all([
                usageService.getMyUsageSummary(request.user.id, { days }),
                usageService.getMyUsageByProject(request.user.id, { days }),
                usageService.getMyUsageTrend(request.user.id, { days }),
                // 环比：上一个等长周期的总量
                usageService.getTotalBetween(
                    request.user.id,
                    range.sinceTs - range.days * 24 * 60 * 60 * 1000,
                    range.sinceTs,
                ),
                // agent 粒度（getUsageByAgent 强制 userId self 过滤）
                usageService.getUsageByAgent({ days, userId: request.user.id }),
                // 0043：流量性质（agent 会话 vs 内置 AI）与内置功能明细
                usageService.getMyUsageBySource(request.user.id, { days }),
                usageService.getMyInternalByFeature(request.user.id, { days }),
            ]);
            return { summary, byProject, trend, byAgent, bySource, internalByFeature, prevTotalTokens: prevTotal, days: range.days };
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to query usage', 500, request.locale || 'en');
        }
    });

    fastify.get('/api/v1/session/spawn-preview', { preValidation: [fastify.authenticate] }, async (request, reply) => {
        const agentId = request.query?.agent_id;
        if (!agentId) {
            return reply.code(400).send({ error: t('errors:agent_id_required', { defaultValue: 'agent_id query parameter is required' }, request.locale || 'en'), code: 'agent_id_required' });
        }
        const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
        if (rows.length === 0) return reply.code(404).send({ error: t('errors:agent_not_found', {}, request.locale || 'en'), code: 'agent_not_found' });
        const row = rows[0];
        try {
            return await previewSpawnEnv({
                userId: request.user.id,
                agentId: row.id,
                envRequired: JSON.parse(row.envRequired),
                terminalThemeId: request.query?.terminal_theme_id,
            });
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to preview spawn env', 500, request.locale || 'en');
        }
    });
}

module.exports = { registerUserRoutes };
