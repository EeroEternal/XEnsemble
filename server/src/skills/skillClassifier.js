/**
 * Skill classifier (L3) —— 轻量 LLM 分类，过滤闲聊 / 一次性任务。
 *
 * 设计对齐 02-技术设计规格 §4：输出 {"reusable":bool,"type":"..."}。
 * reusable=true 才进入 L4；否则候选标记 rejected(low_value)。
 *
 * 注意：max_tokens 不能取规格里"≈10"的字面值——推理模型的思维链与正文共享该额度，
 * 10 个 token 会被思维链耗尽导致 content 为空，使分类静默失效。
 */

const analyzeClient = require('../llm/analyzeClient');

const CLASSIFY_MAX_TOKENS = 256;

function buildClassifyPrompt({ overview, keyDecisions = [], filesTouched = [] }) {
    return [
        'You are deciding whether a coding session is worth turning into a reusable skill.',
        'A session is reusable when it encodes a repeatable procedure, convention, or debugging recipe',
        'for a specific project/stack. It is NOT reusable when it is chitchat, a one-off task, or generic Q&A.',
        '',
        `Session overview: ${overview}`,
        keyDecisions.length ? `Key decisions: ${keyDecisions.join('; ')}` : '',
        filesTouched.length ? `Files touched: ${filesTouched.join(', ')}` : '',
        '',
        'Respond with ONLY a JSON object: {"reusable": true|false, "type": "workflow|convention|debug|database|devops|codegen|none"}',
    ].filter(Boolean).join('\n');
}

/**
 * 分类一个候选会话。
 * @param {object} param0
 * @param {string} param0.overview  conversation summary 的 overview
 * @param {string[]} [param0.keyDecisions]
 * @param {string[]} [param0.filesTouched]
 * @returns {Promise<{ reusable: boolean, type: string | null }>}
 *   LLM 未配置 / 调用失败时抛出（由 skillPipeline 统一降级处理）。
 */
async function classify({ overview, keyDecisions = [], filesTouched = [], metering }) {
    const user = buildClassifyPrompt({ overview, keyDecisions, filesTouched });
    const raw = await analyzeClient.chatJson({
        system: 'You are a precise skill classifier. Always respond with valid JSON only.',
        user,
        metering, // 0043：内部计量归属（feature='skill_classify'）
        options: { maxTokens: CLASSIFY_MAX_TOKENS, temperature: 0 },
    });
    const reusable = raw && typeof raw === 'object' ? Boolean(raw.reusable) : false;
    const type = raw && typeof raw.type === 'string' ? raw.type : null;
    return { reusable, type };
}

module.exports = {
    CLASSIFY_MAX_TOKENS,
    buildClassifyPrompt,
    classify,
};
