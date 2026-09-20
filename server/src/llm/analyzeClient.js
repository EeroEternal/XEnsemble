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
 *   LLM_ANALYZE_DISABLE_THINKING — '1' 时对推理模型显式关闭思维链（thinking:
 *                           disabled），避免思维链占用 max_tokens 导致正文截断
 */

const DEFAULT_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 60000;
// 截断自动重试的 token 上限（见 chatJson）
const MAX_RETRY_TOKENS = 8192;

class LlmNotConfiguredError extends Error {
    constructor() {
        super('LLM analyze API key is not configured');
        this.name = 'LlmNotConfiguredError';
        this.code = 'llm_not_configured';
    }
}

class LlmRequestError extends Error {
    constructor(message, { status = 0, body = '', code = 'llm_request_failed' } = {}) {
        super(message);
        this.name = 'LlmRequestError';
        this.code = code;
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
 * 组装请求体。可选字段（response_format / thinking）由 options 或 env 决定，
 * 单独记录以便上游不支持（400）时剥离重试。
 */
function buildRequestBody({ system, user, options = {} }) {
    const { model } = getLlmConfig();
    const body = {
        model,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.3,
    };
    const optional = [];
    if (options.responseFormat === 'json') {
        body.response_format = { type: 'json_object' };
        optional.push('response_format');
    }
    // 推理模型的思维链与正文共享 max_tokens；显式关闭可保证 JSON 正文不被截断。
    // 仅对支持的厂商生效（不支持的厂商走 400 剥离重试）。
    if (options.disableThinking ?? process.env.LLM_ANALYZE_DISABLE_THINKING === '1') {
        body.thinking = { type: 'disabled' };
        optional.push('thinking');
    }
    return { body, optional };
}

/** 单次 HTTP 调用，返回解析后的响应 JSON。 */
async function requestOnce({ apiUrl, apiKey, timeoutMs, body }) {
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

    return res.json();
}

/**
 * Call the chat-completions API and return the raw assistant message
 * content (string). Throws LlmNotConfiguredError / LlmRequestError.
 *
 * options.strict=true 时，若输出被 max_tokens 截断（finish_reason='length'）则抛
 * code='llm_truncated' 的 LlmRequestError —— 让上层能区分「截断」与「模型真的返回
 * 了非法内容」，而不是在 JSON.parse 处报出误导性的 "invalid JSON"。默认不抛，保持
 * 纯文本调用方（如标题生成）的既有行为。
 *
 * @param {object} params
 * @param {string} params.system   system prompt
 * @param {string} params.user     user message content
 * @param {object} [params.options] { maxTokens, temperature, responseFormat, disableThinking, strict }
 */
async function chat({ system, user, options = {} }) {
    const { apiKey, apiUrl, timeoutMs } = getLlmConfig();
    if (!apiKey) throw new LlmNotConfiguredError();

    const { body, optional } = buildRequestBody({ system, user, options });
    let data;
    try {
        data = await requestOnce({ apiUrl, apiKey, timeoutMs, body });
    } catch (err) {
        // 上游不认可选字段（400）→ 剥离后重试一次，保证对任意厂商可用。
        if (err instanceof LlmRequestError && err.status === 400 && optional.length > 0) {
            const fallback = { ...body };
            for (const key of optional) delete fallback[key];
            data = await requestOnce({ apiUrl, apiKey, timeoutMs, body: fallback });
        } else {
            throw err;
        }
    }

    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (options.strict && choice?.finish_reason === 'length') {
        const err = new LlmRequestError(
            `LLM output truncated at max_tokens=${body.max_tokens}`,
            { code: 'llm_truncated' },
        );
        err.maxTokens = body.max_tokens;
        err.content = typeof content === 'string' ? content : '';
        throw err;
    }
    if (typeof content !== 'string') {
        throw new LlmRequestError('LLM response missing message content');
    }
    return content;
}

/** 容忍 ```json 围栏的 JSON 解析。 */
function parseJsonContent(content) {
    const stripped = content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();
    return JSON.parse(stripped);
}

/**
 * chat() + JSON.parse with fenced-code-block tolerance.
 *
 * 默认带 response_format=json_object，从结构上保证输出为合法 JSON。
 * 默认关闭思维链（disableThinking=true）：结构化提取不需要长思维链，而思维链会
 * 与正文争抢 max_tokens（导致截断）并显著拉长时延（实测 30s → 5s）。可用
 * options.disableThinking=false 显式开启。
 * 若仍因 max_tokens 截断 → 放大预算重试一次。
 * Throws LlmRequestError when the content is not valid JSON.
 */
async function chatJson(params) {
    const options = { responseFormat: 'json', strict: true, disableThinking: true, ...(params.options || {}) };
    try {
        return parseJsonContent(await chat({ ...params, options }));
    } catch (err) {
        if (err?.code === 'llm_truncated') {
            const bumped = Math.min((options.maxTokens ?? 1024) * 4, MAX_RETRY_TOKENS);
            if (bumped > (options.maxTokens ?? 1024)) {
                try {
                    return parseJsonContent(
                        await chat({ ...params, options: { ...options, maxTokens: bumped } }),
                    );
                } catch (_) {
                    // 重试仍失败 → 抛出原始截断错误（信息更准确）
                    throw err;
                }
            }
        }
        if (err instanceof SyntaxError) {
            throw new LlmRequestError(`LLM returned invalid JSON: ${err.message}`);
        }
        throw err;
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
