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

const EXTRACT_MAX_TOKENS = 1500;
const DEDUP_MAX_TOKENS = 10;
const TITLE_SIMILARITY_THRESHOLD = 0.85;
const MAX_TAGS = 10;
const MAX_TITLE = 100;
// 正文上限留 frontmatter 余量（skillService.content ≤ 16384）
const MAX_BODY = 16000;

// 脚本级 Skill（0020）：从会话工具调用提取可执行命令 → LLM 整理为脚本
const MAX_COMMANDS = 50;            // 喂给 LLM 的命令序列上限
const MAX_SCRIPTS = 3;              // 单技能脚本文件数上限
const MAX_SCRIPT_BYTES = 32768;     // 单脚本大小上限
const SCRIPT_PATH_RE = /^scripts\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCRIPT_EXT_RE = /\.(sh|bash|py|js|mjs|ts|ps1|sql)$/;
// 判定为"命令型工具"的 tool 名（转小写比对）
const COMMAND_TOOLS = new Set(['bash', 'shell', 'terminal', 'run_shell', 'command']);

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function renderTurns(turns) {
    return (turns || [])
        .map((t, i) => {
            const tools = t.tools && t.tools.length
                ? ` [tools: ${t.tools.map((x) => (typeof x === 'string' ? x : x.tool || 'tool')).join(', ')}]`
                : '';
            return `#${i + 1} ${t.role}${tools}: ${t.text}`;
        })
        .join('\n');
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
    const commandLines = commands.length > 0
        ? [
            '',
            'Executed commands (in order, with output snippets; decide which are reproducible and package them into scripts):',
            ...commands.map((c, i) => `  #${i + 1} $ ${c.command}${c.result ? `\n  → ${c.result}` : ''}`),
        ]
        : [];
    return [
        'You are extracting a reusable skill from a coding session.',
        'Produce a concise, actionable skill that another user could follow to reproduce this procedure.',
        '',
        `Session overview: ${overview}`,
        keyDecisions.length ? `Key decisions: ${keyDecisions.join('; ')}` : '',
        filesTouched.length ? `Files touched: ${filesTouched.join(', ')}` : '',
        '',
        'Conversation turns:',
        renderTurns(turns),
        ...commandLines,
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
    ].join('\n');
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
async function confirmDuplicate({ existingTitle, existingContent, newTitle, newContent }) {
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
async function extract({ summary, turns = [] }) {
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
        options: { maxTokens: EXTRACT_MAX_TOKENS, temperature: 0.3 },
    });
    const validated = validateExtracted(raw);
    if (!validated) {
        const err = new Error('LLM returned invalid skill JSON');
        err.code = 'skill_extraction_invalid';
        throw err;
    }
    return {
        title: validated.name,
        description: validated.description,
        content: buildSkillMarkdown({
            name: validated.name,
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
