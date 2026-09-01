/**
 * Conversation auto-summarizer (A+B：退出时总结一次).
 *
 * 轮次（turns）实时来自 LLM 代理的结构化聊天记录（chatTranscript），不调用
 * 大模型。仅在会话退出时调用一次 summarizeSession 生成概览 / 关键决策 /
 * 涉及文件。
 *
 * Safeguards:
 *   - per-session in-flight guard + pending re-run (no overlapping LLM calls).
 */

const sessionManager = require('./SessionManager');

// sessionId -> { running, pending }
const state = new Map();

function getSummaryService() {
    return require('./conversationSummaryService');
}

function cleanup(sessionId) {
    state.delete(sessionId);
}

async function runOnce(sessionId) {
    const entry = state.get(sessionId);
    if (!entry) return;
    if (entry.running) {
        entry.pending = true;
        return;
    }

    entry.running = true;
    try {
        await getSummaryService().summarizeSession(sessionId);
    } catch (_) {
        // exit 阶段的总结失败不影响会话生命周期；手动 Refresh 仍会暴露错误。
    } finally {
        entry.running = false;
        if (entry.pending) {
            entry.pending = false;
            setImmediate(() => runOnce(sessionId));
        }
    }
}

function attach(sessionId) {
    if (state.has(sessionId)) return;
    state.set(sessionId, { running: false, pending: false });

    sessionManager.onExit(sessionId, () => runOnce(sessionId));
}

function start() {
    sessionManager.onSessionCreated((session) => {
        if (session?.id) attach(session.id);
    });
    for (const session of sessionManager.listSessions()) {
        if (session?.id) attach(session.id);
    }
}

function stop() {
    for (const id of [...state.keys()]) cleanup(id);
}

module.exports = { start, stop };
