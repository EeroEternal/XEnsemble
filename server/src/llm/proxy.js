const { Readable } = require('stream');
const httpProxy = require('http-proxy');
const unigateway = require('../gateway/unigatewayManager');
const { verifySessionToken } = require('./sessionToken');
const { resolveGatewayUpstreamUrl } = require('./gatewayUpstream');
const serviceRouter = require('./serviceRouter');
const { checkLlmRequestQuota } = require('./quota');
const { recordEvent } = require('../events/recordEvent');
const chatTranscript = require('./chatTranscript');
const trajectory = require('./trajectory');
const { assertActiveUser } = require('../auth/assertActiveUser');
const policy = require('../auth/PolicyService');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { eq } = require('drizzle-orm');
const agentGatewayConfig = require('../admin/AgentGatewayConfig');
const { resolveOpencodeRoutedModel } = require('../agents/agentModelAlias');
const { extractUsage } = require('./usageExtractor');
const promptCapture = require('./promptCapture');
const { t } = require('../i18n');
const { planRoute } = require('./router');
const { applyChosenModel } = require('./router/execute');
const { touchSticky, recordStickyFailure } = require('./router/sticky');
const { resolveBoundProviderIdsFromGateway } = require('./router/boundProviders');
const { loadLastSessionUsage } = require('./router/lastUsage');
const { fetchModelCatalog } = require('./modelCatalog');

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

/**
 * 按 Agent 清洗用户消息中的格式噪音（XML 标签、时间戳前缀等）。
 * 只匹配包裹整个消息或行首的固定格式，避免误删正文中出现的相同文本。
 */
function cleanUserContent(agentId, content) {
    if (!content || !agentId) return content;
    if (agentId === 'codebuddy') {
        if (/^<user_query>[\s\S]*<\/user_query>$/.test(content)) {
            return content.slice(12, -13);
        }
    }
    if (agentId === 'openclaw') {
        return content.replace(/^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]\s*/, '');
    }
    return content;
}

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

// Last LLM failure recorded per session, used to throttle chat-transcript
// error events: agent CLIs retry 429/5xx responses in loops (with backoff),
// and without throttling the dialog view would flood with identical errors.
const lastLlmErrorBySession = new Map();
const LLM_ERROR_THROTTLE_MS = 30000;

/**
 * Record an LLM failure as a chat event (`role: 'error'`) so the dialog view
 * can show "request failed" immediately instead of "Agent is thinking…"
 * until the idle timeout. Throttled per session: identical consecutive
 * errors (retry loops) record at most once per LLM_ERROR_THROTTLE_MS;
 * a different error always records (the state changed).
 */
function recordLlmErrorEvent(sessionId, status, detail) {
    const content = detail ? `${status}: ${detail}` : `${status}`;
    const now = Date.now();
    const last = lastLlmErrorBySession.get(sessionId);
    if (last && last.content === content && now - last.ts < LLM_ERROR_THROTTLE_MS) return;
    lastLlmErrorBySession.set(sessionId, { content, ts: now });
    void chatTranscript.append(sessionId, { role: 'error', content });
}

/**
 * Pull a short single-line message out of an upstream error body (JSON or
 * plain text) for the chat-transcript error event.
 */
function extractUpstreamErrorText(bodyBuffer, contentType) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return '';
    const raw = bodyBuffer.toString('utf8').slice(0, 2000);
    const isJson = typeof contentType === 'string' && contentType.includes('json');
    if (isJson || raw.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(raw);
            const msg = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? parsed?.detail;
            if (msg != null) return String(msg).replace(/\s+/g, ' ').slice(0, 200);
        } catch (_) { /* fall through to plain text */ }
    }
    return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Detect an in-stream failure inside a 200-status SSE body. The gateway
 * returns streaming failures with HTTP 200 and wraps the error as a
 * `data: {"error": ...}` event (UniGateway main.rs), so a status-code check
 * never sees it — the dialog view would keep "thinking" until the idle
 * timeout. Returns the error message text, or '' when the stream is healthy.
 */
