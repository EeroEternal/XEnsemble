/**
 * LLM Token 用量提取器（usageExtractor）
 *
 * 从 LLM Proxy 捕获的上游响应体中提取 usage（token 消耗），支持三种形态：
 *  1. OpenAI 非流式 JSON：body.usage.{prompt_tokens, completion_tokens, total_tokens}
 *  2. OpenAI SSE 流式：最后一个 data: chunk 携带 usage（上游设置 stream_options.include_usage 时）
 *  3. Anthropic SSE 流式：message_start 事件携带 usage.input_tokens，
 *                         message_delta 事件携带 usage.output_tokens
 *
 * 设计约束：
 *  - 纯函数、零 IO、可单测
 *  - 解析失败 / 无 usage 字段一律返回 null（调用方不落库，宁可漏计不可错计）
 *  - SSE 逐行扫描时丢弃不完整残行（与 proxy 内现有 SSE 解析器行为一致）
 */

/**
 * 规范化 usage 字段为 { promptTokens, completionTokens, totalTokens }。
 * total 缺失时用 prompt + completion 兜底；两者也缺失时返回 null。
 */
function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const prompt = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
    const completion = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
    if (prompt <= 0 && completion <= 0) return null;
    const totalRaw = Number(raw.total_tokens ?? 0) || 0;
    const total = totalRaw > 0 ? totalRaw : prompt + completion;
    return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function isEventStream(contentType) {
    return String(contentType || '').toLowerCase().includes('text/event-stream');
}

/**
 * 从 SSE 响应体提取 usage。
 * 返回 { promptTokens, completionTokens, totalTokens } 或 null。
 */
function extractUsageFromSse(bodyBuffer) {
    let text;
    try {
        text = bodyBuffer.toString('utf8');
    } catch {
        return null;
    }
    const lines = text.split(/\r?\n/);
    // OpenAI 形态：任一 data chunk 的顶层 usage（通常是最后一个 chunk）
    // Anthropic 形态：message_start.input_tokens + message_delta.output_tokens 累加
    let openaiUsage = null;
    let anthropicPrompt = 0;
    let anthropicCompletion = 0;
    let sawAnthropic = false;
    let sawOpenAI = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let obj;
        try {
            obj = JSON.parse(data);
        } catch {
            continue; // 截断残行 / 心跳
        }
        if (!obj || typeof obj !== 'object') continue;
        if (obj.type === 'message_start' && obj.usage) {
            sawAnthropic = true;
            anthropicPrompt = Number(obj.usage.input_tokens ?? 0) || 0;
            if (obj.usage.output_tokens) {
                anthropicCompletion = Math.max(anthropicCompletion, Number(obj.usage.output_tokens) || 0);
            }
            continue;
        }
        if (obj.type === 'message_delta' && obj.usage) {
            sawAnthropic = true;
            anthropicCompletion = Math.max(anthropicCompletion, Number(obj.usage.output_tokens ?? 0) || 0);
            continue;
        }
        if (obj.usage && typeof obj.usage === 'object') {
            sawOpenAI = true;
            openaiUsage = obj.usage; // 保留最后一个（最终 usage 事件）
        }
    }
    if (sawAnthropic) {
        const raw = { prompt_tokens: anthropicPrompt, completion_tokens: anthropicCompletion };
        return normalizeUsage(raw);
    }
    if (sawOpenAI) return normalizeUsage(openaiUsage);
    return null;
}

/**
 * 从完整响应体提取 usage（主入口）。
 * @param {Buffer} bodyBuffer 上游响应体（proxy 已捕获，≤2MB）
 * @param {string} contentType 响应 Content-Type
 * @returns {{promptTokens:number, completionTokens:number, totalTokens:number}|null}
 */
function extractUsage(bodyBuffer, contentType) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return null;
    if (isEventStream(contentType)) return extractUsageFromSse(bodyBuffer);
    try {
        const obj = JSON.parse(bodyBuffer.toString('utf8'));
        return normalizeUsage(obj?.usage);
    } catch {
        return null;
    }
}

module.exports = { extractUsage, extractUsageFromSse, normalizeUsage };
