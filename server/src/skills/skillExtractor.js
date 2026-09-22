/**
 * Skill extractor (L4) —— 完整 LLM 提炼 + 判重。
 *
 * 设计对齐 02-技术设计规格 §3.4 / §4，产物格式对齐 Anthropic Agent Skills 标准：
 * - 输入：conversation summary + turns，输出结构化字段
 *   { name, description, tags, confidence, content }，其中 content 为 markdown 正文
 * - 组合为 SKILL.md：YAML frontmatter（name/description）+ markdown body（步骤/注意事项/适用场景）
 * - max_tokens ≈ 1500；content 正文 ≤ 16KB
 * - 判重：标题归一化编辑距离相似度 ≥ 0.85 → 疑似重复 → LLM 二次判定 {"duplicate":bool}
 */

const { and, eq } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');
const analyzeClient = require('../llm/analyzeClient');
const { slugify } = require('./skillInjector');

// 推理模型（如 GLM-5）的思维链与正文共享 max_tokens，预算过小会导致正文 JSON 被截断。
// 实测长会话下 1500 必截断、4096 稳定；chatJson 另有截断放大重试兜底。
const EXTRACT_MAX_TOKENS = 4096;
// 判重只需输出极短 JSON；但 10 个 token 会被思维链耗尽导致 content 为空，
// 使判重静默失效，故给足余量。
const DEDUP_MAX_TOKENS = 256;
const TITLE_SIMILARITY_THRESHOLD = 0.85;
const MAX_TAGS = 10;
const MAX_TITLE = 100;
// 正文上限（LLM 提炼产物通常远小于此；导入侧另有 MAX_SKILL_CONTENT）
const MAX_BODY = 16000;

// 脚本级 Skill（0020）：从会话工具调用提取可执行命令 → LLM 整理为脚本
const MAX_COMMANDS = 50;            // 喂给 LLM 的命令序列上限
// 0046：与导入侧 skillService 统一（此前 3 个/32KB，会在第 4 个脚本或 32-64KB 脚本时静默丢弃）
const MAX_SCRIPTS = 10;             // 单技能脚本文件数上限
const MAX_SCRIPT_BYTES = 65536;     // 单脚本大小上限
// 0047：允许 scripts/ 下一层子目录（与导入/落库侧 skillService 白名单一致）
const SCRIPT_PATH_RE = /^scripts\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCRIPT_EXT_RE = /\.(sh|bash|py|js|mjs|ts|ps1|sql)$/;
// 判定为"命令型工具"的 tool 名（转小写比对）
const COMMAND_TOOLS = new Set(['bash', 'shell', 'terminal', 'run_shell', 'command']);

