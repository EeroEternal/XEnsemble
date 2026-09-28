const http = require('http');
const https = require('https');
const { URL } = require('url');
const unigateway = require('./unigatewayManager');
const { enrichLlmProxyStatus } = require('../llm/llmProxyStatus');
const gatewaySettings = require('../admin/GatewaySettings');
const platformSecrets = require('../admin/PlatformSecrets');
const { fetchProviderModels } = require('./fetchProviderModels');
const { testProviderConnectivity } = require('./testProviderConnectivity');
const { readProviderCredentials } = require('./readProviderSecrets');
const { maskApiKey } = require('./maskApiKey');
const { t } = require('../i18n');

// Intentionally in-memory (hot path, not persisted).
const lastProviderTests = new Map();

function httpRequestOnce(url, { method = 'GET', headers = {}, timeoutMs = 2500 } = {}) {
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
        const req = client.request(url, { method, headers }, (res) => {
            res.resume();
            resolve({ statusCode: res.statusCode || 0, error: null });
        });
        req.on('error', (err) => resolve({ statusCode: 0, error: err.message }));
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            resolve({ statusCode: 0, error: 'timeout' });
        });
        req.end();
    });
}

async function probeExternalGateway(baseUrl, adminToken) {
    const normalized = String(baseUrl || '').replace(/\/+$/, '');
    const health = await httpRequestOnce(new URL('/health', normalized));
    const healthOk = health.statusCode === 200;
    let adminAuthOk = false;
    let adminStatusCode = null;
    let lastError = null;

    if (!healthOk) {
        lastError = health.error === 'timeout'
            ? 'External UniGateway health check timed out'
            : (health.error || `External UniGateway health failed (status ${health.statusCode || 'n/a'})`);
    } else if (!adminToken) {
        lastError = 'UNIGATEWAY_ADMIN_TOKEN is required for external UniGateway admin access';
    } else {
        const admin = await httpRequestOnce(new URL('/api/admin/providers', normalized), {
            headers: { 'x-admin-token': adminToken },
        });
        adminStatusCode = admin.statusCode || null;
        adminAuthOk = admin.statusCode === 200;
        if (!adminAuthOk) {
            lastError = admin.statusCode === 401
                ? 'External UniGateway admin token mismatch'
                : (admin.error === 'timeout'
                    ? 'External UniGateway admin probe timed out'
                    : `External UniGateway admin probe failed (status ${admin.statusCode || 'n/a'})`);
        }
    }

    return {
        running: healthOk && adminAuthOk,
        baseUrl: normalized,
        adminToken: adminToken || '',
        external: true,
        health_ok: healthOk,
        admin_auth_ok: adminAuthOk,
        admin_status_code: adminStatusCode,
        lastError,
    };
}

async function resolveGatewayAdminTarget(log) {
    const config = await gatewaySettings.getConfig();
    const externalUrl = process.env.LLM_GATEWAY_UPSTREAM_URL?.trim() || config.upstream_url?.trim();
    if (externalUrl) {
        const secrets = unigateway.ensureGatewaySecrets();
        const adminToken = process.env.UNIGATEWAY_ADMIN_TOKEN || secrets.adminToken;
        return probeExternalGateway(externalUrl, adminToken);
    }
    return unigateway.ensureRunning(log);
}

async function requestGateway(method, pathname, { body, query, log } = {}) {
    const status = await resolveGatewayAdminTarget(log);
    if (!status.running) {
        const message = status.lastError || 'UniGateway is not running';
        return Promise.reject(Object.assign(new Error(message), { statusCode: 503 }));
    }

    const url = new URL(pathname, status.baseUrl);
    if (query) {
        Object.entries(query).forEach(([key, value]) => {
            if (value != null) url.searchParams.set(key, String(value));
        });
    }

    const payload = body != null ? JSON.stringify(body) : null;
    const client = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const req = client.request(
            url,
            {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-token': status.adminToken || '',
                },
            },
            (res) => {
                let raw = '';
                res.on('data', (chunk) => { raw += chunk; });
                res.on('end', () => {
                    let parsed = raw;
                    try {
                        parsed = raw ? JSON.parse(raw) : null;
                    } catch {
                        /* keep text */
                    }
                    resolve({ statusCode: res.statusCode || 500, body: parsed });
                });
            },
        );
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy(Object.assign(new Error('UniGateway admin request timed out'), { statusCode: 504 }));
        });
        if (payload) req.write(payload);
        req.end();
    });
}

