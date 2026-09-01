/**
 * Shared LLM client for analysis tasks (session title generation, conversation
 * summarization). Extracted from titleService.js (T1.2).
 *
 * Config (env):
 *   LLM_ANALYZE_API_KEY   — required; when unset the client reports
 *                           "not configured" and callers degrade gracefully
 *   LLM_ANALYZE_API_URL   — default deepseek chat completions
 *   LLM_ANALYZE_MODEL     — default deepseek-chat
 *   LLM_ANALYZE_TIMEOUT_MS — default 60000
 */

const DEFAULT_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 60000;

class LlmNotConfiguredError extends Error {
    constructor() {
        super('LLM analyze API key is not configured');
        this.name = 'LlmNotConfiguredError';
        this.code = 'llm_not_configured';
    }
}

class LlmRequestError extends Error {
    constructor(message, { status = 0, body = '' } = {}) {
        super(message);
        this.name = 'LlmRequestError';
        this.code = 'llm_request_failed';
        this.status = status;
        this.body = body;
    }
}

function getLlmConfig() {
    return {
        apiKey: process.env.LLM_ANALYZE_API_KEY,
        apiUrl: process.env.LLM_ANALYZE_API_URL || DEFAULT_API_URL,
        model: process.env.LLM_ANALYZE_MODEL || DEFAULT_MODEL,
        timeoutMs: Number(process.env.LLM_ANALYZE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    };
}

function isConfigured() {
    return Boolean(process.env.LLM_ANALYZE_API_KEY);
}

/**
 * Call the chat-completions API and return the raw assistant message
 * content (string). Throws LlmNotConfiguredError / LlmRequestError.
 *
 * @param {object} params
 * @param {string} params.system   system prompt
 * @param {string} params.user     user message content
 * @param {object} [params.options] { maxTokens, temperature, responseFormat }
 */
async function chat({ system, user, options = {} }) {
    const { apiKey, apiUrl, model, timeoutMs } = getLlmConfig();
    if (!apiKey) throw new LlmNotConfiguredError();

    const body = {
        model,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.3,
    };
    if (options.responseFormat === 'json') {
        body.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new LlmRequestError(`LLM request timed out after ${timeoutMs}ms`);
        }
        throw new LlmRequestError(`LLM request failed: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LlmRequestError(`LLM API error ${res.status}: ${text.slice(0, 500)}`, {
            status: res.status,
            body: text,
        });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
        throw new LlmRequestError('LLM response missing message content');
    }
    return content;
}

/**
 * chat() + JSON.parse with fenced-code-block tolerance.
 * Throws LlmRequestError when the content is not valid JSON.
 */
async function chatJson(params) {
    const content = await chat(params);
    const stripped = content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();
    try {
        return JSON.parse(stripped);
    } catch (err) {
        throw new LlmRequestError(`LLM returned invalid JSON: ${err.message}`);
    }
}

module.exports = {
    chat,
    chatJson,
    isConfigured,
    getLlmConfig,
    LlmNotConfiguredError,
    LlmRequestError,
};
