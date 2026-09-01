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

function buildExtractPrompt({ overview, keyDecisions = [], filesTouched = [], turns = [] }) {
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
        '',
        'Respond with ONLY a JSON object:',
        '{',
        '  "name": "short imperative skill name (≤100 chars)",',
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
    return { name, description, body, tags, confidence };
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
    const user = buildExtractPrompt({
        overview: summary?.overview || '',
        keyDecisions: summary?.keyDecisions || [],
        filesTouched: summary?.filesTouched || [],
        turns,
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
    };
}

module.exports = {
    EXTRACT_MAX_TOKENS,
    DEDUP_MAX_TOKENS,
    TITLE_SIMILARITY_THRESHOLD,
    buildExtractPrompt,
    buildSkillMarkdown,
    normalizeTitle,
    titleSimilarity,
    editDistance,
    findSimilarTitles,
    confirmDuplicate,
    validateExtracted,
    extract,
};
