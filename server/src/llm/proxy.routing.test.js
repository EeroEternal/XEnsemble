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

const TEST_SESSION_ID = 'sess_proxy_routing_test';
const TEST_AGENT_ID = 'proxy-routing-test';
const TEST_PROJECT_ID = 'proj_proxy_routing_test';
const OPENCODE_SESSION_ID = 'sess_proxy_routing_opencode';
const BODY_MODEL = 'anthropic.acme/deepseek-chat';
const TOKEN_MODEL = 'claude-sonnet-4';
const EXPECTED_FORWARDED_MODEL = 'deepseek/deepseek-chat';
const OPENCODE_REAL_MODEL = 'google/gemini-2.0-flash';
const OPENCODE_ALIAS_MODEL = 'google-gemini-2.0-flash';

describe('LLM proxy intelligent routing', { concurrency: false, timeout: 60000 }, () => {
    let app;
    let appBaseUrl;
    let stub;
    let stubUrl;
    let testUserId;
    let originalConfig;
    let originalEnsureRunning;
    let originalEnsureSecrets;
    let originalCaptureMode;
    let insertedAgent = false;
    const received = [];

    async function waitForLatestUsage(sessionId) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const rows = await db.select().from(schema.llmUsage)
                .where(eq(schema.llmUsage.sessionId, sessionId));
            if (rows.length > 0) {
                return rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0];
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`timed out waiting for llm_usage session=${sessionId}`);
    }

    let originalUpstreamUrl;

    before(async () => {
        originalUpstreamUrl = process.env.LLM_GATEWAY_UPSTREAM_URL;
        originalCaptureMode = process.env.LLM_CAPTURE_MODE;
        process.env.LLM_CAPTURE_MODE = 'off';
        resetAgentApiKeyCacheForTests();
        resetLlmQuotaForTests();

        stub = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url === '/api/admin/api-keys') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                return;
            }
            if (req.method === 'POST' && req.url === '/v1/chat/completions') {
                const chunks = [];
                req.on('data', (c) => chunks.push(c));
                req.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try { json = JSON.parse(raw); } catch { /* ignore */ }
                    received.push({ method: req.method, url: req.url, body: json });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'chatcmpl-routing-test',
                        object: 'chat.completion',
                        choices: [{
                            index: 0,
                            message: { role: 'assistant', content: 'ok' },
                            finish_reason: 'stop',
                        }],
                        usage: {
                            prompt_tokens: 10,
                            completion_tokens: 2,
                            total_tokens: 12,
                            prompt_tokens_details: { cached_tokens: 3 },
                        },
                    }));
                });
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

        ctx = await bootstrapTestDb(
            ['./router/sticky', './router/lastUsage', './serviceRouter', './proxy'],
            __dirname,
        );
        ({ db, schema } = ctx);
        const serviceRouter = ctx.reloaded['./serviceRouter'];
        serviceRouter.getAgentGatewayKey = async () => 'ugk_test_agent_gateway_key';
        delete require.cache[require.resolve('./proxy', { paths: [__dirname] })];
        registerLlmProxy = require('./proxy').registerLlmProxy;

        const users = await db.select().from(schema.users).limit(1);
        if (users.length > 0) {
            testUserId = users[0].id;
        } else {
            testUserId = 'usr_proxy_routing_test';
            await db.insert(schema.users).values({
                id: testUserId,
                username: 'proxy_routing_test',
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
                name: 'Proxy Routing Test',
                cmd: 'proxy-routing-test',
                args: '[]',
                envRequired: '[]',
            });
        }
        await db.delete(schema.projects).where(eq(schema.projects.id, TEST_PROJECT_ID));
        await db.insert(schema.projects).values({
            id: TEST_PROJECT_ID,
            userId: testUserId,
            name: 'Proxy Routing Project',
            serverPath: '/tmp',
            createdAt: Date.now(),
        });

        const cfgRows = await db
            .select()
            .from(schema.platformSettings)
            .where(eq(schema.platformSettings.key, 'agent_gateway_config'));
        originalConfig = cfgRows[0]?.value || '{}';

        const next = {
            ...JSON.parse(originalConfig),
            [TEST_AGENT_ID]: { llm_auth_mode: 'gateway', provider: 'deepseek', model: 'deepseek-chat' },
            opencode: { llm_auth_mode: 'gateway', provider: 'openrouter', model: OPENCODE_REAL_MODEL },
        };
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

        const opencodeAgents = await db.select().from(schema.agents).where(eq(schema.agents.id, 'opencode'));
        if (opencodeAgents.length === 0) {
            await db.insert(schema.agents).values({
                id: 'opencode',
                name: 'OpenCode',
                cmd: 'opencode',
                args: '[]',
                envRequired: '[]',
            });
        }
        await db.delete(schema.sessions).where(eq(schema.sessions.id, OPENCODE_SESSION_ID));
        await db.insert(schema.sessions).values({
            id: OPENCODE_SESSION_ID,
            userId: testUserId,
            projectId: TEST_PROJECT_ID,
            agentId: 'opencode',
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
        if (originalCaptureMode == null) {
            delete process.env.LLM_CAPTURE_MODE;
        } else {
            process.env.LLM_CAPTURE_MODE = originalCaptureMode;
        }
        await db.delete(schema.llmUsage).where(eq(schema.llmUsage.sessionId, TEST_SESSION_ID));
        await db.delete(schema.llmUsage).where(eq(schema.llmUsage.sessionId, OPENCODE_SESSION_ID));
        await db.delete(schema.sessionRouteSticky).where(eq(schema.sessionRouteSticky.sessionId, TEST_SESSION_ID));
        await db.delete(schema.sessionRouteSticky).where(eq(schema.sessionRouteSticky.sessionId, OPENCODE_SESSION_ID));
        await db.delete(schema.sessions).where(eq(schema.sessions.id, TEST_SESSION_ID));
        await db.delete(schema.sessions).where(eq(schema.sessions.id, OPENCODE_SESSION_ID));
        await db.delete(schema.projects).where(eq(schema.projects.id, TEST_PROJECT_ID));
        if (insertedAgent) {
            await db.delete(schema.agents).where(eq(schema.agents.id, TEST_AGENT_ID));
        }
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

    it('rejects chat completions without a session token', { timeout: 15000 }, async () => {
        const res = await fetch(`${appBaseUrl}/api/v1/llm/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: BODY_MODEL,
                messages: [{ role: 'user', content: 'hello' }],
            }),
        });
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.code, 'missing_session_token');
    });

    it('forwards bound provider/canonical model, not the session token default', { timeout: 15000 }, async () => {
        const token = issueSessionToken({
            sessionId: TEST_SESSION_ID,
            userId: testUserId,
            projectId: TEST_PROJECT_ID,
            agentId: TEST_AGENT_ID,
            model: TOKEN_MODEL,
            role: 'admin',
        });

        received.length = 0;
        const res = await fetch(`${appBaseUrl}/api/v1/llm/v1/chat/completions`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: BODY_MODEL,
                messages: [{ role: 'user', content: 'hello' }],
            }),
        });

        const rawBody = await res.text();
        assert.equal(res.status, 200, rawBody);
        assert.equal(received.length, 1, 'gateway should receive one chat completion');
        assert.equal(received[0].body.model, EXPECTED_FORWARDED_MODEL);
        assert.notEqual(received[0].body.model, TOKEN_MODEL);
        assert.notEqual(received[0].body.model, BODY_MODEL);

        const usageRow = await waitForLatestUsage(TEST_SESSION_ID);
        assert.equal(usageRow.model, EXPECTED_FORWARDED_MODEL);
        assert.equal(usageRow.requestedModel, BODY_MODEL);
        assert.equal(usageRow.trigger, 'first_turn');
        assert.equal(usageRow.seq, 1);
        assert.equal(usageRow.cachedTokens, 3);
        assert.equal(typeof usageRow.difficulty, 'number');
        assert.ok(usageRow.difficulty >= 0 && usageRow.difficulty <= 1);
    });

    it('opencode alias rewrites to real id after routing prefixes the alias', { timeout: 15000 }, async () => {
        const token = issueSessionToken({
            sessionId: OPENCODE_SESSION_ID,
            userId: testUserId,
            projectId: TEST_PROJECT_ID,
            agentId: 'opencode',
            model: TOKEN_MODEL,
            role: 'admin',
        });

        received.length = 0;
        const res = await fetch(`${appBaseUrl}/api/v1/llm/v1/chat/completions`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: OPENCODE_ALIAS_MODEL,
                messages: [{ role: 'user', content: 'hello' }],
            }),
        });

        const rawBody = await res.text();
        assert.equal(res.status, 200, rawBody);
        assert.equal(received.length, 1, 'gateway should receive one chat completion');
        const forwarded = received[0].body.model;
        assert.match(String(forwarded), /google\/gemini-2\.0-flash/);
        assert.notEqual(forwarded, OPENCODE_ALIAS_MODEL);
        assert.notEqual(forwarded, `openrouter/${OPENCODE_ALIAS_MODEL}`);

        const usageRow = await waitForLatestUsage(OPENCODE_SESSION_ID);
        assert.equal(usageRow.requestedModel, OPENCODE_ALIAS_MODEL);
        assert.match(String(usageRow.model), /google\/gemini-2\.0-flash/);
        assert.equal(usageRow.trigger, 'first_turn');
        assert.equal(usageRow.seq, 1);
        assert.equal(typeof usageRow.difficulty, 'number');
        assert.ok(usageRow.difficulty >= 0 && usageRow.difficulty <= 1);
    });
});
