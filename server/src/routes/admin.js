const { eq } = require('drizzle-orm');
const userAdmin = require('../admin/UserAdminService');
const platformSettings = require('../admin/PlatformSettings');
const platformSecrets = require('../admin/PlatformSecrets');
const agentGatewayConfig = require('../admin/AgentGatewayConfig');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { RuntimeError } = require('../runtime/interfaces');
const {
    listAgentBoxImageCatalog,
    registerVersion,
    activateVersion,
    deprecateVersion,
    deleteVersion,
    buildImage,
    getBuilds,
    getBuildLogs,
    retryBuild,
    deleteBuild,
    resolveBoxBaseImage,
} = require('../runtime/AgentBoxImageService');
const { listBuildableAgentImages } = require('../runtime/agentBoxImages');
const { sendPublicError } = require('../http/publicError');
const { t } = require('../i18n');

function isValidUrl(value) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return false;
    try {
        const url = new URL(trimmed);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function safeGetPlatformSecret(value) {
    try {
        return platformSecrets.getPlatformSecret(value) || '';
    } catch {
        return '';
    }
}

function registerAdminRoutes(fastify) {
    const adminPre = [fastify.authenticate, fastify.requireAdmin];

    fastify.get('/api/v1/admin/users', { preValidation: adminPre }, async () => {
        return userAdmin.listUsers();
    });

    fastify.post('/api/v1/admin/users', { preValidation: adminPre }, async (request, reply) => {
        try {
            const body = request.body || {};
            const user = await userAdmin.createUser({
                username: body.username,
                password: body.password,
                role: body.role,
                status: body.status,
                displayName: body.display_name,
                email: body.email,
                quota: body.quota,
                agentIds: body.agent_ids,
            }, request.user.id);
            return reply.code(201).send(user);
        } catch (err) {
            return sendPublicError(reply, err, 'Request failed', 400, request.locale || 'en');
        }
    });

    fastify.get('/api/v1/admin/users/:id', { preValidation: adminPre }, async (request, reply) => {
        const user = await userAdmin.getUserDetail(request.params.id);
        if (!user) return reply.code(404).send({ error: t('errors:user_not_found', { defaultValue: 'User not found' }, request.locale || 'en'), code: 'user_not_found' });
        return user;
    });

    fastify.patch('/api/v1/admin/users/:id', { preValidation: adminPre }, async (request, reply) => {
        try {
            const user = await userAdmin.updateUser(request.params.id, request.body || {}, request.user.id);
            if (!user) return reply.code(404).send({ error: t('errors:user_not_found', { defaultValue: 'User not found' }, request.locale || 'en'), code: 'user_not_found' });
            return user;
        } catch (err) {
            return sendPublicError(reply, err, 'Request failed', 400, request.locale || 'en');
        }
    });

    fastify.delete('/api/v1/admin/users/:id', { preValidation: adminPre }, async (request, reply) => {
        try {
            const user = await userAdmin.suspendUser(request.params.id, request.user.id);
            if (!user) return reply.code(404).send({ error: t('errors:user_not_found', { defaultValue: 'User not found' }, request.locale || 'en'), code: 'user_not_found' });
            return user;
        } catch (err) {
            return sendPublicError(reply, err, 'Request failed', 400, request.locale || 'en');
        }
    });

    fastify.get('/api/v1/admin/users/:id/quota', { preValidation: adminPre }, async (request, reply) => {
        const user = await userAdmin.getUserById(request.params.id);
        if (!user) return reply.code(404).send({ error: t('errors:user_not_found', { defaultValue: 'User not found' }, request.locale || 'en'), code: 'user_not_found' });
        const policy = require('../auth/PolicyService');
        return policy.getEffectiveQuota(request.params.id, user.role);
    });

    fastify.put('/api/v1/admin/users/:id/quota', { preValidation: adminPre }, async (request, reply) => {
        const user = await userAdmin.getUserById(request.params.id);
        if (!user) return reply.code(404).send({ error: t('errors:user_not_found', { defaultValue: 'User not found' }, request.locale || 'en'), code: 'user_not_found' });
        try {
            return await userAdmin.setUserQuota(request.params.id, request.body || {}, request.user.id);
        } catch (err) {
            return sendPublicError(reply, err, 'Request failed', 400, request.locale || 'en');
        }
    });

    fastify.put('/api/v1/admin/users/:id/agents', { preValidation: adminPre }, async (request, reply) => {
        const user = await userAdmin.getUserById(request.params.id);
        if (!user) return reply.code(404).send({ error: t('errors:user_not_found', { defaultValue: 'User not found' }, request.locale || 'en'), code: 'user_not_found' });
        try {
            const agentIds = request.body?.agent_ids || [];
            await userAdmin.setUserAgents(request.params.id, agentIds, request.user.id);
            return { agent_ids: agentIds };
        } catch (err) {
            return sendPublicError(reply, err, 'Request failed', 400, request.locale || 'en');
        }
    });

    fastify.post('/api/v1/admin/users/:id/agents/:agentId', { preValidation: adminPre }, async (request, reply) => {
        const user = await userAdmin.getUserById(request.params.id);
        if (!user) return reply.code(404).send({ error: t('errors:user_not_found', { defaultValue: 'User not found' }, request.locale || 'en'), code: 'user_not_found' });
        try {
            await userAdmin.grantAgent(request.params.id, request.params.agentId, request.user.id);
            return { ok: true };
        } catch (err) {
            return sendPublicError(reply, err, 'Request failed', 400, request.locale || 'en');
        }
    });

    fastify.delete('/api/v1/admin/users/:id/agents/:agentId', { preValidation: adminPre }, async (request, reply) => {
        const user = await userAdmin.getUserById(request.params.id);
        if (!user) return reply.code(404).send({ error: t('errors:user_not_found', { defaultValue: 'User not found' }, request.locale || 'en'), code: 'user_not_found' });
        await userAdmin.revokeAgent(request.params.id, request.params.agentId, request.user.id);
        return { ok: true };
    });

    fastify.post('/api/v1/admin/users/:id/reset-password', { preValidation: adminPre }, async (request, reply) => {
        const user = await userAdmin.getUserById(request.params.id);
        if (!user) return reply.code(404).send({ error: t('errors:user_not_found', { defaultValue: 'User not found' }, request.locale || 'en'), code: 'user_not_found' });
        const newPassword = request.body?.password || request.body?.new_password;
        try {
            await userAdmin.resetPassword(request.params.id, newPassword, request.user.id);
            return { ok: true };
        } catch (err) {
            return sendPublicError(reply, err, 'Request failed', 400, request.locale || 'en');
        }
    });

    fastify.get('/api/v1/admin/platform-settings', { preValidation: adminPre }, async () => {
        const MASK = '••••••••';
        const settings = await platformSettings.getAll();
        for (const p of ['GITHUB', 'GITLAB', 'GITEA']) {
            settings[`${p}_CLIENT_SECRET`] = settings[`${p}_CLIENT_SECRET`] ? MASK : '';
        }
        settings.GITHUB_APP_PRIVATE_KEY = settings.GITHUB_APP_PRIVATE_KEY ? MASK : '';
        settings.GITHUB_APP_WEBHOOK_SECRET = settings.GITHUB_APP_WEBHOOK_SECRET ? MASK : '';
        return settings;
    });

    fastify.put('/api/v1/admin/platform-settings', { preValidation: adminPre }, async (request, reply) => {
        const mode = request.body?.registration_mode;
        const allowedModes = ['open', 'invite_only', 'admin_only', 'approval'];
        if (mode !== undefined && !allowedModes.includes(mode)) {
            return reply.code(400).send({ error: t('errors:invalid_registration_mode', { defaultValue: 'Invalid registration_mode' }, request.locale || 'en'), code: 'invalid_registration_mode' });
        }
        const llmMode = request.body?.llm_auth_mode;
        if (llmMode !== undefined && !['gateway', 'byok'].includes(llmMode)) {
            return reply.code(400).send({ error: t('errors:invalid_llm_auth_mode', { defaultValue: 'Invalid llm_auth_mode' }, request.locale || 'en'), code: 'invalid_llm_auth_mode' });
        }
        const terminalThemes = require('../config/terminalThemes');
        const defaultThemeId = request.body?.default_terminal_theme_id;
        if (defaultThemeId !== undefined) {
            if (typeof defaultThemeId !== 'string' || !terminalThemes.getThemeById(defaultThemeId)) {
                return reply.code(400).send({ error: t('errors:invalid_default_terminal_theme_id', { defaultValue: 'Invalid default_terminal_theme_id' }, request.locale || 'en'), code: 'invalid_default_terminal_theme_id' });
            }
        }
        const disabledIds = request.body?.disabled_terminal_theme_ids;
        if (disabledIds !== undefined) {
            if (!Array.isArray(disabledIds)) {
                return reply.code(400).send({ error: t('errors:disabled_theme_ids_must_be_array', { defaultValue: 'disabled_terminal_theme_ids must be an array' }, request.locale || 'en'), code: 'disabled_theme_ids_must_be_array' });
            }
            for (const id of disabledIds) {
                if (typeof id !== 'string' || !terminalThemes.getThemeById(id)) {
                    return reply.code(400).send({ error: t('errors:invalid_disabled_theme_id', { defaultValue: `Invalid disabled terminal theme id: ${id}`, id }, request.locale || 'en'), code: 'invalid_disabled_theme_id' });
                }
            }
        }
        if (request.body?.GITHUB_CALLBACK_URL && !isValidUrl(request.body.GITHUB_CALLBACK_URL)) {
            return reply.code(400).send({ error: t('errors:invalid_url', { defaultValue: 'invalid_url' }, request.locale || 'en'), code: 'invalid_url', field: 'GITHUB_CALLBACK_URL' });
        }
        if (request.body?.GITHUB_API_BASE && !isValidUrl(request.body.GITHUB_API_BASE)) {
            return reply.code(400).send({ error: t('errors:invalid_url', { defaultValue: 'invalid_url' }, request.locale || 'en'), code: 'invalid_url', field: 'GITHUB_API_BASE' });
        }
        if (request.body?.GITLAB_CALLBACK_URL && !isValidUrl(request.body.GITLAB_CALLBACK_URL)) {
            return reply.code(400).send({ error: t('errors:invalid_url', { defaultValue: 'invalid_url' }, request.locale || 'en'), code: 'invalid_url', field: 'GITLAB_CALLBACK_URL' });
        }
        if (request.body?.GITLAB_API_BASE && !isValidUrl(request.body.GITLAB_API_BASE)) {
            return reply.code(400).send({ error: t('errors:invalid_url', { defaultValue: 'invalid_url' }, request.locale || 'en'), code: 'invalid_url', field: 'GITLAB_API_BASE' });
        }
        if (request.body?.GITEA_CALLBACK_URL && !isValidUrl(request.body.GITEA_CALLBACK_URL)) {
            return reply.code(400).send({ error: t('errors:invalid_url', { defaultValue: 'invalid_url' }, request.locale || 'en'), code: 'invalid_url', field: 'GITEA_CALLBACK_URL' });
        }
        if (request.body?.GITEA_API_BASE && !isValidUrl(request.body.GITEA_API_BASE)) {
            return reply.code(400).send({ error: t('errors:invalid_url', { defaultValue: 'invalid_url' }, request.locale || 'en'), code: 'invalid_url', field: 'GITEA_API_BASE' });
        }
        const body = { ...(request.body || {}) };
        const MASK = '••••••••';
        const gitProviderConfigKeys = [
            { prefix: 'GITHUB', fields: ['CLIENT_ID', 'CLIENT_SECRET', 'CALLBACK_URL', 'API_BASE'] },
            { prefix: 'GITLAB', fields: ['CLIENT_ID', 'CLIENT_SECRET', 'CALLBACK_URL', 'API_BASE'] },
            { prefix: 'GITEA', fields: ['CLIENT_ID', 'CLIENT_SECRET', 'CALLBACK_URL', 'API_BASE'] },
        ];
        for (const { prefix, fields } of gitProviderConfigKeys) {
            for (const field of fields) {
                const key = `${prefix}_${field}`;
                if (body[key] !== undefined) {
                    if (field === 'CLIENT_SECRET') {
                        if (body[key] === MASK) {
                            // preserve existing secret
                        } else if (body[key] === '') {
                            await platformSettings.set(key, '');
                        } else if (body[key]) {
                            await platformSettings.set(key, platformSecrets.setPlatformSecret(key, body[key]));
                        }
                    } else {
                        await platformSettings.set(key, body[key]);
                    }
                    delete body[key];
                }
            }
        }
        // GitHub App config keys
        const appSecretKeys = ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET'];
        for (const key of appSecretKeys) {
            if (body[key] !== undefined) {
                if (body[key] === MASK) {
                    // preserve existing
                } else if (body[key] === '') {
                    await platformSettings.set(key, '');
                } else if (body[key]) {
                    await platformSettings.set(key, platformSecrets.setPlatformSecret(key, body[key]));
                }
                delete body[key];
            }
        }
        if (body.GITHUB_APP_ID !== undefined) {
            await platformSettings.set('GITHUB_APP_ID', body.GITHUB_APP_ID);
            delete body.GITHUB_APP_ID;
        }
        try {
            const settings = await platformSettings.updateAll(body);
            for (const p of ['GITHUB', 'GITLAB', 'GITEA']) {
                settings[`${p}_CLIENT_SECRET`] = settings[`${p}_CLIENT_SECRET`] ? MASK : '';
            }
            settings.GITHUB_APP_PRIVATE_KEY = settings.GITHUB_APP_PRIVATE_KEY ? MASK : '';
            settings.GITHUB_APP_WEBHOOK_SECRET = settings.GITHUB_APP_WEBHOOK_SECRET ? MASK : '';
            return settings;
        } catch (err) {
            return sendPublicError(reply, err, 'Request failed', 400, request.locale || 'en');
        }
    });

    fastify.get('/api/v1/admin/agents', { preValidation: adminPre }, async () => {
        const { applyGatewaySynthesis, findMissing } = require('../agents/agentEnv');
        const allRows = await db.select().from(schema.agents);
        // Hide agents that don't support gateway mode yet
        const HIDDEN_AGENTS = new Set(['cursor', 'amp', 'commandcode', 'minimax-cli']);
        const rows = allRows.filter((r) => !HIDDEN_AGENTS.has(r.id));
        const platformVault = await platformSecrets.getRaw();
        const platformSynth = applyGatewaySynthesis(platformVault);
        const secretHints = await platformSecrets.getHints();
        const gatewayConfigs = await agentGatewayConfig.getAll();
        const agents = await Promise.all(rows.map(async (row) => {
            const envRequired = JSON.parse(row.envRequired);
            const cfg = gatewayConfigs[row.id] || null;
            const llmAuthMode = await agentGatewayConfig.getAgentAuthMode(row.id);
            let keysReady = true;
            if (llmAuthMode === 'gateway') {
                keysReady = Boolean(agentGatewayConfig.primaryModel(cfg))
                    && (envRequired.length === 0
                        || findMissing(
                            Object.fromEntries(envRequired.map((k) => [k, platformSynth[k] || ''])),
                            envRequired,
                        ).length === 0);
            }
            return {
                id: row.id,
                name: row.name,
                cmd: row.cmd,
                args: JSON.parse(row.args),
                env_required: envRequired,
                llm_auth_mode: llmAuthMode,
                keys_ready: keysReady,
                secrets_configured: Object.fromEntries(
                    envRequired.map((k) => [k, Boolean(secretHints[k])]),
                ),
                gateway_config: cfg,
            };
        }));
        agents.sort((a, b) => a.name.localeCompare(b.name));
        return agents;
    });

    fastify.get('/api/v1/admin/agent-secrets', { preValidation: adminPre }, async () => {
        return platformSecrets.getHints();
    });

    fastify.put('/api/v1/admin/agent-secrets', { preValidation: adminPre }, async (request, reply) => {
        try {
            await platformSecrets.merge(request.body || {});
            return { ok: true, secrets: await platformSecrets.getHints() };
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to save agent secrets', 500, request.locale || 'en');
        }
    });

    fastify.get('/api/v1/admin/gateway/agent-configs', { preValidation: adminPre }, async () => {
        return agentGatewayConfig.getAll();
    });

    fastify.put('/api/v1/admin/gateway/agent-configs/:agentId', { preValidation: adminPre }, async (request, reply) => {
        try {
            const { config, sync } = await agentGatewayConfig.setForAgent(request.params.agentId, request.body || {});
            // Surface every binding-sync failure so admins see why the agent
            // will fail to route once spawned (not just provider_not_found).
            const WARNING_BY_REASON = {
                provider_not_found: (s) => `Provider "${s.providerName}" does not exist in the gateway. Add it under Gateway before launching this agent.`,
                missing_config: () => 'Gateway config is missing. Start the gateway under Settings → Gateway, then re-save this agent.',
                no_provider: () => 'Gateway mode requires a provider. Select one under Gateway before launching this agent.',
                sync_failed: (s) => `Gateway binding sync failed: ${s.error || 'unknown error'}.`,
            };
            const warning = sync && !sync.synced && WARNING_BY_REASON[sync.reason]
                ? WARNING_BY_REASON[sync.reason](sync)
                : undefined;
            return { ok: true, config, warning };
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to save agent gateway config', 500, request.locale || 'en');
        }
    });

    fastify.get('/api/v1/admin/agents/:id/gateway-spawn-preview', { preValidation: adminPre }, async (request, reply) => {
        const { previewGatewaySpawnEnv } = require('../agents/agentEnv');
        const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, request.params.id));
        if (rows.length === 0) return reply.code(404).send({ error: t('errors:agent_not_found', {}, request.locale || 'en'), code: 'agent_not_found' });
        const row = rows[0];
        const draftModel = request.query?.model;
        const draftProvider = request.query?.provider;
        const draftAuthMode = request.query?.llm_auth_mode;
        try {
            return await previewGatewaySpawnEnv(row.id, {
                envRequired: JSON.parse(row.envRequired),
                cmd: row.cmd,
                args: JSON.parse(row.args),
                draftModel: typeof draftModel === 'string' ? draftModel : undefined,
                draftProvider: typeof draftProvider === 'string' ? draftProvider : undefined,
                draftAuthMode: typeof draftAuthMode === 'string' ? draftAuthMode : undefined,
            });
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to preview gateway spawn env', 500, request.locale || 'en');
        }
    });

    fastify.get('/api/v1/admin/agents/:id/vm-resources', { preValidation: adminPre }, async (request, reply) => {
        const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, request.params.id));
        if (rows.length === 0) return reply.code(404).send({ error: t('errors:agent_not_found', {}, request.locale || 'en'), code: 'agent_not_found' });
        return {
            agent_id: rows[0].id,
            vm_resources: rows[0].vmResources || null,
        };
    });

    fastify.put('/api/v1/admin/agents/:id/vm-resources', { preValidation: adminPre }, async (request, reply) => {
        const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, request.params.id));
        if (rows.length === 0) return reply.code(404).send({ error: t('errors:agent_not_found', {}, request.locale || 'en'), code: 'agent_not_found' });
        const body = request.body || {};
        const resources = {};
        if (body.disk_size_gb != null) {
            const v = Number(body.disk_size_gb);
            if (!Number.isFinite(v) || v < 1) return reply.code(400).send({ error: t('errors:disk_size_gb_must_be_positive', { defaultValue: 'disk_size_gb must be >= 1' }, request.locale || 'en'), code: 'disk_size_gb_must_be_positive' });
            resources.disk_size_gb = v;
        }
        if (body.cpus != null) {
            const v = Number(body.cpus);
            if (!Number.isFinite(v) || v < 1) return reply.code(400).send({ error: t('errors:cpus_must_be_positive', { defaultValue: 'cpus must be >= 1' }, request.locale || 'en'), code: 'cpus_must_be_positive' });
            resources.cpus = v;
        }
        if (body.memory_mib != null) {
            const v = Number(body.memory_mib);
            if (!Number.isFinite(v) || v < 1) return reply.code(400).send({ error: t('errors:memory_mib_must_be_positive', { defaultValue: 'memory_mib must be >= 1' }, request.locale || 'en'), code: 'memory_mib_must_be_positive' });
            resources.memory_mib = v;
        }
        const json = Object.keys(resources).length > 0 ? JSON.stringify(resources) : null;
        await db.update(schema.agents).set({ vmResources: json }).where(eq(schema.agents.id, request.params.id));
        return {
            agent_id: rows[0].id,
            vm_resources: resources,
        };
    });

    const getAgentImagesCatalog = async () => {
        const catalog = await listAgentBoxImageCatalog();
        return {
            base_image: resolveBoxBaseImage(),
            buildable_agents: listBuildableAgentImages(),
            build_command: 'npm run build:agent-images',
            agents: catalog,
        };
    };

    const registerAgentImageVersion = async (request, reply) => {
        const body = request.body || {};
        try {
            const version = await registerVersion({
                agentId: request.params.agentId,
                tag: body.tag,
                imageRef: body.image_ref,
                digest: body.digest,
                notes: body.notes,
                builtAt: body.built_at,
                createdBy: request.user.id,
                setActive: Boolean(body.set_active),
            });
            return { ok: true, version };
        } catch (err) {
            const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
            return sendPublicError(reply, err, 'Failed to register image version', statusCode, request.locale || 'en');
        }
    };

    const activateAgentImageVersion = async (request, reply) => {
        try {
            const version = await activateVersion(request.params.versionId, request.user.id);
            return { ok: true, version };
        } catch (err) {
            const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
            return sendPublicError(reply, err, 'Failed to activate image version', statusCode, request.locale || 'en');
        }
    };

    const deprecateAgentImageVersion = async (request, reply) => {
        try {
            const version = await deprecateVersion(request.params.versionId);
            return { ok: true, version };
        } catch (err) {
            const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
            return sendPublicError(reply, err, 'Failed to deprecate image version', statusCode, request.locale || 'en');
        }
    };

    const deleteAgentImageVersion = async (request, reply) => {
        try {
            const result = await deleteVersion(request.params.versionId);
            return result;
        } catch (err) {
            const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
            return sendPublicError(reply, err, 'Failed to delete image version', statusCode, request.locale || 'en');
        }
    };

    const buildAgentImage = async (request, reply) => {
        try {
            const body = request.body || {};
            const build = await buildImage({
                agentId: request.params.agentId,
                tag: body.tag,
                notes: body.notes,
                createdBy: request.user.id,
            });
            return reply.code(201).send({ build });
        } catch (err) {
            const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
            return sendPublicError(reply, err, 'Failed to build image', statusCode, request.locale || 'en');
        }
    };

    const getAgentImageBuilds = async (request, reply) => {
        try {
            const builds = await getBuilds(request.params.agentId);
            return { builds };
        } catch (err) {
            return reply.code(500).send({ error: t('errors:failed_to_list_builds', { defaultValue: 'Failed to list builds' }, request.locale || 'en'), code: 'failed_to_list_builds' });
        }
    };

    const getAgentImageBuildLogs = async (request, reply) => {
        try {
            const result = await getBuildLogs(request.params.buildId);
            return result;
        } catch (err) {
            const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
            return sendPublicError(reply, err, 'Failed to get build logs', statusCode, request.locale || 'en');
        }
    };

    const retryAgentImageBuild = async (request, reply) => {
        try {
            const build = await retryBuild(request.params.buildId, request.user.id);
            return reply.code(201).send({ build });
        } catch (err) {
            const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
            return sendPublicError(reply, err, 'Failed to retry build', statusCode, request.locale || 'en');
        }
    };

    const deleteAgentImageBuild = async (request, reply) => {
        try {
            const result = await deleteBuild(request.params.buildId);
            return result;
        } catch (err) {
            const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
            return sendPublicError(reply, err, 'Failed to delete build', statusCode, request.locale || 'en');
        }
    };

    for (const prefix of ['/api/v1/admin/agent-images', '/api/v1/admin/boxlite/agent-images']) {
        fastify.get(prefix, { preValidation: adminPre }, getAgentImagesCatalog);
        fastify.post(`${prefix}/:agentId/versions`, { preValidation: adminPre }, registerAgentImageVersion);
        fastify.post(`${prefix}/versions/:versionId/activate`, { preValidation: adminPre }, activateAgentImageVersion);
        fastify.post(`${prefix}/versions/:versionId/deprecate`, { preValidation: adminPre }, deprecateAgentImageVersion);
        fastify.delete(`${prefix}/versions/:versionId`, { preValidation: adminPre }, deleteAgentImageVersion);
        fastify.post(`${prefix}/:agentId/build`, { preValidation: adminPre }, buildAgentImage);
        fastify.get(`${prefix}/:agentId/builds`, { preValidation: adminPre }, getAgentImageBuilds);
        fastify.get(`${prefix}/builds/:buildId/logs`, { preValidation: adminPre }, getAgentImageBuildLogs);
        fastify.post(`${prefix}/builds/:buildId/retry`, { preValidation: adminPre }, retryAgentImageBuild);
        fastify.delete(`${prefix}/builds/:buildId`, { preValidation: adminPre }, deleteAgentImageBuild);
    }

    // Scheduler 状态（P2）
    fastify.get('/api/v1/admin/scheduler/status', { preValidation: adminPre }, async () => {
        const { getSchedulerStatus } = require('../scheduler');
        return { jobs: await getSchedulerStatus() };
    });

    // 提炼漏斗统计（P3，04-API规格 §3.2）
    fastify.get('/api/v1/admin/skills/pipeline', { preValidation: adminPre }, async (request, reply) => {
        try {
            const skillPipeline = require('../skills/skillPipeline');
            const candidates = await db.select().from(schema.skillCandidates);
            const byStage = candidates.reduce((acc, c) => {
                acc[c.stage] = (acc[c.stage] || 0) + 1;
                return acc;
            }, {});
            const clusterCounts = {};
            for (const c of candidates) {
                if (c.clusterId && c.clusterSize >= 2) {
                    clusterCounts[c.clusterId] = c.clusterSize;
                }
            }
            const statusRows = await db
                .select({ status: schema.skills.status, count: sql`count(*)::int` })
                .from(schema.skills)
                .groupBy(schema.skills.status);
            const skillsByStatus = statusRows.reduce((acc, r) => { acc[r.status] = Number(r.count); return acc; }, {});
            return {
                funnel: {
                    candidatesTotal: candidates.length,
                    byStage,
                    clusters: Object.entries(clusterCounts).map(([clusterId, size]) => ({ clusterId, size })),
                    skillsByStatus,
                },
                config: {
                    minScore: skillPipeline.MIN_SCORE || require('../skills/skillScorer').MIN_SCORE,
                    singletonMinScore: require('../skills/skillScorer').SINGLETON_MIN_SCORE,
                    enabled: skillPipeline.isEnabled(),
                },
            };
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to get skill pipeline stats', 500, request.locale || 'en');
        }
    });

    // 手动触发 job（P2，调试用）
    fastify.post('/api/v1/admin/scheduler/:jobName/run', { preValidation: adminPre }, async (request, reply) => {
        const { triggerJob } = require('../scheduler');
        const jobName = String(request.params.jobName);
        const result = await triggerJob(jobName);
        if (result === false) {
            return reply.code(404).send({ code: 'scheduler_job_not_found' });
        }
        if (result === 'locked') {
            return reply.code(409).send({ code: 'scheduler_locked' });
        }
        if (result === 'error') {
            return reply.code(500).send({ code: 'scheduler_job_failed' });
        }
        return reply.code(202).send({ ok: true, jobName });
    });
}

module.exports = { registerAdminRoutes };
