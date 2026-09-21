/**
 * Shared LLM client for server-side internal AI features: session title
 * generation, conversation summarization, trajectory advice, skill
 * extraction/classification, deploy plan/verify agents, quick-preview
 * heal/mock-factory and git commit/PR description generation.
 *
 * 0043（内置 AI 用量归属）：每个调用必须携带 metering —— { feature, userId,
 * sessionId?, projectId? }，token 消耗以 source='internal' 落 llm_usage。
 * 归属缺失直接抛 LlmAttributionError（fail fast），杜绝再出现零归属调用。
 *
 * Config (env):
 *   LLM_ANALYZE_API_KEY   — required; when unset the client reports
 *                           "not configured" and callers degrade gracefully
 *   LLM_ANALYZE_API_URL   — default deepseek chat completions（base 或完整 URL 均可）
 *   LLM_ANALYZE_MODEL     — default deepseek-chat
 *   LLM_ANALYZE_TIMEOUT_MS — default 60000（options.timeoutMs 可按调用覆盖）
 *   LLM_ANALYZE_DISABLE_THINKING — '1' 时对推理模型显式关闭思维链（thinking:
 *                           disabled），避免思维链占用 max_tokens 导致正文截断
 *   LLM_NO_THINKING_MODELS — 逗号分隔名单：不能收 anthropic 风格 thinking 参数的模型（400）
 */

const { normalizeUsage } = require('./usageExtractor');

const DEFAULT_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 60000;
// 截断自动重试的 token 上限（见 chatJson）
const MAX_RETRY_TOKENS = 8192;

// llm_usage.source 取值：analyzeClient 写入的所有行都是内置功能流量。
// agent 会话流量由 proxy 写入 source='session'；存量行 NULL，查询侧 COALESCE。
const INTERNAL_USAGE_SOURCE = 'internal';

// 不支持 thinking 字段的模型（收到即 400）：deepseek 系不认识 anthropic 风格的
// thinking 参数；glm-4 系（-9b/-32b）会 400。原先散落在 analyzeDeploy /
// analyzeVerify / quickPreview 的三份同名名单统一收口于此。调用方用它决定
// 是否传 options.disableThinking；即便误传，请求层也会走 400 剥离重试自愈。
const noThinkingModels = new Set([
    'deepseek-chat',
    'deepseek-reasoner',
    ...(String(process.env.LLM_NO_THINKING_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean)),
]);

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

class LlmAttributionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LlmAttributionError';
        this.code = 'llm_attribution_missing';
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

// OpenAI 兼容端点归一化：配置可能给 base URL（如 …/api/v1）或完整 chat/completions
// URL；统一归一化为完整端点，否则直接 POST 到 base URL 会 404。
// （原 analyzeDeploy/quickPreview 各自持有的同名实现收口于此。）
function chatCompletionsUrl(url) {
    const u = String(url || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions\/?$/i.test(u)) return u;
    return `${u}/chat/completions`;
}

function assertMetering(metering) {
    if (!metering || typeof metering !== 'object') {
        throw new LlmAttributionError('metering is required: { feature, userId, sessionId?, projectId? }');
    }
    if (!metering.feature) {
        throw new LlmAttributionError('metering.feature is required');
    }
    if (!metering.userId) {
        throw new LlmAttributionError(`metering.userId is required (feature=${metering.feature})`);
    }
}

// ---- usage 落库（fire-and-forget，与 proxy 的计量模式一致）----

// 测试注入点：__setUsageSink(fn) 用 spy 替换真实 DB 写入，断言落库行内容。
let usageSink = null;
function __setUsageSink(fn) {
    usageSink = typeof fn === 'function' ? fn : null;
}

async function insertInternalUsageRow(row) {
    const { db } = require('../db');
    const { llmUsage } = require('../db/schema');
    await db.insert(llmUsage).values(row);
}

/**
 * 成功响应的 usage 落 llm_usage（source='internal'）。解析不到 usage 不落库
 * （宁可漏计不可错计，与 proxy 计量一致）；插入失败只打日志，绝不影响调用方。
 */
function recordInternalUsage(metering, data, { model, statusCode, latencyMs }) {
    const usage = normalizeUsage(data && data.usage);
    if (!usage) return;
    const row = {
        userId: metering.userId,
        sessionId: metering.sessionId || null,
        projectId: metering.projectId || null,
        agentId: null,
        model: model || null,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cachedTokens: usage.cachedTokens,
        statusCode: statusCode ?? 200,
        latencyMs: latencyMs ?? null,
        createdAt: Date.now(),
        requestedModel: null,
        trigger: null,
        seq: null,
        difficulty: null,
        source: INTERNAL_USAGE_SOURCE,
        feature: metering.feature,
    };
    const write = usageSink
        ? Promise.resolve().then(() => usageSink(row))
        : insertInternalUsageRow(row);
    write.catch((err) => {
        console.error(`[analyzeClient] internal usage insert failed: ${err && err.message ? String(err.message).slice(0, 160) : err}`);
    });
}

