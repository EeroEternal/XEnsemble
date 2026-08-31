const { Readable } = require('stream');
const httpProxy = require('http-proxy');
const unigateway = require('../gateway/unigatewayManager');
const { verifySessionToken } = require('./sessionToken');
const { resolveGatewayUpstreamUrl } = require('./gatewayUpstream');
const serviceRouter = require('./serviceRouter');
const { checkLlmRequestQuota } = require('./quota');
const { recordEvent } = require('../events/recordEvent');
const chatTranscript = require('./chatTranscript');
const { assertActiveUser } = require('../auth/assertActiveUser');
const policy = require('../auth/PolicyService');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq } = require('drizzle-orm');
const agentGatewayConfig = require('../admin/AgentGatewayConfig');
const { t } = require('../i18n');

const LLM_PROXY_PREFIX = '/api/v1/llm';

const proxy = httpProxy.createProxyServer({
    xfwd: true,
    changeOrigin: true,
});

// Last recorded user prompt per session, used to dedup the chat view record
// (agent CLIs replay the full message history on every request).
const lastUserPromptBySession = new Map();
// Recorded tool-call ids per session, to avoid re-recording the same tool call
// (SSE deltas arrive fragmented; a tool_call id may span multiple chunks).
const recordedToolCallIds = new Map();
// Recorded tool-result call ids per session (agent replays history every turn).
const recordedToolResultIds = new Map();

function isNewToolCall(sessionId, id) {
    if (!id) return false;
    let set = recordedToolCallIds.get(sessionId);
    if (!set) { set = new Set(); recordedToolCallIds.set(sessionId, set); }
    if (set.has(id)) return false;
    set.add(id);
    return true;
}

function isNewToolResult(sessionId, callId) {
    if (!callId) return false;
    let set = recordedToolResultIds.get(sessionId);
    if (!set) { set = new Set(); recordedToolResultIds.set(sessionId, set); }
    if (set.has(callId)) return false;
    set.add(callId);
    return true;
}

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

const { guessContextLength } = require('./modelContext');

