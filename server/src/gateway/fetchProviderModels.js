function buildModelsUrl(baseUrl) {
    const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    // 与 UniGateway 核心一致的拼接，不强制插入 /v1
    return `${trimmed}/models`;
}

function extractModelIds(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const items = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
    return items
        .map((item) => {
            if (typeof item === 'string') return item.trim();
            if (item && typeof item === 'object') {
                return String(item.id || item.name || '').trim();
            }
            return '';
        })
        .filter(Boolean);
}

async function fetchProviderModels({ base_url, api_key }) {
    const baseUrl = String(base_url || '').trim();
    const apiKey = String(api_key || '').trim();
    if (!baseUrl) {
        const err = new Error('Base URL is required.');
        err.statusCode = 400;
        throw err;
    }
    if (!apiKey) {
        const err = new Error('API Key is required to fetch models.');
        err.statusCode = 400;
        throw err;
    }

    const modelsUrl = buildModelsUrl(baseUrl);
    if (!modelsUrl) {
        const err = new Error('Invalid Base URL.');
        err.statusCode = 400;
        throw err;
    }

    let response;
    try {
        response = await fetch(modelsUrl, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(15000),
        });
    } catch (err) {
        const isTimeout = err.name === 'TimeoutError';
        const message = isTimeout
            ? 'Request timed out while fetching models.'
            : `Failed to reach provider: ${err.message}`;
        const error = new Error(message);
        error.statusCode = 502;
        error.code = isTimeout ? 'timeout' : 'network_failed';
        throw error;
    }

    let body;
    const raw = await response.text();
    try {
        body = raw ? JSON.parse(raw) : null;
    } catch {
        body = null;
    }

    if (!response.ok) {
        const detail = body?.error?.message || body?.message || body?.error || raw?.slice(0, 200);
        const isAuthError = response.status === 401 || response.status === 403;
        const error = new Error(detail ? `Provider returned ${response.status}: ${detail}` : `Provider returned ${response.status}.`);
        error.statusCode = isAuthError ? 502 : (response.status >= 400 && response.status < 500 ? response.status : 502);
        error.code = isAuthError ? 'invalid_api_key' : 'provider_status';
        error.status = response.status;
        error.detail = detail ? String(detail) : undefined;
        throw error;
    }

    const models = [...new Set(extractModelIds(body))].sort();
    if (models.length === 0) {
        const err = new Error('No models returned. Enter the list manually.');
        err.statusCode = 404;
        err.code = 'no_models';
        throw err;
    }

    return { models };
}

module.exports = { fetchProviderModels, buildModelsUrl, extractModelIds };
