/**
 * 铃铛通知 — attention 判定服务（docs/proposals/agent-attention-notification.md §6）。
 *
 * 信号源（agent 无关；禁止接 L2 各家私有 API）：
 *  - L1：LlmProxy 录制的 chat 事件流（chatTranscript.subscribeAll）——
 *    user / assistant / tool_call / tool_result + AskUserQuestion 等问题型工具；
 *  - L3'：TranscriptStore 尾部 strip-ANSI 后跑 TUI prompt 启发式
 *    （shared/terminalPromptHeuristics.mjs，与 web 屏幕扫描共用同一套规则）。
 *
 * 产出两类事件（经 notificationsService 落库）：
 *  - session_completed：assistant 发言后 QUIET_COMPLETED_MS 内无任何活动；
 *  - session_waiting：L1 问题型工具，或 L3 连续 promptStableScans 轮扫到 prompt。
 *
 * 明确不通知：transcript 'stalled'（通道异常）、input_stalled 黄条（客户端已就地展示，
 * 通道问题 ≠ 业务事件）。
 *
 * 所有钩子 best-effort：异常只打日志，绝不影响会话主链路。
 */

const path = require('path');
const { pathToFileURL } = require('url');

const config = {
    // assistant 发言后静默多久算「跑完」（太短会把多步任务中间的停顿误报为完成）
    quietCompletedMs: Number(process.env.ATTENTION_QUIET_COMPLETED_MS) || 20000,
    // 同一会话两次 completed 通知的最小间隔
    completedRepeatMs: Number(process.env.ATTENTION_COMPLETED_REPEAT_MS) || 120000,
    // L3 尾部扫描节流
    scanThrottleMs: Number(process.env.ATTENTION_SCAN_THROTTLE_MS) || 2000,
    // L3 需要连续几轮扫描都看到 prompt 才通知（稳定窗口，滤掉一闪而过的重绘）
    promptStableScans: Number(process.env.ATTENTION_PROMPT_STABLE_SCANS) || 2,
    // 参与扫描的 transcript 尾部字节数
    tailBytes: Number(process.env.ATTENTION_SCAN_TAIL_BYTES) || 4096,
    // reason 截断
    reasonMaxChars: 120,
    // 会话上下文（userId/名称快照）缓存 TTL
    contextCacheTtlMs: 5 * 60 * 1000,
};

/**
 * sessionId -> attention 状态机：
 *   state: 'working' | 'waiting_user'
 *   agentStepsSinceUser: 本次用户发言后的 agent 事件数（completed 判定用）
 *   stableHits: L3 连续扫到 prompt 的轮数
 */
const states = new Map();

const ctxCache = new Map(); // sessionId -> { ctx, ts }

// 可注入依赖（单测替换 notifier / 上下文 / 尾部行读取）。
const deps = {
    notifier: (evt) => require('./notificationsService').notify(evt),
    getSessionContext: null, // lazy: defaultGetSessionContext
    readTailLines: null, // lazy: defaultReadTailLines
};

let heuristicsPromise = null;
function loadHeuristics() {
    if (!heuristicsPromise) {
        // shared 模块是 ESM-only，CJS 侧动态 import。
        heuristicsPromise = import(pathToFileURL(path.resolve(__dirname, '../../../shared/terminalPromptHeuristics.mjs')).href);
    }
    return heuristicsPromise;
}

function ensureState(sessionId) {
    let st = states.get(sessionId);
    if (!st) {
        st = {
            state: 'working',
            source: null, // 'L1' | 'L3'
            reason: null,
            agentStepsSinceUser: 0,
            lastActivityAt: Date.now(),
            transcriptRef: null,
            scanQueued: false,
            lastScanAt: 0,
            stableHits: 0,
            lastPromptSnapshot: null,
            completedTimer: null,
            completedNotifiedAt: 0,
        };
        states.set(sessionId, st);
    }
    return st;
}

function clearCompletedTimer(st) {
    if (st.completedTimer) {
        clearTimeout(st.completedTimer);
        st.completedTimer = null;
    }
}

function truncateReason(text) {
    const s = String(text || '').trim().replace(/\s+/g, ' ');
    if (!s) return null;
    return s.length > config.reasonMaxChars ? `${s.slice(0, config.reasonMaxChars)}…` : s;
}

// ---------------------------------------------------------------------------
// L1：chat 事件流（chatTranscript.subscribeAll → observeChatEntry）
// ---------------------------------------------------------------------------