// turns 渲染预算：工具入参/结果单条截断，整体按字节预算保留最近若干 turn。
// 只渲染工具名会丢失真实操作细节（edit 改了什么、read 读到什么、grep 命中什么），
// 使提炼出的 skill 沦为"摘要的摘要"；补全后再用预算裁剪控制 prompt 规模。
const TOOL_ARG_CHARS = 1200;
const TOOL_RESULT_CHARS = 1200;
// 实测：24K 与 48K 均能成功，但 48K 单次时延约 15-20s，24K 更稳更快，
// 且足以覆盖最近的关键操作（更早的 turn 已被"从最早丢弃"策略省略）。
const PROMPT_CHAR_BUDGET = 24000;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function clip(text, max) {
    const s = String(text ?? '').replace(/\r\n/g, '\n').trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

function renderTurn(turn, index) {
    const tools = Array.isArray(turn.tools) ? turn.tools : [];
    const head = `#${index + 1} ${turn.role}: ${turn.text}`;
    if (!tools.length) return head;
    const rendered = tools.map((t) => {
        const name = typeof t === 'string' ? t : (t.tool || 'tool');
        if (typeof t === 'string') return `  [tool ${name}]`;
        const args = t.args ? `\n    args: ${clip(typeof t.args === 'string' ? t.args : JSON.stringify(t.args), TOOL_ARG_CHARS)}` : '';
        const result = t.result ? `\n    result: ${clip(t.result, TOOL_RESULT_CHARS)}` : '';
        return `  [tool ${name}]${args}${result}`;
    });
    return `${head}\n${rendered.join('\n')}`;
}

/**
 * 渲染 turns，并保证总长不超过 budget（超出则从最早 turn 开始丢弃，
 * 保留最近的上下文）。
 */
function renderTurns(turns, budget = PROMPT_CHAR_BUDGET) {
    const list = turns || [];
    const rendered = list.map((t, i) => renderTurn(t, i));
    let total = rendered.reduce((n, s) => n + s.length + 1, 0);
    let start = 0;
    while (start < rendered.length - 1 && total > budget) {
        total -= rendered[start].length + 1;
        start += 1;
    }
    const omitted = start > 0 ? `… (${start} earlier turns omitted)\n` : '';
    return omitted + rendered.slice(start).join('\n');
}

/**
 * 从 turns 提取工具执行的命令序列（0020）。
 * 只收集命令型工具（Bash/Shell 等），args 为 JSON 时取 command/cmd 字段，
 * 附上截断的 result 供 LLM 判断成功与否。
 * @param {Array} turns ConversationTurn[]（turn.tools[]: { tool, args, callId?, result? }）
 * @returns {Array<{ command: string, result: string }>}
 */
function collectCommands(turns) {
    const commands = [];
    for (const turn of turns || []) {
        for (const t of turn.tools || []) {
            const name = String(t?.tool || '').toLowerCase();
            if (!COMMAND_TOOLS.has(name)) continue;
            let command = '';
            const args = t?.args;
            if (typeof args === 'string') {
                try {
                    const parsed = JSON.parse(args);
                    command = String(parsed.command || parsed.cmd || '').trim();
                } catch {
                    command = args.trim();
                }
            } else if (args && typeof args === 'object') {
                command = String(args.command || args.cmd || '').trim();
            }
            if (!command) continue;
            const result = String(t?.result || '').slice(0, 300);
            commands.push({ command, result });
            if (commands.length >= MAX_COMMANDS) return commands;
        }
    }
    return commands;
}

function buildExtractPrompt({ overview, keyDecisions = [], filesTouched = [], turns = [], commands = [] }) {
    const header = [
        'You are extracting a reusable skill from a coding session.',
        'Produce a concise, actionable skill that another user could follow to reproduce this procedure.',
        '',
        `Session overview: ${overview}`,
        keyDecisions.length ? `Key decisions: ${keyDecisions.join('; ')}` : '',
        filesTouched.length ? `Files touched: ${filesTouched.join(', ')}` : '',
        '',
    ].filter(Boolean);

    const footer = [
        '',
        'Respond with ONLY a JSON object:',
        '{',
        '  "name": "imperative skill name (3-5 words, \u226460 chars, e.g. \'Run DB Migrations\', \'Fix Lint Errors\', \'Deploy to Staging\')",',
        '  "description": "one-sentence description of when to use this skill",',
        '  "content": "markdown body with ## When to use, ## Steps, ## Notes (no YAML frontmatter here)",',
        '  "tags": ["up to 5 short tags"],',
        '  "confidence": 0.0-1.0',
        '}',
        'Rules: write in the SAME LANGUAGE as the conversation; no markdown fences around the JSON.',
    ];

    // 固定段落（header/footer）先占额，剩余预算按 commands : turns = 1 : 2 分配，
    // 保证整条 prompt 不超 PROMPT_CHAR_BUDGET。
    const fixedLen = header.concat(footer).join('\n').length;
    const remaining = Math.max(4000, PROMPT_CHAR_BUDGET - fixedLen);
    const commandBudget = Math.floor(remaining / 3);
    const turnsBudget = remaining - commandBudget;

    const commandLines = [];
    if (commands.length > 0) {
        const lines = [
            '',
            'Executed commands (in order, with output snippets; decide which are reproducible and package them into scripts):',
        ];
        let used = 0;
        for (let i = 0; i < commands.length; i += 1) {
            const c = commands[i];
            const line = `  #${i + 1} $ ${c.command}${c.result ? `\n  → ${c.result}` : ''}`;
            if (used + line.length > commandBudget) break;
            used += line.length + 1;
            lines.push(line);
        }
        if (lines.length > 2) commandLines.push(...lines);
    }

    return header.concat(
        ['Conversation turns:', renderTurns(turns, turnsBudget)],
        commandLines,
        footer,
    ).join('\n');
}

/**
 * 组合为 SKILL.md（Anthropic Agent Skills 标准：YAML frontmatter + markdown body）。
 * @param {object} param0
 * @param {string} param0.name
 * @param {string} param0.description
 * @param {string} param0.content markdown 正文（不含 frontmatter）
 * @returns {string} 完整 SKILL.md 内容（含 frontmatter）
 */
function buildSkillMarkdown({ name, description, content }) {
    const lines = ['---'];
    lines.push(`name: ${String(name || '').replace(/[\r\n]/g, ' ').trim()}`);
    if (description) {
        lines.push(`description: ${String(description).replace(/[\r\n]/g, ' ').trim()}`);
    }
    lines.push('---');
    const body = String(content || '').trim();
    if (body) lines.push('', body);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Normalization / similarity for dedup (§3.4)
// ---------------------------------------------------------------------------

function normalizeTitle(title) {
    return String(title || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_]+/gu, '')
        .trim();
}

/**
 * 编辑距离（Levenshtein）。
 */
function editDistance(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j += 1) dp[0][j] = j;
    for (let i = 1; i <= m; i += 1) {
        for (let j = 1; j <= n; j += 1) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

/**
 * 标题归一化后编辑距离相似度 = 1 - dist / max(lenA, lenB)（§3.4 步骤 1）。
 * @returns {number} 0~1
 */
function titleSimilarity(a, b) {
    const na = normalizeTitle(a);
    const nb = normalizeTitle(b);
    if (!na || !nb) return 0;
    const maxLen = Math.max(na.length, nb.length);
    return 1 - editDistance(na, nb) / maxLen;
}

/**
 * 查找与某标题相似的已存在 skill（判重目标 = 用户已激活的 skills，§3.4）。
 * @returns {Promise<Array>} 相似度 ≥ 0.85 的 skill 行
 */
async function findSimilarTitles(userId, title, { excludeId = null } = {}) {
    const rows = await db
        .select({ id: schema.skills.id, title: schema.skills.title, content: schema.skills.content })
        .from(schema.skills)
        .where(and(eq(schema.skills.userId, userId), eq(schema.skills.status, 'active')));
    return rows
        .filter((r) => !excludeId || r.id !== excludeId)
        .filter((r) => titleSimilarity(r.title, title) >= TITLE_SIMILARITY_THRESHOLD);
}

/**
 * LLM 二次判定（§3.4 步骤 2）：已有 skill 全文 + 新提炼内容 → {"duplicate":bool}。
 * @returns {Promise<boolean>}
 */
async function confirmDuplicate({ existingTitle, existingContent, newTitle, newContent, metering }) {
    const user = [
        `Existing skill title: ${existingTitle}`,
        `Existing skill content:\n${String(existingContent || '').slice(0, 4000)}`,
        '',
        `New skill title: ${newTitle}`,
        `New skill content:\n${String(newContent || '').slice(0, 4000)}`,
        '',
        'Is the new skill a duplicate of the existing one? Respond ONLY {"duplicate": true|false}.',
    ].join('\n');
    const raw = await analyzeClient.chatJson({
        system: 'You are a precise dedup judge. Always respond with valid JSON only.',
        user,
        metering, // 0043：内部计量归属（feature='skill_extract'）
        options: { maxTokens: DEDUP_MAX_TOKENS, temperature: 0 },
    });
    return Boolean(raw && raw.duplicate === true);
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

function validateScripts(scripts) {
    if (!Array.isArray(scripts)) return [];
    const out = [];
    for (const s of scripts) {
        if (!s || typeof s !== 'object') continue;
        const pathVal = String(s.path || '').trim();
        const contentVal = String(s.content || '');
        if (!SCRIPT_PATH_RE.test(pathVal)) continue;
        if (!SCRIPT_EXT_RE.test(pathVal)) continue;
        if (!contentVal || Buffer.byteLength(contentVal, 'utf8') > MAX_SCRIPT_BYTES) continue;
        out.push({ path: pathVal, content: contentVal });
        if (out.length >= MAX_SCRIPTS) break;
    }
    return out;
}

function validateExtracted(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = String(raw.name || '').trim();
    const description = String(raw.description || '').trim();
    const body = String(raw.content || '').trim();
    if (!name || name.length > MAX_TITLE) return null;
    if (!body || body.length > MAX_BODY) return null;
    const tags = Array.isArray(raw.tags)
        ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, MAX_TAGS)
        : [];
    const confidence = Number.isFinite(raw.confidence)
        ? Math.min(1, Math.max(0, raw.confidence))
        : null;
    const scripts = validateScripts(raw.scripts);
    return { name, description, body, tags, confidence, scripts };
}

/**
 * 从会话摘要 + turns 提炼 skill（§3.4/§4），产物为 SKILL.md 格式。
 * @param {object} param0
 * @param {object} param0.summary conversation summary（overview/keyDecisions/filesTouched）
 * @param {Array} [param0.turns] ConversationTurn[]（作为提炼上下文）
 * @returns {Promise<{ title: string, content: string, tags: string[], confidence: number|null }>}
 *   title = skill name；content = 完整 SKILL.md（YAML frontmatter + markdown body）。
 *   LLM 未配置/失败/非法 JSON 时抛出（由调用方处理）。
 */
async function extract({ summary, turns = [], metering }) {
    // 0020：先收集会话中的命令序列，作为脚本提炼的上下文
    const commands = collectCommands(turns);
    const user = buildExtractPrompt({
        overview: summary?.overview || '',
        keyDecisions: summary?.keyDecisions || [],
        filesTouched: summary?.filesTouched || [],
        turns,
        commands,
    });
    const raw = await analyzeClient.chatJson({
        system: 'You are a precise skill extractor. Always respond with valid JSON only.',
        user,
        metering, // 0043：内部计量归属（feature='skill_extract'）
        options: { maxTokens: EXTRACT_MAX_TOKENS, temperature: 0.3 },
    });
    const validated = validateExtracted(raw);
    if (!validated) {
        const err = new Error('LLM returned invalid skill JSON');
        err.code = 'skill_extraction_invalid';
        throw err;
    }
    return {
        title: slugify(validated.name),
        description: validated.description,
        content: buildSkillMarkdown({
            name: slugify(validated.name),
            description: validated.description,
            content: validated.body,
        }),
        tags: validated.tags,
        confidence: validated.confidence,
        scripts: validated.scripts,
    };
}

module.exports = {
    EXTRACT_MAX_TOKENS,
    DEDUP_MAX_TOKENS,
    TITLE_SIMILARITY_THRESHOLD,
    MAX_COMMANDS,
    MAX_SCRIPTS,
    MAX_SCRIPT_BYTES,
    SCRIPT_PATH_RE,
    SCRIPT_EXT_RE,
    buildExtractPrompt,
    buildSkillMarkdown,
    collectCommands,
    validateScripts,
    normalizeTitle,
    titleSimilarity,
    editDistance,
    findSimilarTitles,
    confirmDuplicate,
    validateExtracted,
    extract,
};