/**
 * 组装请求体。可选字段（response_format / thinking）由 options 或 env 决定，
 * 单独记录以便上游不支持（400）时剥离重试。
 */
function buildRequestBody({ messages, model, options = {} }) {
    const body = {
        model,
        messages,
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
    if (options.reasoningEffort) {
        body.reasoning_effort = options.reasoningEffort;
    }
    return { body, optional };
}

/** 单次 HTTP 调用，返回解析后的响应 JSON。 */
async function requestOnce({ apiUrl, apiKey, timeoutMs, body, options = {} }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 外部中止信号（如部署取消）：链到内部 controller，超时与外部中止都能取消在途请求。
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let res;
    try {
        res = await fetch(chatCompletionsUrl(apiUrl), {
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
            throw new LlmRequestError(options.signal && options.signal.aborted
                ? 'LLM request aborted'
                : `LLM request timed out after ${timeoutMs}ms`);
        }
        throw new LlmRequestError(`LLM request failed: ${err.message}`);
    } finally {
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LlmRequestError(`LLM API error ${res.status}: ${text.slice(0, 500)}`, {
            status: res.status,
            body: text,
        });
    }

    let data;
    try {
        data = await res.json();
    } catch (err) {
        throw new LlmRequestError(`LLM response parse failed: ${err.message}`, { status: res.status });
    }
    return data;
}

/**
 * Low-level entry: POST an arbitrary messages array and return the raw
 * response JSON。deploy/verify 的 ReAct 循环与 quick-preview 用它保留各自的
 * 重试循环与响应观测。成功响应会记录 usage（fire-and-forget）。
 * 上游不认可可选字段（response_format / thinking，400）时剥离后重试一次，
 * 保证对任意厂商可用。
 * metering 缺失抛 LlmAttributionError；未配置/请求失败抛
 * LlmNotConfiguredError / LlmRequestError。
 *
 * @param {object} params
 * @param {Array<{role:string, content:string}>} params.messages
 * @param {object} params.metering  { feature, userId, sessionId?, projectId? }
 * @param {object} [params.options] { model, maxTokens, temperature, responseFormat,
 *                                   timeoutMs, reasoningEffort, disableThinking, signal }
 * @returns {Promise<object>} 完整响应 JSON（含 choices / usage）
 */
async function chatRaw({ messages, options = {}, metering }) {
    assertMetering(metering);
    const { apiKey, apiUrl, model: defaultModel, timeoutMs: defaultTimeoutMs } = getLlmConfig();
    if (!apiKey) throw new LlmNotConfiguredError();

    const model = options.model || defaultModel;
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const { body, optional } = buildRequestBody({ messages, model, options });

    const startedAt = Date.now();
    let data;
    try {
        data = await requestOnce({ apiUrl, apiKey, timeoutMs, body, options });
    } catch (err) {
        // 上游不认可可选字段（400）→ 剥离后重试一次，保证对任意厂商可用。
        if (err instanceof LlmRequestError && err.status === 400 && optional.length > 0) {
            const fallback = { ...body };
            for (const key of optional) delete fallback[key];
            data = await requestOnce({ apiUrl, apiKey, timeoutMs, body: fallback, options });
        } else {
            throw err;
        }
    }

    recordInternalUsage(metering, data, { model, statusCode: 200, latencyMs: Date.now() - startedAt });
    return data;
}

/**
 * Call the chat-completions API and return the raw assistant message
 * content (string). Throws LlmNotConfiguredError / LlmRequestError /
 * LlmAttributionError.
 *
 * options.strict=true 时，若输出被 max_tokens 截断（finish_reason='length'）则抛
 * code='llm_truncated' 的 LlmRequestError —— 让上层能区分「截断」与「模型真的返回
 * 了非法内容」，而不是在 JSON.parse 处报出误导性的 "invalid JSON"。默认不抛，保持
 * 纯文本调用方（如标题生成）的既有行为。
 *
 * @param {object} params
 * @param {string} params.system   system prompt
 * @param {string} params.user     user message content
 * @param {object} params.metering { feature, userId, sessionId?, projectId? }
 * @param {object} [params.options] { model, maxTokens, temperature, responseFormat,
 *                                   timeoutMs, reasoningEffort, disableThinking, strict }
 */
async function chat({ system, user, options = {}, metering }) {
    const data = await chatRaw({
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        options,
        metering,
    });
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (options.strict && choice?.finish_reason === 'length') {
        const maxTokens = options.maxTokens ?? 1024;
        const err = new LlmRequestError(
            `LLM output truncated at max_tokens=${maxTokens}`,
            { code: 'llm_truncated' },
        );
        err.maxTokens = maxTokens;
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
    chatRaw,
    chatCompletionsUrl,
    getLlmConfig,
    isConfigured,
    noThinkingModels,
    INTERNAL_USAGE_SOURCE,
    recordInternalUsage,
    LlmNotConfiguredError,
    LlmRequestError,
    LlmAttributionError,
    __setUsageSink,
};
