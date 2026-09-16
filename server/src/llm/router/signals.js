const trajectory = require('../trajectory');
const { canonicalModelId } = require('../modelPortraits');

function logicalModelFromBody(body, { tokenModel, agentPrimaryModel } = {}) {
    const fromBody = canonicalModelId(body?.model);
    if (fromBody) return fromBody;
    if (tokenModel) return String(tokenModel);
    if (agentPrimaryModel) return String(agentPrimaryModel);
    return '';
}

function inferCompacted(sessionId, messages) {
    const prev = trajectory.getPrevMessages(sessionId);
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
    let promptChars = 0;
    for (const m of messages) promptChars += contentChars(m?.content);
    const usage = lastUsage && typeof lastUsage === 'object' ? lastUsage : null;
    return {
        sessionId,
        logicalModel: logicalModelFromBody(body, { tokenModel, agentPrimaryModel }),
        msgCount,
        promptChars,
        prefixMsgCount: Math.max(0, msgCount - 1),
        compacted: inferCompacted(sessionId, messages),
        lastCachedTokens: usage == null ? null : (usage.cachedTokens ?? usage.cached_tokens ?? null),
        lastPromptTokens: usage == null ? null : (usage.promptTokens ?? usage.prompt_tokens ?? null),
    };
}

module.exports = { logicalModelFromBody, inferCompacted, collectSignals };