function observeChatEntry(sessionId, entry) {
    if (!sessionId || !entry || !entry.role) return;
    const st = ensureState(sessionId);
    st.lastActivityAt = Date.now();
    switch (entry.role) {
        case 'user':
            // 用户新发言：一切等待解除，completed 计数重置。
            st.agentStepsSinceUser = 0;
            clearWaiting(sessionId, st, 'user_message');
            clearCompletedTimer(st);
            break;
        case 'assistant': {
            st.agentStepsSinceUser += 1;
            clearWaiting(sessionId, st, 'assistant_message');
            scheduleCompleted(sessionId, st);
            break;
        }
        case 'tool_call': {
            // 问题型工具 → 等待用户回答（L1 结构化信号，优先于 L3）。
            loadHeuristics()
                .then(({ parseQuestionTool }) => parseQuestionTool(entry.tool, entry.content))
                .then((questions) => {
                    if (questions && questions.length > 0) {
                        const reason = questions.map((q) => q.text).filter(Boolean).join(' / ');
                        setWaiting(sessionId, st, 'L1', reason);
                        clearCompletedTimer(st);
                    } else {
                        // 普通工具调用：agent 仍在工作。
                        st.agentStepsSinceUser += 1;
                        st.lastActivityAt = Date.now();
                        clearCompletedTimer(st);
                    }
                })
                .catch(() => { /* 启发式不可用 → 忽略该信号 */ });
            break;
        }
        case 'tool_result':
            // 工具返回（含用户对问题的回答）：agent 继续干活。
            st.agentStepsSinceUser += 1;
            clearWaiting(sessionId, st, 'tool_result');
            clearCompletedTimer(st);
            break;
        case 'error':
        default:
            // error 不视为业务等待/完成信号；stalled 由 transcript 自行处理。
            break;
    }
}

// ---------------------------------------------------------------------------
// 状态迁移 + 通知发射
// ---------------------------------------------------------------------------

function setWaiting(sessionId, st, source, reason) {
    if (st.state === 'waiting_user') {
        // 已在等待：只刷新 reason/source（L1 覆盖 L3），不重复通知。
        st.source = source;
        st.reason = truncateReason(reason) || st.reason;
        return;
    }
    st.state = 'waiting_user';
    st.source = source;
    st.reason = truncateReason(reason);
    st.stableHits = 0;
    clearCompletedTimer(st);
    void emitNotify(sessionId, st, 'session_waiting');
}

function clearWaiting(sessionId, st, byWhat) {
    if (st.state !== 'waiting_user') return;
    st.state = 'working';
    st.source = null;
    st.reason = null;
    st.stableHits = 0;
    st.lastWaitingClearBy = byWhat || null; // 测试观测用
    clearCompletedTimer(st);
}

/**
 * assistant 发言后 QUIET_COMPLETED_MS 无任何活动（L1/L3/PTY 输出都会清计时器）
 * → session_completed。同会话通知有 completedRepeatMs 节流。
 */
function scheduleCompleted(sessionId, st) {
    if (st.completedTimer) return; // 已有 pending 计时器：一条就够
    st.completedTimer = setTimeout(() => {
        st.completedTimer = null;
        const quietFor = Date.now() - st.lastActivityAt;
        if (st.agentStepsSinceUser <= 0) return;
        if (st.state === 'waiting_user') return;
        if (quietFor < config.quietCompletedMs * 0.8) return; // 期间仍有活动
        if (Date.now() - st.completedNotifiedAt < config.completedRepeatMs) return;
        st.completedNotifiedAt = Date.now();
        st.agentStepsSinceUser = 0; // 下一段工作从零计数
        void emitNotify(sessionId, st, 'session_completed');
    }, config.quietCompletedMs);
}

