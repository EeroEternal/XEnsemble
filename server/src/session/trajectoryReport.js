/**
 * Session trajectory report（瘦身版 v1，无持久化）—— 实时分析一条会话的轨迹，
 * 回答两个问题：交互过程有没有问题？开发过程能不能优化？
 *
 * 构成：
 *   规则层  analyzeTrajectory —— 纯函数，零 LLM 零 DB，检测器输出 issues + metrics
 *   LLM 层  generateAdvice    —— analyzeClient 生成提示词改进建议（未配置/失败降级 rules-only）
 *
 * 无表、无钩子、无 SSE：GET /api/v1/sessions/:id/report 时现场计算。
 * 检测器与 advice 结构将来若沉淀为平台能力，可平移到独立管道。
 */

const { extractFromTrajectory } = require('./conversationExtractor');
const { countCorrections } = require('../skills/skillScorer');
const analyzeClient = require('../llm/analyzeClient');

// --- 检测器阈值（导出便于测试与调参） ---
const LOOP_MIN_REPEAT = 3;
const REWORK_MIN_TOUCHES = 3;
const CORRECTIONS_MIN_COUNT = 2;
const CORRECTIONS_MIN_DENSITY = 0.25;
const COMPACTION_MIN = 3;
const CALL_ERRORS_MIN = 2;
const EVIDENCE_EXCERPT_MAX = 160;
const ISSUES_CAP = 10;

// 建议生成参数
const ADVICE_MAX_SUGGESTIONS = 3;
const ADVICE_TURN_CHARS = 500;
const ADVICE_PROMPT_CHAR_BUDGET = 4000;
const ADVICE_MAX_TOKENS = 1500;

// 修改类工具名（file_rework 只统计真正改文件的动作）
const WRITE_TOOL_RE = /write|edit|patch|apply|create|str_replace|insert|save/i;
// 工具入参里的路径字段优先级
const PATH_KEYS = ['path', 'file_path', 'filepath', 'file', 'filename', 'notebook_path'];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function excerpt(text, max = EVIDENCE_EXCERPT_MAX) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

function toolSignature(name, argsText) {
    // args 规范化：解析后按 key 排序再序列化，等价调用签名一致；解析失败用原文
    let normalized = String(argsText || '');
    try {
        const obj = JSON.parse(normalized);
        if (obj && typeof obj === 'object') {
            normalized = JSON.stringify(obj, Object.keys(obj).sort());
        }
    } catch { /* 原文 */ }
    return `${name || 'tool'}:${normalized}`;
}

