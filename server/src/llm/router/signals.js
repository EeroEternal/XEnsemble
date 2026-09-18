const trajectory = require('../trajectory');
const { canonicalModelId } = require('../modelPortraits');
const { lineKeyOf } = require('../lineKey');

function logicalModelFromBody(body, { tokenModel, agentPrimaryModel } = {}) {
    const fromBody = canonicalModelId(body?.model);
    if (fromBody) return fromBody;
    if (tokenModel) return String(tokenModel);
    if (agentPrimaryModel) return String(agentPrimaryModel);
    return '';
}

/**
 * 同线压缩判定：只与该对话线上一次的 messages 比对。
 * 一个 session 下可能有多条并行对话线（Agent 派生的并行子任务），若拿整个
 * session 的上一轮来比，跨线交错会被误判为压缩。
 * - 该线无历史 → 新线，不是压缩（走 first_turn）
 * - 该线有历史且非「更长且前缀一致」→ 压缩
 */
function inferCompacted(sessionId, messages, lineKey) {
    const key = lineKey === undefined ? lineKeyOf(messages) : lineKey;
    const prev = trajectory.getPrevMessagesForLine(sessionId, key);
    if (!prev) return false;
    const msgs = Array.isArray(messages) ? messages : [];
    return !(msgs.length > prev.length && trajectory.samePrefix(msgs, prev));
}

function contentChars(content) {
    if (content == null) return 0;
    if (typeof content === 'string') return content.length;
    try {
        return JSON.stringify(content).length;
    } catch (_) {
        return String(content).length;
    }
}

function collectSignals({ sessionId, body, tokenModel, agentPrimaryModel, lastUsage } = {}) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const msgCount = messages.length;
    const lineKey = lineKeyOf(messages);
    let promptChars = 0;
    for (const m of messages) promptChars += contentChars(m?.content);
    const usage = lastUsage && typeof lastUsage === 'object' ? lastUsage : null;
    return {
        sessionId,
        lineKey,
        logicalModel: logicalModelFromBody(body, { tokenModel, agentPrimaryModel }),
        msgCount,
        promptChars,
        prefixMsgCount: Math.max(0, msgCount - 1),
        compacted: inferCompacted(sessionId, messages, lineKey),
        lastCachedTokens: usage == null ? null : (usage.cachedTokens ?? usage.cached_tokens ?? null),
        lastPromptTokens: usage == null ? null : (usage.promptTokens ?? usage.prompt_tokens ?? null),
    };
}

module.exports = { logicalModelFromBody, inferCompacted, collectSignals, lineKeyOf };
