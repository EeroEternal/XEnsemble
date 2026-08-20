const { Readable } = require('stream');
const httpProxy = require('http-proxy');
const unigateway = require('../gateway/unigatewayManager');
const { verifySessionToken } = require('./sessionToken');
const { resolveGatewayUpstreamUrl } = require('./gatewayUpstream');
const serviceRouter = require('./serviceRouter');
const { checkLlmRequestQuota } = require('./quota');
const { recordEvent } = require('../events/recordEvent');
const { assertActiveUser } = require('../auth/assertActiveUser');
const policy = require('../auth/PolicyService');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq } = require('drizzle-orm');
const agentGatewayConfig = require('../admin/AgentGatewayConfig');

const LLM_PROXY_PREFIX = '/api/v1/llm';

const proxy = httpProxy.createProxyServer({
    xfwd: true,
    changeOrigin: true,
});

proxy.on('error', (err, req, res) => {
    if (res.writeHead) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'LLM proxy error' }));
    }
    console.error('[llm-proxy]', err.message);
});

function extractBearerToken(request) {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7).trim();
    const apiKey = request.headers['x-api-key'];
    if (apiKey?.trim()) return apiKey.trim();
    return null;
}

function stripLlmPrefix(url) {
    const [pathname, search = ''] = url.split('?');
    let path = pathname;
    if (path === LLM_PROXY_PREFIX || path === `${LLM_PROXY_PREFIX}/`) {
        path = '/';
    } else if (path.startsWith(`${LLM_PROXY_PREFIX}/`)) {
        path = path.slice(LLM_PROXY_PREFIX.length) || '/';
    }
    path = normalizeUpstreamPath(path);
    const qs = search.startsWith('?') ? search.slice(1) : search;
    return qs ? `${path}?${qs}` : path;
}

/** OpenAI-compatible clients disagree on whether the base URL includes `/v1`. */
function normalizeUpstreamPath(path) {
    const [pathname, search = ''] = path.split('?');
    const aliases = {
        '/chat/completions': '/v1/chat/completions',
        '/embeddings': '/v1/embeddings',
        '/anthropic/v1/messages': '/v1/messages',
    };
    const normalized = aliases[pathname] || pathname;
    if (!search) return normalized;
    const qs = search.startsWith('?') ? search.slice(1) : search;
    return qs ? `${normalized}?${qs}` : normalized;
}

function pathnameOnly(path) {
    return String(path || '').split('?')[0] || '/';
}

/** Read-only discovery paths that must not consume inference quota. */
function isQuotaExemptPath(path) {
    const pathname = pathnameOnly(path);
    return pathname === '/health'
        || pathname === '/v1/models'
        || pathname.startsWith('/v1/models/');
}

/**
 * OpenAI-compatible agents (claude-code, copilot, cline, …) populate their
 * /model picker by GET-ing /v1/models from the gateway base URL. Forwarding
 * that to the upstream returns the upstream's full catalog, not the per-agent
 * configured subset. When the agent has configured gateway models, answer
 * locally with exactly those; otherwise fall through to the upstream forward.
 */
function isModelsDiscoveryPath(path) {
    const pathname = pathnameOnly(path);
    return pathname === '/v1/models' || pathname.startsWith('/v1/models/');
}

async function serveAgentModelsCatalog(claims, reply) {
    if (!claims?.aid) return false;
    const cfg = await agentGatewayConfig.getForAgent(claims.aid);
    const models = agentGatewayConfig.allModels(cfg);
    if (models.length === 0) return false;
    const provider = (cfg?.provider ?? '').trim();
    const data = models.map((m) => {
        const id = provider ? `${provider}/${m}` : m;
        return { id, object: 'model', created: 0, owned_by: provider || 'xensemble' };
    });
    reply.code(200).send({ object: 'list', data });
    return true;
}

async function assertSessionAuthorized(claims) {
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, claims.sid));
    if (rows.length === 0) return { ok: false, status: 401, error: 'Session not found' };
    const row = rows[0];
    if (row.userId !== claims.uid) return { ok: false, status: 403, error: 'Forbidden' };
    if (row.status !== 'running') return { ok: false, status: 401, error: 'Session is not active' };
    if (!claims.aid || row.agentId !== claims.aid) {
        return { ok: false, status: 403, error: 'Agent mismatch' };
    }
    if (claims.pid && row.projectId !== claims.pid) {
        return { ok: false, status: 403, error: 'Project mismatch' };
    }
    const activeUser = await assertActiveUser({ id: claims.uid });
    if (activeUser.error) {
        return { ok: false, status: activeUser.status, error: activeUser.error };
    }
    const agentAccess = await policy.checkAgentAccess(claims.uid, row.agentId, claims.role);
    if (!agentAccess.ok) {
        return { ok: false, status: agentAccess.status || 403, error: agentAccess.error || 'Agent access denied' };
    }
    return { ok: true, session: row };
}

async function resolveGatewayTarget(log) {
    const upstream = await resolveGatewayUpstreamUrl(log);
    if (upstream?.error) return upstream;
    const secrets = unigateway.ensureGatewaySecrets();
    return {
        baseUrl: upstream,
        gatewayKey: secrets.gatewayKey,
    };
}