function registerGatewayAdminRoutes(fastify) {
    const adminPre = [fastify.authenticate, fastify.requireAdmin];

    // After a provider is created/updated/deleted, re-sync agent service
    // bindings so agents configured for gateway mode pick up the change
    // (e.g. an agent saved with a provider that only now exists), then drop any
    // agent-configured models that are no longer in the provider's catalog.
    // Best-effort.
    async function resyncAgentBindingsAfterProviderChange() {
        try {
            const { syncAllAgentServiceBindings } = require('../llm/agentServiceSync');
            await syncAllAgentServiceBindings(fastify.log);
        } catch (err) {
            fastify.log.warn(err, '[llm] gateway binding sync after provider change failed');
        }
        try {
            const { reconcileAgentModelsFromGateway } = require('../llm/agentServiceSync');
            await reconcileAgentModelsFromGateway(fastify.log);
        } catch (err) {
            fastify.log.warn(err, '[llm] agent model pruning after provider change failed');
        }
    }

    fastify.get('/api/v1/admin/gateway/status', { preValidation: adminPre }, async (request) => {
        const target = await resolveGatewayAdminTarget(request.log);
        if (target.external) {
            return enrichLlmProxyStatus({
                running: Boolean(target.running),
                external: true,
                baseUrl: target.baseUrl,
                health_ok: Boolean(target.health_ok),
                admin_auth_ok: Boolean(target.admin_auth_ok),
                admin_status_code: target.admin_status_code ?? null,
                lastError: target.lastError || null,
            });
        }
        return enrichLlmProxyStatus(await unigateway.refreshRunningState());
    });

    fastify.get('/api/v1/admin/gateway/config', { preValidation: adminPre }, async () => {
        const config = await gatewaySettings.getConfig();
        const status = unigateway.getStatus();
        const enriched = await enrichLlmProxyStatus(status);
        return {
            ...config,
            env_bind_locked: status.envBindLocked,
            llm_proxy_url: enriched.llm_proxy_url,
            control_plane_public_url: enriched.control_plane_public_url,
        };
    });

    fastify.patch('/api/v1/admin/gateway/config', { preValidation: adminPre }, async (request, reply) => {
        try {
            const body = request.body || {};
            const config = await gatewaySettings.updateConfig(body);
            await unigateway.applyRuntimeConfig();
            await unigateway.syncPlatformRouterSecrets(platformSecrets);
            const status = unigateway.getStatus();
            const restartRequested = body.restart === true;
            if (restartRequested && status.running) {
                const restarted = await unigateway.restart(fastify.log);
                if (restarted.running) {
                    await unigateway.syncPlatformRouterSecrets(platformSecrets);
                }
                return { ...config, env_bind_locked: status.envBindLocked, ...restarted };
            }
            return { ...config, env_bind_locked: status.envBindLocked, ...unigateway.getStatus() };
        } catch (err) {
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/admin/gateway/start', { preValidation: adminPre }, async (request, reply) => {
        try {
            const started = await unigateway.start(fastify.log, { force: Boolean(request.body?.force) });
            if (started.running) {
                await unigateway.syncPlatformRouterSecrets(platformSecrets);
            }
            return started;
        } catch (err) {
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/admin/gateway/stop', { preValidation: adminPre }, async () => {
        unigateway.stop();
        return unigateway.getStatus();
    });

    fastify.post('/api/v1/admin/gateway/restart', { preValidation: adminPre }, async (request, reply) => {
        try {
            const restarted = await unigateway.restart(fastify.log);
            if (restarted.running) {
                await unigateway.syncPlatformRouterSecrets(platformSecrets);
            }
            return restarted;
        } catch (err) {
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/admin/gateway/modes', { preValidation: adminPre }, async (request, reply) => {
        try {
            const detailed = request.query?.detailed === 'true';
            const result = await requestGateway('GET', '/api/admin/modes', { query: { detailed }, log: fastify.log });
            return reply.code(result.statusCode).send(result.body);
        } catch (err) {
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/admin/gateway/default-mode', { preValidation: adminPre }, async (request, reply) => {
        try {
            const result = await requestGateway('POST', '/api/admin/preferences/default-mode', {
                body: request.body || {},
                log: fastify.log,
            });
            return reply.code(result.statusCode).send(result.body);
        } catch (err) {
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    fastify.patch('/api/v1/admin/gateway/api-keys', { preValidation: adminPre }, async (request, reply) => {
        try {
            const result = await requestGateway('PATCH', '/api/admin/api-keys', {
                body: request.body || {},
                log: fastify.log,
            });
            return reply.code(result.statusCode).send(result.body);
        } catch (err) {
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/admin/gateway/providers', { preValidation: adminPre }, async (request, reply) => {
        try {
            const result = await requestGateway('GET', '/api/admin/providers', { log: fastify.log });
            const body = result.body && typeof result.body === 'object' ? { ...result.body } : result.body;
            if (body?.data && Array.isArray(body.data)) {
                body.data = body.data.map((provider) => {
                    const creds = readProviderCredentials(provider.name);
                    const apiKey = creds?.api_key || '';
                    return {
                        ...provider,
                        has_api_key: Boolean(apiKey),
                        api_key_masked: apiKey ? maskApiKey(apiKey) : '',
                        last_test: lastProviderTests.get(provider.name) || null,
                    };
                });
            }
            return reply.code(result.statusCode).send(body);
        } catch (err) {
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    fastify.get('/api/v1/admin/gateway/providers/:name/api-key', { preValidation: adminPre }, async (request, reply) => {
        try {
            const name = String(request.params.name || '').trim();
            const creds = readProviderCredentials(name);
            if (!creds) {
                return reply.code(404).send({ error: t('errors:provider_not_found', { name }, request.locale || 'en'), code: 'provider_not_found' });
            }
            if (!creds.api_key) {
                return reply.code(404).send({ error: t('errors:no_api_key_configured', {}, request.locale || 'en'), code: 'no_api_key_configured' });
            }
            return { success: true, data: { api_key: creds.api_key } };
        } catch (err) {
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    fastify.post('/api/v1/admin/gateway/providers/:name/fetch-models', { preValidation: adminPre }, async (request, reply) => {
        try {
            const name = String(request.params.name || '').trim();
            const creds = readProviderCredentials(name);
            if (!creds) {
                return reply.code(404).send({ error: t('errors:provider_not_found', { name }, request.locale || 'en'), code: 'provider_not_found' });
            }
            if (!creds.base_url) {
                return reply.code(400).send({ error: t('errors:no_base_url_configured', {}, request.locale || 'en'), code: 'no_base_url_configured' });
            }
            if (!creds.api_key) {
                return reply.code(400).send({ error: t('errors:no_api_key_configured', {}, request.locale || 'en'), code: 'no_api_key_configured' });
            }
            const result = await fetchProviderModels({
                base_url: creds.base_url,
                api_key: creds.api_key,
            });
            return { success: true, data: result };
        } catch (err) {
            return reply.code(err.statusCode || 500).send({
                error: err.message,
                ...(err.code ? { code: err.code } : {}),
                ...(err.status != null ? { status: err.status } : {}),
                ...(err.detail != null ? { detail: err.detail } : {}),
            });
        }
    });

    fastify.post('/api/v1/admin/gateway/providers/fetch-models', { preValidation: adminPre }, async (request, reply) => {
        try {
            const { base_url, api_key } = request.body || {};
            const result = await fetchProviderModels({ base_url, api_key });
            return { success: true, data: result };
        } catch (err) {
            return reply.code(err.statusCode || 500).send({
                error: err.message,
                ...(err.code ? { code: err.code } : {}),
                ...(err.status != null ? { status: err.status } : {}),
                ...(err.detail != null ? { detail: err.detail } : {}),
            });
        }
    });

    fastify.post('/api/v1/admin/gateway/providers/test', { preValidation: adminPre }, async (request, reply) => {
        try {
            const { base_url, api_key, model, default_model, models } = request.body || {};
            const result = await testProviderConnectivity({ base_url, api_key, model, default_model, models });
            return { success: true, data: result };
        } catch (err) {
            return reply.code(err.statusCode || 500).send({
                error: err.message,
                ...(err.code ? { code: err.code } : {}),
            });
        }
    });

    fastify.post('/api/v1/admin/gateway/providers/:name/test', { preValidation: adminPre }, async (request, reply) => {
        try {
            const name = String(request.params.name || '').trim();
            const creds = readProviderCredentials(name);
            if (!creds) {
                return reply.code(404).send({ error: t('errors:provider_not_found', { name }, request.locale || 'en'), code: 'provider_not_found' });
            }
            if (!creds.base_url) {
                return reply.code(400).send({ error: t('errors:no_base_url_configured', {}, request.locale || 'en'), code: 'no_base_url_configured' });
            }
            if (!creds.api_key) {
                return reply.code(400).send({ error: t('errors:no_api_key_configured', {}, request.locale || 'en'), code: 'no_api_key_configured' });
            }
            const result = await testProviderConnectivity({
                base_url: creds.base_url,
                api_key: creds.api_key,
                default_model: creds.default_model,
                models: creds.models,
            });
            lastProviderTests.set(name, {
                status: result.ok ? 'ok' : 'error',
                code: result.code,
                status_code: result.status,
                message: result.message || '',
                latency_ms: result.latency_ms ?? null,
                tested_at: Date.now(),
            });
            return { success: true, data: result };
        } catch (err) {
            return reply.code(err.statusCode || 500).send({
                error: err.message,
                ...(err.code ? { code: err.code } : {}),
            });
        }
    });

    fastify.post('/api/v1/admin/gateway/providers', { preValidation: adminPre }, async (request, reply) => {
        try {
            const result = await requestGateway('POST', '/api/admin/providers', {
                body: request.body || {},
                log: fastify.log,
            });
            if (result.statusCode >= 200 && result.statusCode < 300) {
                await resyncAgentBindingsAfterProviderChange();
            }
            return reply.code(result.statusCode).send(result.body);
        } catch (err) {
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    fastify.patch('/api/v1/admin/gateway/providers/:name', { preValidation: adminPre }, async (request, reply) => {
        try {
            const name = encodeURIComponent(request.params.name);
            const result = await requestGateway('PATCH', `/api/admin/providers/${name}`, {
                body: request.body || {},
                log: fastify.log,
            });
            if (result.statusCode >= 200 && result.statusCode < 300) {
                await resyncAgentBindingsAfterProviderChange();
            }
            return reply.code(result.statusCode).send(result.body);
        } catch (err) {
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    fastify.delete('/api/v1/admin/gateway/providers/:name', { preValidation: adminPre }, async (request, reply) => {
        try {
            const name = encodeURIComponent(request.params.name);
            const result = await requestGateway('DELETE', `/api/admin/providers/${name}`, { log: fastify.log });
            if (result.statusCode >= 200 && result.statusCode < 300) {
                await resyncAgentBindingsAfterProviderChange();
            }
            return reply.code(result.statusCode).send(result.body);
        } catch (err) {
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });
}

module.exports = {
    registerGatewayAdminRoutes,
    requestGateway,
    resolveGatewayAdminTarget,
    probeExternalGateway,
};
