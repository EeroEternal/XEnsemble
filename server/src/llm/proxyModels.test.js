const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fastify = require('fastify');
const { issueSessionToken } = require('./sessionToken');
const unigateway = require('../gateway/unigatewayManager');
const { eq } = require('drizzle-orm');
const { resetLlmQuotaForTests } = require('./quota');
const { resetAgentApiKeyCacheForTests } = require('./serviceRouter');
const { bootstrapTestDb } = require('../test/db');

let ctx;
let db;
let schema;
let registerLlmProxy;

const TEST_SESSION_ID = 'sess_proxy_models_test';
const TEST_AGENT_ID = 'proxy-models-test';
const TEST_PROJECT_ID = 'proj_proxy_models_test';
const TEST_SESSION_ID_NO_CONFIG = 'sess_proxy_models_noconfig';
const TEST_AGENT_ID_NO_CONFIG = 'proxy-models-noconfig';

const GATEWAY_MODELS = {
    object: 'list',
    data: [{ id: 'deepseek/deepseek-v4-flash', object: 'model', created: 0, owned_by: 'deepseek' }],
};

describe('LLM proxy /v1/models', () => {
    let app;
    let appBaseUrl;
    let stub;
    let stubUrl;
    let testUserId;
    let originalConfig;
    let originalEnsureRunning;
    let originalEnsureSecrets;
    let insertedAgent = false;
    const received = [];

    let originalUpstreamUrl;

    before(async () => {
        originalUpstreamUrl = process.env.LLM_GATEWAY_UPSTREAM_URL;
        resetAgentApiKeyCacheForTests();
        resetLlmQuotaForTests();

        stub = http.createServer((req, res) => {
            received.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
            if (req.method === 'POST' && req.url === '/api/admin/api-keys') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                return;
            }
            if (req.method === 'GET' && req.url === '/v1/models') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(GATEWAY_MODELS));
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
        });
        await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
        stubUrl = `http://127.0.0.1:${stub.address().port}`;
        process.env.LLM_GATEWAY_UPSTREAM_URL = stubUrl;

        originalEnsureRunning = unigateway.ensureRunning;
        originalEnsureSecrets = unigateway.ensureGatewaySecrets;
        unigateway.ensureRunning = async () => ({ running: true, baseUrl: stubUrl, adminToken: '' });
        unigateway.ensureGatewaySecrets = () => ({ gatewayKey: 'test-gateway-key' });

        ctx = await bootstrapTestDb(['../llm/router/lastUsage', '../llm/serviceRouter', '../llm/proxy'], __dirname);
        ({ db, schema } = ctx);
        const serviceRouter = ctx.reloaded['../llm/serviceRouter'];
        serviceRouter.getAgentGatewayKey = async () => 'ugk_test_agent_gateway_key';
        delete require.cache[require.resolve('../llm/proxy', { paths: [__dirname] })];
        registerLlmProxy = require('../llm/proxy').registerLlmProxy;

        const users = await db.select().from(schema.users).limit(1);
        if (users.length > 0) {
            testUserId = users[0].id;
        } else {
            testUserId = 'usr_proxy_models_test';
            await db.insert(schema.users).values({
                id: testUserId,
                username: 'proxy_models_test',
                passwordHash: 'hash',
                role: 'admin',
                status: 'active',
                createdAt: Date.now(),
            });
        }
        const agentRows = await db.select().from(schema.agents).where(eq(schema.agents.id, TEST_AGENT_ID));
        if (agentRows.length === 0) {
            insertedAgent = true;
            await db.insert(schema.agents).values({
                id: TEST_AGENT_ID,
                name: 'Proxy Models Test',
                cmd: 'proxy-models-test',
                args: '[]',
                envRequired: '[]',
            });
        }
        const noConfigAgentRows = await db.select().from(schema.agents).where(eq(schema.agents.id, TEST_AGENT_ID_NO_CONFIG));
        if (noConfigAgentRows.length === 0) {
            await db.insert(schema.agents).values({
                id: TEST_AGENT_ID_NO_CONFIG,
                name: 'Proxy Models NoConfig',
                cmd: 'proxy-models-noconfig',
                args: '[]',
                envRequired: '[]',
            });
        }
        await db.delete(schema.projects).where(eq(schema.projects.id, TEST_PROJECT_ID));
        await db.insert(schema.projects).values({
            id: TEST_PROJECT_ID,
            userId: testUserId,
            name: 'Proxy Models Project',
            serverPath: '/tmp',
            createdAt: Date.now(),
        });

        const cfgRows = await db
            .select()
            .from(schema.platformSettings)
            .where(eq(schema.platformSettings.key, 'agent_gateway_config'));
        originalConfig = cfgRows[0]?.value || '{}';

        const next = { ...JSON.parse(originalConfig), [TEST_AGENT_ID]: { llm_auth_mode: 'gateway', provider: 'deepseek', model: 'deepseek-v4-flash' } };
        if (cfgRows.length > 0) {
            await db.update(schema.platformSettings).set({ value: JSON.stringify(next) }).where(eq(schema.platformSettings.key, 'agent_gateway_config'));
        } else {
            await db.insert(schema.platformSettings).values({ key: 'agent_gateway_config', value: JSON.stringify(next) });
        }

        await db.delete(schema.sessions).where(eq(schema.sessions.id, TEST_SESSION_ID));
        await db.insert(schema.sessions).values({
            id: TEST_SESSION_ID,
            userId: testUserId,
            projectId: TEST_PROJECT_ID,
            agentId: TEST_AGENT_ID,
            cwd: '/tmp',
            status: 'running',
            createdAt: Date.now(),
        });

        await db.delete(schema.sessions).where(eq(schema.sessions.id, TEST_SESSION_ID_NO_CONFIG));
        await db.insert(schema.sessions).values({
            id: TEST_SESSION_ID_NO_CONFIG,
            userId: testUserId,
            projectId: TEST_PROJECT_ID,
            agentId: TEST_AGENT_ID_NO_CONFIG,
            cwd: '/tmp',
            status: 'running',
            createdAt: Date.now(),
        });

        app = fastify({ logger: false });
        await registerLlmProxy(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const { port } = app.server.address();
        appBaseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        unigateway.ensureRunning = originalEnsureRunning;
        unigateway.ensureGatewaySecrets = originalEnsureSecrets;
        resetAgentApiKeyCacheForTests();
        if (originalUpstreamUrl == null) {
            delete process.env.LLM_GATEWAY_UPSTREAM_URL;
        } else {
            process.env.LLM_GATEWAY_UPSTREAM_URL = originalUpstreamUrl;
        }
        await db.delete(schema.sessions).where(eq(schema.sessions.id, TEST_SESSION_ID));
        await db.delete(schema.sessions).where(eq(schema.sessions.id, TEST_SESSION_ID_NO_CONFIG));
        await db.delete(schema.projects).where(eq(schema.projects.id, TEST_PROJECT_ID));
        if (insertedAgent) {
            await db.delete(schema.agents).where(eq(schema.agents.id, TEST_AGENT_ID));
        }
        await db.delete(schema.agents).where(eq(schema.agents.id, TEST_AGENT_ID_NO_CONFIG));
        const cfgRows = await db
            .select()
            .from(schema.platformSettings)
            .where(eq(schema.platformSettings.key, 'agent_gateway_config'));
        if (cfgRows.length > 0) {
            await db
                .update(schema.platformSettings)
                .set({ value: originalConfig })
                .where(eq(schema.platformSettings.key, 'agent_gateway_config'));
        }
        if (app) await app.close();
        if (stub) await new Promise((resolve) => stub.close(resolve));
        if (ctx) await ctx.teardown();
    });

    it('answers /v1/models locally with the agent configured models', { timeout: 15000 }, async () => {
        const token = issueSessionToken({
            sessionId: TEST_SESSION_ID,
            userId: testUserId,
            projectId: TEST_PROJECT_ID,
            agentId: TEST_AGENT_ID,
            role: 'admin',
        });

        const res = await fetch(`${appBaseUrl}/api/v1/llm/v1/models`, {
            headers: { authorization: `Bearer ${token}` },
        });

        const rawBody = await res.text();
        assert.equal(res.status, 200, rawBody);
        const body = JSON.parse(rawBody);
        assert.equal(body.object, 'list');
        assert.ok(body.data.some((m) => m.id === 'deepseek/deepseek-v4-flash'), rawBody);

        // Configured models are served locally; the request must NOT reach the upstream gateway.
        const modelsCall = received.find((r) => r.method === 'GET' && r.url === '/v1/models');
        assert.equal(modelsCall, undefined, 'gateway must not receive GET /v1/models when models are configured');
    });

    it('forwards /v1/models to the gateway when no models are configured', { timeout: 15000 }, async () => {
        const token = issueSessionToken({
            sessionId: TEST_SESSION_ID_NO_CONFIG,
            userId: testUserId,
            projectId: TEST_PROJECT_ID,
            agentId: TEST_AGENT_ID_NO_CONFIG,
            role: 'admin',
        });

        received.length = 0;
        const res = await fetch(`${appBaseUrl}/api/v1/llm/v1/models`, {
            headers: { authorization: `Bearer ${token}` },
        });

        const rawBody = await res.text();
        assert.equal(res.status, 200, rawBody);
        const body = JSON.parse(rawBody);
        assert.equal(body.object, 'list');
        assert.ok(body.data.some((m) => m.id === 'deepseek/deepseek-v4-flash'));

        // No configured models -> fall through to the upstream gateway with the per-agent key.
        const modelsCall = received.find((r) => r.method === 'GET' && r.url === '/v1/models');
        assert.ok(modelsCall, 'gateway should receive GET /v1/models');
        assert.ok(modelsCall.authorization?.startsWith('Bearer '));
        assert.notEqual(modelsCall.authorization, `Bearer ${token}`);
    });
});