function forwardToGateway(request, reply, { targetBaseUrl, gatewayKey, path }) {
    return new Promise((resolve, reject) => {
        reply.hijack();
        request.raw.url = path;
        request.raw.headers.authorization = `Bearer ${gatewayKey}`;
        // UniGateway prefers x-api-key over Authorization. Drop the session
        // token header so the upstream key is the one that wins.
        delete request.raw.headers['x-api-key'];
        delete request.raw.headers['X-Api-Key'];

        let statusCode = null;
        const onProxyRes = (proxyRes, req) => {
            if (req !== request.raw) return;
            statusCode = proxyRes.statusCode || null;
            proxy.off('proxyRes', onProxyRes);
        };
        proxy.on('proxyRes', onProxyRes);

        const options = { target: targetBaseUrl, changeOrigin: true };
        // Fastify's content-type parser already drained request.raw, so hand the
        // buffered body to http-proxy explicitly; otherwise the upstream waits
        // for a body that never arrives and the request hangs.
        const body = request.body;
        if (Buffer.isBuffer(body) && body.length > 0) {
            const bodyStream = new Readable();
            bodyStream.push(body);
            bodyStream.push(null);
            options.buffer = bodyStream;
        }
        proxy.web(request.raw, reply.raw, options, (err) => {
            proxy.off('proxyRes', onProxyRes);
            if (err) reject(err);
            else resolve({ statusCode });
        });
    });
}

async function proxyLlmRequest(request, reply) {
    const rawToken = extractBearerToken(request.raw);
    if (!rawToken) {
        return reply.code(401).send({ error: 'Missing session token (Authorization: Bearer xel_…)' });
    }

    const claims = verifySessionToken(rawToken);
    if (!claims) {
        return reply.code(401).send({ error: 'Invalid or expired session token' });
    }

    const authz = await assertSessionAuthorized(claims);
    if (!authz.ok) {
        return reply.code(authz.status).send({ error: authz.error });
    }

    const path = stripLlmPrefix(request.url);
    const quotaExempt = isQuotaExemptPath(path);

    // /v1/models discovery: answer locally with the agent's configured models so
    // every OpenAI-compatible CLI's /model offers exactly the configured subset.
    if (request.method === 'GET' && isModelsDiscoveryPath(path)) {
        if (await serveAgentModelsCatalog(claims, reply)) return;
    }

    const gatewayPromise = resolveGatewayTarget(request.log);
    const quotaPromise = quotaExempt
        ? Promise.resolve({ ok: true })
        : checkLlmRequestQuota(claims.uid, claims.role);

    const [quota, gateway] = await Promise.all([quotaPromise, gatewayPromise]);

    if (!quota.ok) {
        return reply.code(quota.status).send({
            error: quota.error,
            limit: quota.limit,
            window_seconds: quota.window_seconds,
        });
    }

    if (gateway.error) {
        return reply.code(gateway.status).send({ error: gateway.error });
    }
    const started = Date.now();
    request.log.info(
        {
            sessionId: claims.sid,
            userId: claims.uid,
            projectId: claims.pid,
            agentId: claims.aid,
            model: claims.model || null,
            path,
            method: request.method,
            quota_exempt: quotaExempt,
        },
        '[llm-proxy] forwarding',
    );

    let forwardResult = null;
    let forwardError = null;
    try {
        const agentGatewayKey = await serviceRouter.getAgentGatewayKey(claims.aid, request.log);
        forwardResult = await forwardToGateway(request, reply, {
            targetBaseUrl: gateway.baseUrl,
            gatewayKey: agentGatewayKey,
            path,
        });
    } catch (err) {
        forwardError = err;
        request.log.error(err, '[llm-proxy] forward failed');
        if (!reply.sent && !reply.raw.writableEnded) {
            return reply.code(502).send({ error: 'LLM proxy error' });
        }
    } finally {
        recordEvent({
            userId: claims.uid,
            projectId: claims.pid,
            subjectType: 'session',
            subjectId: claims.sid,
            type: 'llm_proxy_forward',
            data: {
                agent_id: claims.aid,
                path,
                method: request.method,
                ok: !forwardError,
                status_code: forwardResult?.statusCode ?? (forwardError ? 502 : null),
                error: forwardError ? String(forwardError.message || forwardError) : null,
                latency_ms: Date.now() - started,
                quota_exempt: quotaExempt,
            },
        }).catch((err) => request.log.warn(err, '[llm-proxy] failed to record event'));
    }
}

async function registerLlmProxy(fastify) {
    // Encapsulate the proxy routes so their raw-body parser does not affect the
    // rest of the app. The body is kept as an untouched Buffer (preserving the
    // exact bytes and content-length) and streamed to the gateway by
    // forwardToGateway; the default JSON parser would consume it instead.
    await fastify.register(async (instance) => {
        // Drop inherited parsers (notably the default application/json parser,
        // which is more specific than '*' and would otherwise win) so every
        // content type is kept as a raw Buffer for forwarding.
        instance.removeAllContentTypeParsers();
        instance.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
            done(null, body);
        });
        const proxyOpts = {
            method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
            handler: proxyLlmRequest,
        };
        instance.route({ url: LLM_PROXY_PREFIX, ...proxyOpts });
        instance.route({ url: `${LLM_PROXY_PREFIX}/*`, ...proxyOpts });
    });
}

module.exports = {
    registerLlmProxy,
    LLM_PROXY_PREFIX,
    stripLlmPrefix,
    normalizeUpstreamPath,
    isQuotaExemptPath,
    isModelsDiscoveryPath,
    serveAgentModelsCatalog,
};