function extractToolPath(argsText) {
    try {
        const obj = JSON.parse(String(argsText || '{}'));
        if (!obj || typeof obj !== 'object') return null;
        for (const key of PATH_KEYS) {
            const v = obj[key];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
    } catch { /* ignore */ }
    return null;
}

function toolUseBlocks(row) {
    const content = row?.response && Array.isArray(row.response.content) ? row.response.content : [];
    return content.filter((b) => b && b.type === 'tool_use');
}

/** 由 turn 的 ts 近似定位其来源轨迹行 seq（证据跳转用；找不到为 null）。 */
function seqForTurn(rows, ts) {
    if (!Number.isFinite(ts)) return null;
    let best = null;
    for (const row of rows) {
        if (Number.isFinite(row?.ts) && row.ts <= ts) best = row;
    }
    return best ? best.seq : null;
}

// ---------------------------------------------------------------------------
// 规则层
// ---------------------------------------------------------------------------

/**
 * @param {Array} steps trajectory.getAllSteps 输出
 * @param {object} [opts]
 * @param {number|null} [opts.exitCode] 会话退出码
 * @param {boolean} [opts.stopped] 用户主动停止
 */
function analyzeTrajectory(steps, { exitCode = null, stopped = false } = {}) {
    const rows = Array.isArray(steps) ? steps : [];
    const { turns } = extractFromTrajectory(rows, { maxTurns: null }) || {};

    const errorRows = rows.filter((r) => r && r.status === 'error');
    const snapshotCount = rows.filter((r) => r && r.snapshot === true).length;
    let toolCallCount = 0;
    for (const turn of turns) {
        if (turn.role === 'assistant' && Array.isArray(turn.tools)) toolCallCount += turn.tools.length;
    }
    const userTurns = turns.filter((t) => t.role === 'user');
    const corrections = countCorrections(turns);

    const issues = [];
    const pushIssue = (code, severity, count, evidence) => {
        if (issues.length >= ISSUES_CAP) return;
        issues.push({ code, severity, count, evidence: evidence.slice(0, 3) });
    };

    // loop_detected：相邻同签名 tool_use 连续 ≥3（打转）
    {
        const sigs = [];
        for (const row of rows) {
            for (const block of toolUseBlocks(row)) {
                let args = '';
                try { args = JSON.stringify(block.input ?? {}); } catch { args = ''; }
                sigs.push({ seq: row.seq, sig: toolSignature(block.name, args), name: block.name });
            }
        }
        let runStart = 0;
        for (let i = 1; i <= sigs.length; i += 1) {
            const continuing = i < sigs.length && sigs[i].sig === sigs[runStart].sig;
            if (continuing) continue;
            const runLen = i - runStart;
            if (runLen >= LOOP_MIN_REPEAT) {
                pushIssue('loop_detected', 'critical', runLen, [
                    { seq: sigs[runStart].seq, excerpt: excerpt(`工具 ${sigs[runStart].name} 以相同参数连续调用 ${runLen} 次（疑似打转）`) },
                ]);
            }
            runStart = i;
        }
    }

    // file_rework：同一 path 被写类工具触碰 ≥REWORK_MIN_TOUCHES
    {
        const byPath = new Map();
        for (const row of rows) {
            for (const block of toolUseBlocks(row)) {
                if (!WRITE_TOOL_RE.test(String(block.name || ''))) continue;
                let args = '';
                try { args = JSON.stringify(block.input ?? {}); } catch { args = ''; }
                const path = extractToolPath(args);
                if (!path) continue;
                if (!byPath.has(path)) byPath.set(path, []);
                byPath.get(path).push(row.seq);
            }
        }
        const reworked = [];
        for (const [path, seqs] of byPath) {
            if (seqs.length >= REWORK_MIN_TOUCHES) reworked.push({ path, count: seqs.length, seq: seqs[0] });
        }
        reworked.sort((a, b) => b.count - a.count);
        for (const r of reworked) {
            pushIssue('file_rework', 'warn', r.count, [
                { seq: r.seq, excerpt: excerpt(`${r.path} 被修改 ${r.count} 次（可能存在返工）`) },
            ]);
        }
    }

    // high_corrections：纠正密度
    if (corrections >= CORRECTIONS_MIN_COUNT && userTurns.length > 0
        && corrections / userTurns.length >= CORRECTIONS_MIN_DENSITY) {
        pushIssue('high_corrections', 'warn', corrections, [
            { seq: userTurns.length ? seqForTurn(rows, userTurns[0].ts) : null, excerpt: excerpt(`用户纠正 ${corrections} 次 / 用户输入 ${userTurns.length} 轮——提示词可能未传达清楚意图与验收标准`) },
        ]);
    }

    // frequent_compaction
    if (snapshotCount >= COMPACTION_MIN) {
        const firstSnapshot = rows.find((r) => r.snapshot === true);
        pushIssue('frequent_compaction', 'info', snapshotCount, [
            { seq: firstSnapshot?.seq ?? null, excerpt: excerpt(`上下文被压缩 ${snapshotCount} 次，任务跨度可能超出单会话容量`) },
        ]);
    }

    // call_errors：按错误前缀聚类取 top
    if (errorRows.length >= CALL_ERRORS_MIN) {
        const byErr = new Map();
        for (const row of errorRows) {
            const key = excerpt(row.error, 80) || 'unknown';
            if (!byErr.has(key)) byErr.set(key, []);
            byErr.get(key).push(row);
        }
        let topKey = null;
        let topRows = [];
        for (const [key, list] of byErr) {
            if (list.length > topRows.length) { topKey = key; topRows = list; }
        }
        pushIssue('call_errors', 'warn', errorRows.length, [
            { seq: topRows[0]?.seq ?? null, excerpt: topKey },
        ]);
    }

    // abnormal_exit
    if (stopped || (Number.isFinite(exitCode) && exitCode !== 0)) {
        pushIssue('abnormal_exit', 'info', 1, [
            { seq: rows.length ? rows[rows.length - 1].seq : null, excerpt: excerpt(stopped ? '会话被用户手动中断' : `进程异常退出（exit code ${exitCode}）`) },
        ]);
    }

    return {
        metrics: {
            turnCount: turns.length,
            userTurnCount: userTurns.length,
            toolCallCount,
            errorCallCount: errorRows.length,
            snapshotCount,
            corrections,
        },
        issues,
        turns,
    };
}

// ---------------------------------------------------------------------------
// LLM 建议层
// ---------------------------------------------------------------------------

function buildAdvicePrompt(turns, issues) {
    const lines = [];
    for (const turn of turns) {
        if (turn.role === 'user') {
            lines.push(`[user] ${excerpt(turn.text, ADVICE_TURN_CHARS)}`);
        } else if (turn.role === 'assistant') {
            const firstLine = excerpt(turn.text, 160);
            const tools = Array.isArray(turn.tools) ? turn.tools.map((t) => t.tool).join(',') : '';
            lines.push(`[assistant] ${firstLine}${tools ? ` ｜ tools: ${tools}` : ''}`);
        }
    }
    let flow = lines.join('\n');
    if (flow.length > ADVICE_PROMPT_CHAR_BUDGET) flow = flow.slice(0, ADVICE_PROMPT_CHAR_BUDGET);

    return [
        '以下是本次会话的交互轨迹（user = 用户输入，assistant = Agent 回复与工具调用），',
        '以及规则检测发现的问题（issues，含严重级别与证据）。',
        '',
        '## 轨迹',
        flow,
        '',
        '## 检测到的过程问题',
        JSON.stringify(issues, null, 2),
    ].join('\n');
}

const ADVICE_SYSTEM = [
    'You analyze a coding-agent session trajectory and advise the USER (the human who wrote the prompts) how to prompt better next time.',
    'Respond with JSON only, no markdown fences, in the same language the user mostly used in the session:',
    '{"overall": string, "promptSuggestions": [{"title": string, "problem": string, "before": string, "after": string}], "agentNotes": [string]}',
    'Rules:',
    '- At most ' + ADVICE_MAX_SUGGESTIONS + ' promptSuggestions; each must cite concrete evidence from the trajectory or issues.',
    '- "before" must quote (possibly trimmed) the user\'s actual words; drop the suggestion if there is no real quote.',
    '- "after" is a concrete rewritten prompt a user could paste next time.',
    '- Environment/tool failures (timeouts, 429/5xx, permissions) belong in agentNotes, never in promptSuggestions.',
    '- If the session went smoothly, return an empty promptSuggestions array and a brief overall.',
].join('\n');

function validateAdvice(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const suggestions = Array.isArray(raw.promptSuggestions) ? raw.promptSuggestions : [];
    const clean = [];
    for (const s of suggestions) {
        if (!s || typeof s !== 'object') continue;
        const title = String(s.title || '').trim();
        const problem = String(s.problem || '').trim();
        const before = String(s.before || '').trim();
        const after = String(s.after || '').trim();
        if (!title || !before || !after) continue; // 无真实引用的丢弃
        clean.push({ title, problem, before, after });
        if (clean.length >= ADVICE_MAX_SUGGESTIONS) break;
    }
    const agentNotes = (Array.isArray(raw.agentNotes) ? raw.agentNotes : [])
        .map((n) => String(n || '').trim()).filter(Boolean);
    const overall = String(raw.overall || '').trim();
    if (!clean.length && !agentNotes.length && !overall) return null;
    return { overall, promptSuggestions: clean, agentNotes };
}

/**
 * 生成 LLM 建议。未配置/失败时抛错由调用方降级（或返回 null 表示无建议）。
 * @returns {object|null} { overall, promptSuggestions, agentNotes }
 */
async function generateAdvice(turns, issues) {
    if (!analyzeClient.isConfigured()) {
        const err = new Error('LLM analyze API key is not configured');
        err.code = 'llm_not_configured';
        throw err;
    }
    const raw = await analyzeClient.chatJson({
        system: ADVICE_SYSTEM,
        user: buildAdvicePrompt(turns, issues),
        options: { maxTokens: ADVICE_MAX_TOKENS, temperature: 0.3 },
    });
    return validateAdvice(raw);
}

module.exports = {
    analyzeTrajectory,
    buildAdvicePrompt,
    generateAdvice,
    validateAdvice,
    toolSignature,
    extractToolPath,
    LOOP_MIN_REPEAT,
    REWORK_MIN_TOUCHES,
    CORRECTIONS_MIN_COUNT,
    CORRECTIONS_MIN_DENSITY,
    COMPACTION_MIN,
    CALL_ERRORS_MIN,
    EVIDENCE_EXCERPT_MAX,
    ISSUES_CAP,
    ADVICE_MAX_SUGGESTIONS,
};