function extractSseErrorText(bodyBuffer) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return '';
    const raw = bodyBuffer.toString('utf8').slice(0, 1024 * 1024);
    // SSE only — JSON error bodies are handled by extractUpstreamErrorText.
    if (!raw.startsWith('data:') && !raw.includes('\ndata:')) return '';
    for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload.startsWith('{') || !payload.includes('"error"')) continue;
        try {
            const obj = JSON.parse(payload);
            const err = obj?.error ?? (obj?.type === 'error' ? obj.error : null);
            if (!err) continue;
            const msg = typeof err === 'string' ? err : err?.message;
            if (msg) return String(msg).replace(/\s+/g, ' ').slice(0, 200);
        } catch (_) { /* not JSON — skip line */ }
    }
    return '';
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

function forwardToGateway(request, reply, { targetBaseUrl, gatewayKey, path, onResponseBody, onErrorResponse }) {
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
                    } else if (statusCode >= 400 && chunks.length && typeof onErrorResponse === 'function') {
                        // Upstream rejected the request (429 rate limit, 5xx, ...):
                        // surface a short error text so the chat view can show
                        // "request failed" instead of "Agent is thinking…".
                        try {
                            const body = Buffer.concat(chunks);
                            onErrorResponse(body, proxyRes.headers['content-type'] || '', statusCode);
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
        let body = request.body;
        // Fastify body parser returns parsed JSON object for application/json
        // Inject thinking_budget for chat/completions requests
        if (body && typeof body === 'object' && (body.model || body.messages)) {
            body.thinking_budget = 1024;
            body = Buffer.from(JSON.stringify(body), 'utf8');
        } else if (Buffer.isBuffer(body) && body.length > 0) {
            // Fallback: raw buffer (if body parser disabled)
            const parsed = JSON.parse(body.toString('utf8'));
            if (parsed && typeof parsed === 'object' && (parsed.model || parsed.messages)) {
                parsed.thinking_budget = 1024;
            }
            body = Buffer.from(JSON.stringify(parsed), 'utf8');
        }
        if (Buffer.isBuffer(body) && body.length > 0) {
            const bodyStream = new Readable();
            bodyStream.push(body);
            bodyStream.push(null);
            options.buffer = bodyStream;
            // 重新序列化后的 body 长度与原始请求不同（注入 thinking_budget /
            // JSON 紧凑化）。http-proxy 原样透传原始 Content-Length，上游按旧
            // 长度读 body 会在 JSON 中途 EOF（"Failed to parse the request
            // body as JSON: EOF while parsing ..."→ 400）。同步改写。
            request.raw.headers['content-length'] = String(body.length);
            delete request.raw.headers['transfer-encoding'];
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
 *
 * Stripped noise (per-block, applied AFTER joining text):
 *  - <system-reminder>...</system-reminder>        (claude-code injects context)
 *  - <local-command-caveat>...</local-command-caveat>
 *  - <command-name>…</command-name>, <command-args>…</command-args>,
 *    <command-message>…</command-message>, <local-command-stdout>…</local-command-stdout>
 *  - generic <foo>...</foo> tags with no attributes (best-effort, leaves
 *    content that has bare < but not closed tags alone)
 * This matters for the dialog view: openai-style bodies prepend these as a
 * leading "<system-reminder>...</system-reminder>\n\n" on every user turn,
 * and anthropic-style bodies put them as the FIRST text block before the
 * actual user input. Without stripping, the dialog shows duplicated/
 * truncated user messages (the first turn becomes the whole reminder blob).
 */
// Strip balanced XML-like tag pairs that agent CLIs inject as fake user
// context (claude-code/opencode prepend <system-reminder>…</system-reminder>
// to every turn, plus <local-command-caveat>, <command-name>, etc.). Walks
// the string with a small balanced-tag parser so nested wrappers are peeled
// layer by layer — a plain non-greedy regex would either match the wrong
// pair or stop at the first inner close tag.
function stripInjectedContext(text) {
    if (!text) return '';
    const TAG_NAME_RE = '[A-Za-z][A-Za-z0-9-]*';
    // Capture group 1 = tag name, group 2 = optional attributes (with
    // leading space). Using two groups so m[1] is always the tag name.
    const OPEN_RE = new RegExp('^<(' + TAG_NAME_RE + ')(\\s[^>]*)?>');
    const CLOSE_NAME_RE = new RegExp('^</(' + TAG_NAME_RE + ')>');
    const result = [];
    let i = 0;
    while (i < text.length) {
        const rest = text.slice(i);
        const m = rest.match(OPEN_RE);
        if (!m) {
            result.push(text[i]);
            i++;
            continue;
        }
        const tagName = m[1];
        const innerStart = i + m[0].length;
        let depth = 1;
        let j = innerStart;
        let balanced = false;
        while (j < text.length) {
            const sub = text.slice(j);
            const close = sub.match(CLOSE_NAME_RE);
            if (close) {
                if (close[1] === tagName) {
                    depth--;
                    j += close[0].length;
                    if (depth === 0) { balanced = true; break; }
                } else {
                    j += close[0].length;
                }
                continue;
            }
            const open = sub.match(OPEN_RE);
            if (open) {
                if (open[1] === tagName) depth++;
                j += open[0].length;
                continue;
            }
            j++;
        }
        if (balanced) {
            i = j;
        } else {
            // No matching close — keep the literal characters and advance one
            // so we don't loop forever on `<foo>bar` (no close).
            result.push(text.slice(i, i + m[0].length));
            i += m[0].length;
        }
    }
    return result.join('').replace(/^\s*\n/, '').trim();
}

function extractUserMessage(bodyBuffer) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return null;
    try {  
        const parsed = JSON.parse(bodyBuffer.toString('utf8'));
        const messages = parsed?.messages;
        if (!Array.isArray(messages)) return null;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!m || m.role !== 'user') continue;
            // OpenAI Chat Completions: content is a plain string.
            if (typeof m.content === 'string') {
                const t = stripInjectedContext(m.content);
                if (t) return t;
                continue;
            }
            // Anthropic Messages: content is an array of blocks.
            // Pull text blocks; skip tool_result blocks (those are echoed tool outputs,
            // not user prompts).
            if (Array.isArray(m.content)) {
                const parts = [];
                for (const block of m.content) {
                    if (block?.type === 'text' && typeof block.text === 'string') {
                        parts.push(block.text);
                    }
                }
                const joined = parts.join('\n');
                const t = stripInjectedContext(joined);
                if (t) return t;
            }
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
        // Detect the protocol by sampling the first parsed SSE event.
        // OpenAI streaming: `data: {"choices":[{"delta":{"content":"…"}}]}` on a single `data:` line.
        // Anthropic streaming: multi-line events (`event: <type>` then `data: {...}`), or
        //   a bare JSON object on a `data:` line whose `type` is "content_block_delta" etc.
        const lines = bodyBuffer.toString('utf8').split('\n');
        let isAnthropic = false;
        for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
                const obj = JSON.parse(data);
                if (obj?.type === 'content_block_delta' || obj?.type === 'message_start' || obj?.type === 'content_block_start') {
                    isAnthropic = true;
                    break;
                }
            } catch { /* partial line */ }
        }
        if (isAnthropic) {
            const parts = [];
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const data = t.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                try {
                    const obj = JSON.parse(data);
                    if (obj?.type === 'content_block_delta' && obj?.delta?.type === 'text_delta') {
                        const piece = obj.delta.text;
                        if (typeof piece === 'string') parts.push(piece);
                    }
                } catch { /* partial line */ }
            }
            return parts.join('').trim();
        }
        // OpenAI Chat Completions streaming.
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
    // Non-streaming response.
    try {
        const obj = JSON.parse(bodyBuffer.toString('utf8'));
        // Anthropic Messages: obj.content is [{type:'text', text:'…'}, {type:'tool_use', ...}].
        if (Array.isArray(obj?.content)) {
            const parts = [];
            for (const block of obj.content) {
                if (block?.type === 'text' && typeof block.text === 'string') {
                    parts.push(block.text);
                }
            }
            return parts.join('').trim();
        }
        // OpenAI Chat Completions: obj.choices[0].message.content.
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
/**
 * Extract tool_calls from an upstream chat/completions response body.
 * Returns [{ id, name, args }]. Handles both streaming (SSE deltas, where the
 * same call id spans multiple fragments that must be concatenated) and
 * non-streaming JSON. Supports OpenAI Chat Completions and Anthropic Messages
 * (where tool_use blocks carry `input` as a JSON object, streamed as
 * `input_json_delta` partial_json fragments).
 */
function extractToolCalls(bodyBuffer, contentType) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return [];
    const isStream = typeof contentType === 'string' && contentType.includes('text/event-stream');
    if (isStream) {
        // Detect Anthropic streaming vs OpenAI streaming.
        const lines = bodyBuffer.toString('utf8').split('\n');
        let isAnthropic = false;
        for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
                const obj = JSON.parse(data);
                if (obj?.type === 'content_block_start' || obj?.type === 'content_block_delta' || obj?.type === 'message_start') {
                    isAnthropic = true;
                    break;
                }
            } catch { /* partial line */ }
        }
        if (isAnthropic) {
            // Track tool_use blocks by their content_block index.
            // id/name come from content_block_start; args accumulate from
            // input_json_delta.partial_json fragments.
            const blocks = new Map(); // index -> { id, name, args }
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const data = t.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                try {
                    const obj = JSON.parse(data);
                    if (obj?.type === 'content_block_start') {
                        const cb = obj?.content_block;
                        if (cb?.type === 'tool_use') {
                            const idx = obj?.index ?? 0;
                            blocks.set(idx, {
                                id: cb.id || null,
                                name: cb.name || '',
                                args: '',
                            });
                        }
                    } else if (obj?.type === 'content_block_delta') {
                        const idx = obj?.index ?? 0;
                        const piece = obj?.delta?.partial_json;
                        if (typeof piece === 'string' && blocks.has(idx)) {
                            blocks.get(idx).args += piece;
                        }
                    }
                } catch { /* partial line */ }
            }
            return [...blocks.values()]
                .filter((c) => c.name)
                .map((c) => ({ id: c.id || null, name: c.name, args: c.args }));
        }
        // OpenAI Chat Completions streaming.
        const byIndex = new Map(); // index -> { id, name, args }
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
    // Non-streaming response.
    try {
        const obj = JSON.parse(bodyBuffer.toString('utf8'));
        // Anthropic Messages: obj.content = [{type:'tool_use', id, name, input}].
        if (Array.isArray(obj?.content)) {
            const calls = [];
            for (const block of obj.content) {
                if (block?.type !== 'tool_use' || !block.name) continue;
                let args = '';
                if (block.input != null) {
                    args = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
                }
                calls.push({ id: block.id || null, name: block.name, args });
            }
            return calls;
        }
        // OpenAI Chat Completions.
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
/**
 * Extract tool_result messages from an OpenAI/Anthropic-style chat request
 * body. Returns [{ callId, name, content }].
 *
 * OpenAI: messages[].role='tool' with tool_call_id + content as string.
 * Anthropic Messages: tool results are inlined as `tool_result` blocks inside
 * a `role: 'user'` message's content array. Each block carries tool_use_id
 * and a content payload (string OR an array of content blocks).
 */
function extractToolResults(bodyBuffer) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return [];
    try {
        const parsed = JSON.parse(bodyBuffer.toString('utf8'));
        const messages = parsed?.messages;
        if (!Array.isArray(messages)) return [];
        const results = [];
        for (const m of messages) {
            if (!m) continue;
            // OpenAI: standalone role:'tool' message.
            if (m.role === 'tool' && (m.tool_call_id || m.name || m.content)) {
                results.push({
                    callId: m.tool_call_id || null,
                    name: typeof m.name === 'string' ? m.name : '',
                    content: typeof m.content === 'string' ? m.content : '',
                });
                continue;
            }
            // Anthropic: tool_result blocks inside a user message.
            if (m.role === 'user' && Array.isArray(m.content)) {
                for (const block of m.content) {
                    if (!block || block.type !== 'tool_result') continue;
                    let content = '';
                    if (typeof block.content === 'string') {
                        content = block.content;
                    } else if (Array.isArray(block.content)) {
                        // Anthropic tool result content can be a list of
                        // text blocks (e.g. for image / document references).
                        const parts = [];
                        for (const sub of block.content) {
                            if (sub?.type === 'text' && typeof sub.text === 'string') {
                                parts.push(sub.text);
                            }
                        }
                        content = parts.join('\n');
                    }
                    results.push({
                        callId: block.tool_use_id || null,
                        name: '', // Anthropic does not echo the tool name in the result block.
                        content,
                    });
                }
            }
        }
        return results;
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
    // Chat-transcription interest is needed before the quota/gateway error
    // branches too (they record chat `error` events), so compute it up front.
    const pathName = path.split('?', 1)[0];
    const isChatPath = pathName === '/v1/chat/completions' || pathName === '/chat/completions'
        || pathName === '/v1/messages' || pathName.endsWith('/chat/completions');

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
        // The user prompt above this point was already recorded in the chat
        // transcript — record the failure too so the dialog view shows
        // "request failed" instead of "Agent is thinking…".
        if (isChatPath) recordLlmErrorEvent(claims.sid, quota.status, quota.error);
        return reply.code(quota.status).send({
            error: quota.error,
            limit: quota.limit,
            window_seconds: quota.window_seconds,
        });
    }

    if (gateway.error) {
        if (isChatPath) recordLlmErrorEvent(claims.sid, gateway.status, gateway.error);
        return reply.code(gateway.status).send({ error: gateway.error });
    }
    const started = Date.now();
    // The session-token model is the default chosen at session creation and
    // does NOT reflect /model switches inside the agent CLI. Extract the
    // actual model from the request body so the log shows what the agent
    // really selected — this is the value UniGateway routes on.
    let bodyModel = null;
    let userPrompt = null;
    let parsedChatBody = null;
    if (Buffer.isBuffer(request.body) && request.body.length > 0) {
        try {
            parsedChatBody = JSON.parse(request.body.toString('utf8'));
            bodyModel = parsedChatBody.model || null;
        } catch { /* non-JSON body */ }
        userPrompt = extractUserMessage(request.body);
    }
    // TEMPORARY prompt capture: dump the agent's raw request body (assembled
    // system prompt + full message array) BEFORE routing / opencode rewrite
    // mutates it. On by default (LLM_CAPTURE_MODE=all, disk-quota
    // guarded) — see .env.example LLM_CAPTURE_* to tune or disable.
    if (isChatPath) {
        promptCapture.capture(claims, request.body);
    }
    // planRoute must run before trajectory.recordRequest so collectSignals
    // still sees the previous turn's messages as prev.
    let routePlan = null;
    const modelBeforeRoute = bodyModel;
    if (isChatPath && parsedChatBody) {
        try {
            const catalog = fetchModelCatalog();
            const gwCfg = await agentGatewayConfig.getForAgent(claims.aid);
            const provider = (gwCfg?.provider ?? '').trim();
            const boundProviderIds = resolveBoundProviderIdsFromGateway(provider);
            const lastUsage = await loadLastSessionUsage(claims.sid);
            routePlan = await planRoute({
                claims,
                body: parsedChatBody,
                lastUsage,
                boundProviderIds,
                catalog,
                agentPrimaryModel: agentGatewayConfig.primaryModel(gwCfg),
                allowedModels: agentGatewayConfig.allModels(gwCfg),
                gatewayProvider: provider,
            });
            applyChosenModel(parsedChatBody, {
                chosenProvider: routePlan.chosen.chosenProvider,
                chosenModel: routePlan.chosen.chosenModel,
            });
            request.body = Buffer.from(JSON.stringify(parsedChatBody), 'utf8');
            bodyModel = parsedChatBody.model;
        } catch (err) {
            request.log.warn({ err: err?.message }, '[llm-proxy] intelligent routing skipped');
            routePlan = null;
        }
    }
    // opencode 1.18.x /model picker re-splits the candidate id on `/` (see
    // agentModelAlias.js), so we hand it a no-`/`/no-`:` alias in its config
    // and the proxy's /v1/models catalog. UniGateway, however, matches the
    // real upstream model id (its model_mapping and MODELS catalog are
    // keyed on the real openrouter name). Lookup uses the pre-route alias
    // (and can recover if routing already prefixed it); then re-apply the
    // bound provider so the gateway sees provider/real, not provider/alias.
    if (claims.aid === 'opencode' && Buffer.isBuffer(request.body)) {
        try {
            const cfg = await agentGatewayConfig.getForAgent(claims.aid);
            const reals = agentGatewayConfig.allModels(cfg);
            if (reals.length > 0) {
                const rewritten = resolveOpencodeRoutedModel(modelBeforeRoute || bodyModel, {
                    reals,
                    chosenProvider: routePlan?.chosen?.chosenProvider || '',
                });
                if (rewritten && rewritten !== bodyModel) {
                    const parsed = JSON.parse(request.body.toString('utf8'));
                    parsed.model = rewritten;
                    request.body = Buffer.from(JSON.stringify(parsed), 'utf8');
                    bodyModel = rewritten;
                }
            }
        } catch (e) {
            request.log.warn({ err: e?.message, bodyModel }, '[llm-proxy] opencode alias->real rewrite skipped');
        }
    }
    // Record the user's prompt for the chat view (dedup: agent CLIs replay the
    // full history every request, so only record when it differs from the last
    // recorded user message for this session).
    // Strip the query string so Anthropic's `?beta=true` and similar
    // decorator params don't defeat the match. `path` is what stripLlmPrefix
    // returns, which is `pathname + '?' + search` (i.e. the upstream URL
    // including the query that the agent SDK sent). The chat-completions and
    // anthropic-messages endpoints are identified by their pathname only;
    // beta / stream / version flags live in the query and don't change
    // whether the request is one we should transcribe.
    if (isChatPath && userPrompt && lastUserPromptBySession.get(claims.sid) !== userPrompt) {
        lastUserPromptBySession.set(claims.sid, userPrompt);
        void chatTranscript.append(claims.sid, { role: 'user', content: cleanUserContent(claims.aid, userPrompt) });
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
    // 0029 trajectory: full verbatim request record. Awaiting recordRequest
    // only costs a DB read on the first call per session (seq seeding); the
    // row insert itself is awaited inside the module chain (recordResponse
    // 的 UPDATE 依赖本行已存在)。
    let trajSeq = null;
    let trajDone = false;
    if (isChatPath && claims.sid) {
        try {
            const trajBody = Buffer.isBuffer(request.body)
                ? JSON.parse(request.body.toString('utf8'))
                : (request.body && typeof request.body === 'object' ? request.body : null);
            if (trajBody) {
                trajSeq = await trajectory.recordRequest({
                    sessionId: claims.sid,
                    agentId: claims.aid,
                    model: bodyModel || claims.model || null,
                    body: trajBody,
                });
            }
        } catch (_) { /* never block the proxy hot path */ }
    }
    let routeFailureRecorded = false;
    // 粘性按对话线隔离：同一 session 下并行子任务各写各的 (session, lineKey)
    const routeLineKey = routePlan?.signals?.lineKey || '';
    const recordRouteSuccess = () => {
        try {
            const chosen = routePlan?.chosen;
            if (chosen?.chosenModel && claims.sid) {
                void touchSticky(claims.sid, routeLineKey, {
                    chosenModel: chosen.chosenModel,
                    chosenProvider: chosen.chosenProvider || '',
                }).catch((err) => request.log.warn({ err: err?.message }, '[llm-proxy] touchSticky skipped'));
            }
        } catch (err) {
            request.log.warn({ err: err?.message }, '[llm-proxy] routing success bookkeeping skipped');
        }
    };
    const recordRouteFailure = () => {
        if (routeFailureRecorded) return;
        routeFailureRecorded = true;
        try {
            if (claims.sid) {
                void recordStickyFailure(claims.sid, routeLineKey)
                    .catch((err) => request.log.warn({ err: err?.message }, '[llm-proxy] recordStickyFailure skipped'));
            }
        } catch (err) {
            request.log.warn({ err: err?.message }, '[llm-proxy] routing failure bookkeeping skipped');
        }
    };
    const onResponseBody = (bodyBuffer, contentType) => {
        if (!isChatPath) return;
        // 200-status SSE streams can still carry the gateway failure as an
        // in-stream error event — surface it before anything else.
        const sseErrorText = extractSseErrorText(bodyBuffer);
        if (sseErrorText) {
            trajDone = true;
            trajectory.recordFailure({
                sessionId: claims.sid,
                seq: trajSeq,
                agentId: claims.aid,
                model: bodyModel || claims.model || null,
                error: sseErrorText,
                latencyMs: Date.now() - started,
            });
            recordLlmErrorEvent(claims.sid, 'upstream', sseErrorText);
            recordRouteFailure();
            return;
        }
        // Token 用量计量（0028）：usage 只在成功响应上出现，这里直接落库
        // （fire-and-forget）。不能放 finally——流式响应的 usage 尾块在
        // onEnd 时才到达，可能晚于 finally 执行。失败只打日志，不影响主流程。
        let usage = null;
        try {
            usage = extractUsage(bodyBuffer, contentType);
            if (usage) {
                void db.insert(schema.llmUsage).values({
                    userId: claims.uid,
                    sessionId: claims.sid || null,
                    projectId: claims.pid || null,
                    agentId: claims.aid || null,
                    model: bodyModel || claims.model || null,
                    requestedModel: modelBeforeRoute || null,
                    trigger: routePlan?.trig?.trigger ?? null,
                    seq: trajSeq,
                    difficulty: routePlan?.demand?.difficulty ?? null,
                    promptTokens: usage.promptTokens,
                    completionTokens: usage.completionTokens,
                    totalTokens: usage.totalTokens,
                    cachedTokens: usage.cachedTokens ?? null,
                    statusCode: 200,
                    latencyMs: Date.now() - started,
                    createdAt: Date.now(),
                }).catch((e) => request.log.warn(e, '[llm-proxy] failed to persist usage'));
            }
        } catch (_) { /* usage 提取失败不影响主流程 */ }
        recordRouteSuccess();
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
        // 0029 trajectory: normalized verbatim response for this call.
        trajDone = true;
        trajectory.recordResponse({
            sessionId: claims.sid,
            seq: trajSeq,
            bodyBuffer,
            contentType,
            statusCode: 200,
            latencyMs: Date.now() - started,
        });
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
    let upstreamErrorText = null;
    try {
        const agentGatewayKey = await serviceRouter.getAgentGatewayKey(claims.aid, request.log);
        forwardResult = await forwardToGateway(request, reply, {
            targetBaseUrl: gateway.baseUrl,
            gatewayKey: agentGatewayKey,
            path,
            onResponseBody,
            onErrorResponse: (bodyBuffer, contentType, errStatusCode) => {
                upstreamErrorText = extractUpstreamErrorText(bodyBuffer, contentType);
                // 0029 trajectory: upstream rejected (429/5xx) — still verbatim.
                trajDone = true;
                trajectory.recordResponse({
                    sessionId: claims.sid,
                    seq: trajSeq,
                    bodyBuffer,
                    contentType,
                    statusCode: errStatusCode,
                    latencyMs: Date.now() - started,
                    errorText: upstreamErrorText || null,
                });
                recordRouteFailure();
            },
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
        // Chat-view visibility for LLM failures (429 rate limit, 5xx, gateway
        // down): the terminal shows the CLI's error output, but without this
        // event the dialog view keeps flashing "Agent is thinking…" until the
        // 60s idle timeout. Throttled — CLI retry loops must not flood it.
        if (isChatPath && (forwardError || (forwardResult?.statusCode ?? 0) >= 400)) {
            const status = forwardError ? 502 : forwardResult.statusCode;
            const detail = forwardError
                ? String(forwardError.message || forwardError).slice(0, 200)
                : (upstreamErrorText || '');
            recordLlmErrorEvent(claims.sid, status, detail);
        }
        // 0029 trajectory: call ended without a captured response (forward
        // error, connection reset) — mark the row as failed so the trajectory
        // shows the gap instead of silently dropping the step.
        if (isChatPath && trajSeq != null && !trajDone) {
            const failError = forwardError
                ? String(forwardError.message || forwardError)
                : `upstream ${forwardResult?.statusCode ?? 'unknown'}`;
            trajectory.recordFailure({
                sessionId: claims.sid,
                seq: trajSeq,
                agentId: claims.aid,
                model: bodyModel || claims.model || null,
                error: failError,
                latencyMs: Date.now() - started,
            });
            recordRouteFailure();
        }
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
    extractUpstreamErrorText,
    extractSseErrorText,
    recordLlmErrorEvent,
};
