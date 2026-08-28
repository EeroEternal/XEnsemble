function detectProviderType(baseUrl) {
    const lower = String(baseUrl || '').toLowerCase();
    if (lower.includes('/anthropic') || lower.includes('anthropic.com')) return 'anthropic';
    return 'openai';
}

function buildTestUrl(baseUrl, providerType) {
    const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    if (providerType === 'anthropic') {
        if (trimmed.endsWith('/v1')) return `${trimmed}/messages`;
        return `${trimmed}/v1/messages`;
    }
    // OpenAI 兼容：与 UniGateway 核心 join_url 一致，base_url 直接拼接，
    // 不强制插入 /v1（智谱 GLM 等端点是 .../paas/v4/chat/completions）。
    return `${trimmed}/chat/completions`;
}

function authFailureMessage(status, detail) {
    if (status === 401 || status === 403) {
        return detail ? `Invalid API Key: ${detail}` : 'Invalid API Key.';
    }
    return detail
        ? `Provider returned ${status}: ${detail}`
        : `Provider returned ${status}.`;
}

function extractContent(body, providerType) {
    if (providerType === 'anthropic') {
        const textBlock = (body?.content || []).find((b) => b.type === 'text');
        return String(textBlock?.text || '').trim();
    }
    // openai
    const message = body?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') return '';
    return String(
        message.content
        || message.reasoning_content
        || message.reasoning
        || message.text
        || '',
    ).trim();
}

function resolveModel({ model, default_model, models }) {
    const direct = String(model || default_model || '').trim();
    if (direct) return direct;
    if (Array.isArray(models)) {
        const first = models.map((m) => String(m || '').trim()).find(Boolean);
        if (first) return first;
    }
    return '';
}

async function testProviderConnectivity({ base_url, api_key, model, default_model, models }) {
    const baseUrl = String(base_url || '').trim();
    const apiKey = String(api_key || '').trim();
    const modelName = resolveModel({ model, default_model, models });
    const started = Date.now();
    const latencyMs = () => Date.now() - started;

    if (!baseUrl) {
        const err = new Error('Base URL is required.');
        err.statusCode = 400;
        throw err;
    }
    if (!apiKey) {
        const err = new Error('API Key is required to verify provider availability.');
        err.statusCode = 400;
        throw err;
    }
    if (!modelName) {
        const err = new Error('Default model is required to verify provider.');
        err.statusCode = 400;
        throw err;
    }

    const providerType = detectProviderType(baseUrl);
    const testUrl = buildTestUrl(baseUrl, providerType);
    if (!testUrl) {
        const err = new Error('Invalid Base URL.');
        err.statusCode = 400;
        throw err;
    }

    const headers = {
        'Content-Type': 'application/json',
    };
    let body;
    if (providerType === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        body = JSON.stringify({
            model: modelName,
            max_tokens: 32,
            messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        });
    } else {
        headers.Authorization = `Bearer ${apiKey}`;
        body = JSON.stringify({
            model: modelName,
            messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
            max_tokens: 256,
            temperature: 0,
        });
    }

    let response;
    try {
        response = await fetch(testUrl, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(30000),
        });
    } catch (err) {
        const isTimeout = err.name === 'TimeoutError';
        const message = isTimeout
            ? 'Request timed out.'
            : `Failed to reach provider: ${err.message}`;
        return {
            ok: false,
            code: isTimeout ? 'timeout' : 'network_failed',
            latency_ms: latencyMs(),
            message,
        };
    }

    let responseBody;
    const raw = await response.text();
    try {
        responseBody = raw ? JSON.parse(raw) : null;
    } catch {
        responseBody = null;
    }

    if (!response.ok) {
        const detail = responseBody?.error?.message || responseBody?.message || responseBody?.error || raw?.slice(0, 200);
        const isAuthError = response.status === 401 || response.status === 403;
        return {
            ok: false,
            status: response.status,
            code: isAuthError ? 'invalid_api_key' : 'provider_status',
            detail: detail ? String(detail) : undefined,
            latency_ms: latencyMs(),
            message: authFailureMessage(response.status, detail),
        };
    }

    const content = extractContent(responseBody, providerType);
    if (!content) {
        return {
            ok: false,
            status: response.status,
            code: 'empty_response',
            latency_ms: latencyMs(),
            message: 'Provider returned an empty response. Check API Key and model.',
        };
    }

    return {
        ok: true,
        status: response.status,
        latency_ms: latencyMs(),
        model: modelName,
        message: `Available · ${latencyMs()}ms`,
    };
}

module.exports = { testProviderConnectivity, detectProviderType, buildTestUrl, resolveModel };