async function emitNotify(sessionId, st, type) {
    try {
        const ctx = await resolveSessionContext(sessionId);
        if (!ctx || !ctx.userId) return; // 无法归属用户（历史孤儿会话等）→ 跳过
        await deps.notifier({
            userId: ctx.userId,
            type,
            payload: {
                sessionId,
                sessionTitle: ctx.sessionTitle || null,
                agentName: ctx.agentName || null,
                projectName: ctx.projectName || null,
                reason: type === 'session_waiting' ? st.reason : null,
            },
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[attention] notify failed:', err?.message || err);
    }
}

async function resolveSessionContext(sessionId) {
    const cached = ctxCache.get(sessionId);
    if (cached && Date.now() - cached.ts < config.contextCacheTtlMs) return cached.ctx;
    const fn = deps.getSessionContext || defaultGetSessionContext;
    const ctx = await fn(sessionId);
    if (ctx) ctxCache.set(sessionId, { ctx, ts: Date.now() });
    return ctx;
}

/** sessions ⋈ projects → { userId, agentName, sessionTitle, projectName } */
async function defaultGetSessionContext(sessionId) {
    try {
        const { db } = require('../db/index');
        const schema = require('../db/schema');
        const { eq } = require('drizzle-orm');
        const rows = await db
            .select({
                userId: schema.sessions.userId,
                agentName: schema.sessions.agentId,
                sessionTitle: schema.sessions.title,
                projectName: schema.projects.name,
            })
            .from(schema.sessions)
            .leftJoin(schema.projects, eq(schema.sessions.projectId, schema.projects.id))
            .where(eq(schema.sessions.id, sessionId))
            .limit(1);
        return rows[0] || null;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[attention] session context failed:', err?.message || err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// L3'：TranscriptStore 尾部启发式扫描（SessionManager 输出钩子驱动）
// ---------------------------------------------------------------------------

async function defaultReadTailLines(transcriptRef) {
    const transcriptStore = require('../runtime/TranscriptStore');
    const { stripAnsi } = await loadHeuristics();
    const { frames } = transcriptStore.readTail(transcriptRef, config.tailBytes);
    const text = (frames || [])
        .filter((f) => f.kind === 'out' && typeof f.data === 'string')
        .map((f) => f.data)
        .join('');
    return stripAnsi(text).split(/\r?\n/);
}

/** PTY 输出帧钩子（SessionManager onOut）：touch 活动 + 节流排队一次扫描。 */
function observeOutput(sessionId, transcriptRef) {
    if (!sessionId) return;
    const st = ensureState(sessionId);
    st.lastActivityAt = Date.now();
    clearCompletedTimer(st); // 输出 = agent 还在跑，不算安静完成
    if (transcriptRef) st.transcriptRef = transcriptRef;
    if (st.scanQueued) return;
    st.scanQueued = true;
    const delay = Math.max(0, config.scanThrottleMs - (Date.now() - st.lastScanAt));
    setTimeout(() => {
        st.scanQueued = false;
        runScan(sessionId).catch(() => {});
    }, delay);
}

async function runScan(sessionId) {
    const st = states.get(sessionId);
    if (!st || !st.transcriptRef) return;
    st.lastScanAt = Date.now();
    const read = deps.readTailLines || defaultReadTailLines;
    let lines;
    try {
        lines = await read(st.transcriptRef);
    } catch (_) {
        return; // transcript 不可达 → 本轮跳过
    }
    await evaluateLines(sessionId, lines);
}

/** 测试入口：直接喂屏幕行，跑一轮 L3 判定。 */
async function evaluateLines(sessionId, lines) {
    const st = ensureState(sessionId);
    const { detectTuiPrompt } = await loadHeuristics();
    const res = detectTuiPrompt(lines);
    if (res) {
        st.stableHits += 1;
        st.lastPromptSnapshot = (res.lines || []).join('\n');
        if (st.stableHits >= config.promptStableScans) {
            setWaiting(sessionId, st, 'L3', st.lastPromptSnapshot);
        }
    } else {
        st.stableHits = 0;
        // prompt 消失（用户已回答）→ 仅解除 L3 来源的等待；L1 等待由 tool_result/user 解除。
        if (st.state === 'waiting_user' && st.source === 'L3') {
            clearWaiting(sessionId, st, 'prompt_gone');
        }
    }
}

// ---------------------------------------------------------------------------
// 装配 + 测试钩子
// ---------------------------------------------------------------------------

/** server 启动时调用：把 L1 事件流接到 attentionService。返回解绑函数。 */
function subscribeL1(chatTranscript) {
    return chatTranscript.subscribeAll((sessionId, entry) => {
        try {
            observeChatEntry(sessionId, entry);
        } catch (_) { /* 通知绝不影响主链路 */ }
    });
}

/** 单测：覆盖 config / deps（返回恢复函数）。 */
function __configure(overrides = {}) {
    const saved = { config: { ...config }, deps: { ...deps } };
    if (overrides.config) Object.assign(config, overrides.config);
    if (overrides.deps) Object.assign(deps, overrides.deps);
    return () => {
        Object.assign(config, saved.config);
        Object.assign(deps, saved.deps);
    };
}

/** 单测：清空全部状态与计时器。 */
function __reset() {
    for (const st of states.values()) {
        clearCompletedTimer(st);
        if (st.scanTimer) clearTimeout(st.scanTimer);
    }
    states.clear();
    ctxCache.clear();
}

/** 单测观测。 */
function getState(sessionId) {
    return states.get(sessionId) || null;
}

module.exports = {
    observeChatEntry,
    observeOutput,
    subscribeL1,
    evaluateLines,
    getState,
    __configure,
    __reset,
    config,
};


