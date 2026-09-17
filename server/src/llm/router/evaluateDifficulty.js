const HARD_TASK_DIFFICULTY = 0.55;
const CAPABILITY_TOP_TOLERANCE = 0.04;
const TOKENS_PER_CHAR_WIDE = 1.0;
const CHARS_PER_TOKEN_NARROW = 4.0;

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

function isWide(ch) {
    const code = ch.codePointAt(0);
    return (code >= 0x4e00 && code <= 0x9fff)
        || (code >= 0x3400 && code <= 0x4dbf)
        || (code >= 0x3040 && code <= 0x30ff)
        || (code >= 0xac00 && code <= 0xd7af)
        || (code >= 0xff00 && code <= 0xffef);
}

function estimateTokensFromText(text) {
    let wide = 0;
    let narrow = 0;
    for (const ch of String(text || '')) {
        if (isWide(ch)) wide += 1;
        else if (!/\s/.test(ch)) narrow += 1;
    }
    return Math.max(1, Math.ceil(wide * TOKENS_PER_CHAR_WIDE + narrow / CHARS_PER_TOKEN_NARROW));
}

function contentToText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((block) => {
            if (typeof block === 'string') return block;
            if (block && typeof block === 'object') {
                if (typeof block.text === 'string') return block.text;
                if (typeof block.content === 'string') return block.content;
            }
            return '';
        }).join(' ');
    }
    if (typeof content === 'object') {
        if (typeof content.text === 'string') return content.text;
        try {
            return JSON.stringify(content);
        } catch (_) {
            return String(content);
        }
    }
    return String(content);
}

function stripAgentNoise(text) {
    return String(text || '')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
        .replace(/<system>[\s\S]*?<\/system>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function userTaskText(body) {
    return stripAgentNoise(lastUserText(body));
}

function requestHasTools(body) {
    if (!body || typeof body !== 'object') return false;
    if (Array.isArray(body.tools) && body.tools.length > 0) return true;
    if (Array.isArray(body.functions) && body.functions.length > 0) return true;
    return false;
}

function lastUserText(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === 'user') return contentToText(messages[i].content);
    }
    return '';
}

const HIGH_REASONING = [
    'step by step', 'step-by-step', 'root cause', 'deadlock', 'benchmark',
    'architecture', 'architect ', 'distributed', 'consensus', 'paxos', 'raft',
    'lock-free', 'lockless', 'spmc', 'concurrency', 'memory barrier', 'spanner',
    'kernel', 'algorithm', 'proof', 'prove', 'np-complete', 'formal', 'theorem',
    'derivation', 'derive', 'parser', 'compiler', 'simd', 'quantum',
    'cryptographic', 'trade-off', 'tradeoff',
    '逐步', '推导', '证明', '根因', '死锁', '架构', '算法', '分布式', '共识',
    '无锁', '并发', '内核', '编译器', '定理',
];

const DESIGN_INTENT = [
    'implement', 'design', 'compare', 'optimize', 'refactor', 'migration', 'debugging',
    '设计', '优化', '重构', '对比',
];

const CORRECTION = [
    'wrong', 'error', 'failed', 'still failing',
    '不对', '还是报错', '理解错了', '遗漏',
];

function containsAny(haystack, needles) {
    return needles.some((n) => haystack.includes(n));
}

function heuristicDifficulty(body) {
    // Score the user's current utterance, not the Agent CLI envelope
    // (system prompt, 20+ tool schemas, replayed history). Those would
    // make every kimi-code "你好" look like a max-difficulty task.
    const text = userTaskText(body);
    const lower = text.toLowerCase();
    const tokens = estimateTokensFromText(text);
    let d = 0.15;
    d += Math.min(0.20, tokens / 16000);
    if (requestHasTools(body)) d += 0.08;
    if (
        text.includes('```')
        || text.includes('def ')
        || text.includes('fn ')
        || text.includes('class ')
        || text.includes('SELECT ')
        || text.includes('CREATE TABLE')
    ) {
        d += 0.12;
    }
    if (tokens > 12000) d += 0.10;
    if (containsAny(lower, HIGH_REASONING) || containsAny(text, HIGH_REASONING)) {
        d += 0.50;
    } else if (containsAny(lower, DESIGN_INTENT) || containsAny(text, DESIGN_INTENT)) {
        d += 0.25;
    }
    const userTurns = (Array.isArray(body?.messages) ? body.messages : [])
        .filter((m) => m?.role === 'user').length;
    if (userTurns >= 8) d += 0.10;
    if (containsAny(lower, CORRECTION) || containsAny(text, CORRECTION)) {
        d += 0.30;
    }
    return clamp01(d);
}

function requiredCapability(difficulty) {
    return 0.35 + 0.55 * clamp01(difficulty);
}

function capabilityQualified(capabilityScore, difficulty, maxPoolCapability) {
    const cap = Number(capabilityScore);
    if (!Number.isFinite(cap)) return false;
    const d = clamp01(difficulty);
    const maxCap = Number.isFinite(Number(maxPoolCapability)) ? Number(maxPoolCapability) : 1;
    if (d >= HARD_TASK_DIFFICULTY) {
        return cap >= (maxCap - CAPABILITY_TOP_TOLERANCE);
    }
    return cap >= requiredCapability(d);
}

async function evaluateDifficulty({ body, signals } = {}) {
    void signals;
    const difficulty = heuristicDifficulty(body || {});
    return {
        difficulty,
        requiredCapability: requiredCapability(difficulty),
    };
}

module.exports = {
    evaluateDifficulty,
    heuristicDifficulty,
    requiredCapability,
    capabilityQualified,
    HARD_TASK_DIFFICULTY,
    CAPABILITY_TOP_TOLERANCE,
};