async function serveAgentModelsCatalog(claims, reply) {
    if (!claims?.aid) return false;
    const cfg = await agentGatewayConfig.getForAgent(claims.aid);
    const models = agentGatewayConfig.allModels(cfg);
    if (models.length === 0) return false;
    const provider = (cfg?.provider ?? '').trim();
    const isClaudeCode = claims.aid === 'claude-code';
    // opencode registers its gateway models under bare ids (no provider prefix,
    // see ensureGatewayConfig/applyOpencodeGatewayEnv). If /v1/models returned
    // `provider/model` ids here, opencode would pick up an id like
    // `volcengine-zxs2/deepseek-v4-flash-ga-260731` and keep sending that
    // prefixed id even after the agent's binding switches back to another
    // provider, which force-routes to the stale provider. Offer bare ids so
    // opencode always sends the model name alone and routing follows binding.
    const isOpencode = claims.aid === 'opencode';
    // Return a combined Anthropic+OpenAI format: claude-code validates the
    // Anthropic shape (type/display_name/created_at), while OpenAI-compatible
    // clients read object/created/owned_by. Including all fields satisfies both.
    const data = models.map((m) => {
        const rawId = provider ? `${provider}/${m}` : m;
        // claude-code >= 2.1.236 filters /v1/models entries, keeping only ids
        // that start with `anthropic.` or match `claude-...`. Prefix the raw
        // target with `anthropic.` so every configured model is offered in
        // /model; the gateway strips the prefix back off before routing to the
        // real provider/model.
        const id = isClaudeCode ? `anthropic.${rawId}` : isOpencode ? m : rawId;
        return {
            id,
            type: 'model',
            object: 'model',
            display_name: isOpencode ? m : rawId,
            created: 0,
            created_at: '2025-01-01T00:00:00Z',
            owned_by: provider || 'xensemble',
            context_length: guessContextLength(m),
        };
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

function forwardToGateway(request, reply, { targetBaseUrl, gatewayKey, path, onResponseBody }) {
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
            // Tap the upstream response body (non-blocking) so the LLM proxy can
            // record the assistant reply for the chat view. The response is
            // piped through http-proxy to the client regardless; adding data
            // listeners here only observes the stream.
            if (typeof onResponseBody === 'function') {
                const chunks = [];
                let size = 0;
                const MAX_CAPTURE = 2 * 1024 * 1024;
                const onData = (chunk) => {
                    size += chunk.length;
                    if (size <= MAX_CAPTURE) chunks.push(chunk);
                };
                const onEnd = () => {
                    proxyRes.removeListener('data', onData);
                    proxyRes.removeListener('end', onEnd);
                    if (statusCode >= 200 && statusCode < 300 && chunks.length) {
                        try {
                            const body = Buffer.concat(chunks);
                            onResponseBody(body, proxyRes.headers['content-type'] || '');
                        } catch (_) { /* ignore */ }
                    }
                };
                proxyRes.on('data', onData);
                proxyRes.on('end', onEnd);
            }
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

/**
 * Extract the user's latest message from an OpenAI-style chat/completions body.
 * Agent CLIs send the full conversation history on every request, so we pick
 * the last role:'user' message (the user's actual input). Tool results are
 * role:'tool' and reasoning messages role:'assistant', so they are skipped.
 */
function extractUserMessage(bodyBuffer) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return null;
    try {
        const parsed = JSON.parse(bodyBuffer.toString('utf8'));
        const messages = parsed?.messages;
        if (!Array.isArray(messages)) return null;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!m || m.role !== 'user') continue;
            const content = typeof m.content === 'string' ? m.content.trim() : '';
            if (content) return content;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Extract the assistant reply from an upstream chat/completions response body.
 * Handles both streaming (text/event-stream SSE deltas) and non-streaming JSON.
 */
function extractAssistantMessage(bodyBuffer, contentType) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return '';
    const isStream = typeof contentType === 'string' && contentType.includes('text/event-stream');
    if (isStream) {
        const lines = bodyBuffer.toString('utf8').split('\n');
        const parts = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
                const obj = JSON.parse(data);
                const delta = obj?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') parts.push(delta);
            } catch (_) { /* partial line */ }
        }
        return parts.join('').trim();
    }
    try {
        const obj = JSON.parse(bodyBuffer.toString('utf8'));
        const content = obj?.choices?.[0]?.message?.content;
        return typeof content === 'string' ? content.trim() : '';
    } catch {
        return '';
    }
}

/**
 * Extract tool_calls from an upstream chat/completions response body.
 * Returns [{ id, name, args }]. Handles both streaming (SSE deltas, where the
 * same call id spans multiple fragments that must be concatenated) and
 * non-streaming JSON.
 */
function extractToolCalls(bodyBuffer, contentType) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return [];
    const isStream = typeof contentType === 'string' && contentType.includes('text/event-stream');
    if (isStream) {
        const byIndex = new Map(); // index -> { id, name, args }
        const lines = bodyBuffer.toString('utf8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
                const obj = JSON.parse(data);
                const deltas = obj?.choices?.[0]?.delta?.tool_calls;
                if (!Array.isArray(deltas)) continue;
                for (const d of deltas) {
                    const idx = d?.index ?? 0;
                    let acc = byIndex.get(idx) || { id: null, name: '', args: '' };
                    if (d.id) acc.id = d.id;
                    if (d.function?.name) acc.name += d.function.name;
                    if (d.function?.arguments) acc.args += d.function.arguments;
                    byIndex.set(idx, acc);
                }
            } catch (_) { /* partial line */ }
        }
        return [...byIndex.values()]
            .filter((c) => c.name)
            .map((c) => ({ id: c.id || null, name: c.name, args: c.args }));
    }
    try {
        const obj = JSON.parse(bodyBuffer.toString('utf8'));
        const calls = obj?.choices?.[0]?.message?.tool_calls;
        if (!Array.isArray(calls)) return [];
        return calls
            .filter((c) => c?.function?.name)
            .map((c) => ({
                id: c.id || null,
                name: c.function.name,
                args: typeof c.function.arguments === 'string' ? c.function.arguments : '',
            }));
    } catch {
        return [];
    }
}

/**
 * Extract tool_result messages from an OpenAI-style chat/completions request
 * body. Returns [{ callId, name, content }]. Tool results are messages with
 * role:'tool' — the agent echoes them after executing a tool call.
 */
function extractToolResults(bodyBuffer) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return [];
    try {
        const parsed = JSON.parse(bodyBuffer.toString('utf8'));
        const messages = parsed?.messages;
        if (!Array.isArray(messages)) return [];
        return messages
            .filter((m) => m?.role === 'tool' && (m.tool_call_id || m.name || m.content))
            .map((m) => ({
                callId: m.tool_call_id || null,
                name: typeof m.name === 'string' ? m.name : '',
                content: typeof m.content === 'string' ? m.content : '',
            }));
    } catch {
        return [];
    }
}

async function proxyLlmRequest(request, reply) {
    const rawToken = extractBearerToken(request.raw);
    if (!rawToken) {
        request.log.warn({ path: request.url, hasAuth: !!request.headers.authorization, hasApiKey: !!request.headers['x-api-key'] }, '[llm-proxy] missing session token');
        return reply.code(401).send({ error: t('errors:missing_session_token', {}, request.locale || 'en'), code: 'missing_session_token' });
    }

    const claims = verifySessionToken(rawToken);
    if (!claims) {
        request.log.warn({ tokenPrefix: rawToken.slice(0, 20), tokenLen: rawToken.length, path: request.url }, '[llm-proxy] token verification failed');
        return reply.code(401).send({ error: t('errors:invalid_session_token', {}, request.locale || 'en'), code: 'invalid_session_token' });
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
    // The session-token model is the default chosen at session creation and
    // does NOT reflect /model switches inside the agent CLI. Extract the
    // actual model from the request body so the log shows what the agent
    // really selected — this is the value UniGateway routes on.
    let bodyModel = null;
    let userPrompt = null;
    if (Buffer.isBuffer(request.body) && request.body.length > 0) {
        try {
            const parsed = JSON.parse(request.body.toString('utf8'));
            bodyModel = parsed.model || null;
        } catch { /* non-JSON body */ }
        userPrompt = extractUserMessage(request.body);
    }
    // Record the user's prompt for the chat view (dedup: agent CLIs replay the
    // full history every request, so only record when it differs from the last
    // recorded user message for this session).
    const isChatPath = path === '/v1/chat/completions' || path === '/chat/completions'
        || path === '/v1/messages' || path.endsWith('/chat/completions');
    if (isChatPath && userPrompt && lastUserPromptBySession.get(claims.sid) !== userPrompt) {
        lastUserPromptBySession.set(claims.sid, userPrompt);
        void chatTranscript.append(claims.sid, { role: 'user', content: userPrompt });
    }
    // Record tool_result messages echoed in the request body (the agent sends
    // them back after executing a tool call). Dedup by call id — the agent
    // replays the full history on every request.
    if (isChatPath) {
        for (const tr of extractToolResults(request.body)) {
            if (isNewToolResult(claims.sid, tr.callId) && tr.content) {
                void chatTranscript.append(claims.sid, {
                    role: 'tool_result',
                    callId: tr.callId,
                    tool: tr.name || null,
                    content: tr.content,
                });
            }
        }
    }
    const onResponseBody = (bodyBuffer, contentType) => {
        if (!isChatPath) return;
        const assistantText = extractAssistantMessage(bodyBuffer, contentType);
        if (assistantText) {
            void chatTranscript.append(claims.sid, {
                role: 'assistant',
                content: assistantText,
                model: bodyModel || claims.model || null,
            });
        }
        for (const tc of extractToolCalls(bodyBuffer, contentType)) {
            if (isNewToolCall(claims.sid, tc.id)) {
                void chatTranscript.append(claims.sid, {
                    role: 'tool_call',
                    callId: tc.id,
                    tool: tc.name,
                    content: tc.args,
                });
            }
        }
    };
    request.log.info(
        {
            sessionId: claims.sid,
            userId: claims.uid,
            projectId: claims.pid,
            agentId: claims.aid,
            model: claims.model || null,
            bodyModel,
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
            onResponseBody,
        });
    } catch (err) {
        forwardError = err;
        request.log.error(err, '[llm-proxy] forward failed');
        if (!reply.sent && !reply.raw.writableEnded) {
            return reply.code(502).send({ error: t('errors:llm_proxy_error', {}, request.locale || 'en'), code: 'llm_proxy_error' });
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
    extractUserMessage,
    extractAssistantMessage,
    extractToolCalls,
    extractToolResults,
};
