/**
 * Skill scorer (L1) —— 纯规则评分，零 LLM 成本。
 *
 * 设计对齐 02-技术设计规格 §3.2 / §6.2：
 * - correctionCount 由 turns 中"用户纠正"信号检测（短输入 + 纠正语义词 + 前有 assistant 轮）
 * - filesTouched 来自 conversation summary 的 filesTouched[] 长度
 * - successExit 来自会话 exitCode === 0
 * - userMarked 由 US-3 显式标记（直跳 L4，不入池）
 * - clusterSize 由 L2 聚簇后回填（首轮为 1）
 *
 * 阈值：score ≥ 40 入池；单例候选升级需 score ≥ 60；userMarked 不入池直接 L4。
 */

const MIN_SCORE = Number(process.env.SKILL_CANDIDATE_MIN_SCORE) || 40;
const SINGLETON_MIN_SCORE = Number(process.env.SKILL_SINGLETON_MIN_SCORE) || 60;

// 纠正语义词表（§3.2）——短 user 输入中命中即视为一次"纠正"
const CORRECTION_RE = /不对|错了|不是这|重新|revert|撤销|还是不行|no,|wrong|instead|应该是/i;
const CORRECTION_MAX_CHARS = 120;
const CORRECTION_CAP = 3;
const FILES_TOUCHED_CAP = 3;
const TURN_COUNT_PENALTY_THRESHOLD = 200;

/**
 * 判定一个 user turn 是否为"用户纠正"（§3.2 全条件）：
 * 1. 文本 ≤ 120 字符（短输入）
 * 2. 命中纠正语义词表
 * 3. 该 user turn 之前存在 assistant turn（非首条）
 */
function isCorrection(turn, index, turns) {
    if (!turn || turn.role !== 'user') return false;
    const text = String(turn.text || '').trim();
    if (!text || text.length > CORRECTION_MAX_CHARS) return false;
    if (!CORRECTION_RE.test(text)) return false;
    for (let i = index - 1; i >= 0; i -= 1) {
        if (turns[i] && turns[i].role === 'assistant') return true;
    }
    return false;
}

/**
 * 统计 turns 中的用户纠正次数（封顶见 computeScore）。
 * @param {Array} turns ConversationTurn[]
 * @returns {number}
 */
function countCorrections(turns) {
    if (!Array.isArray(turns)) return 0;
    let count = 0;
    for (let i = 0; i < turns.length; i += 1) {
        if (isCorrection(turns[i], i, turns)) count += 1;
    }
    return count;
}

/**
 * L1 评分公式（§6.2 + 0029 trajectory 信号）：
 *   score = 100*userMarked + 30*min(correctionCount,3) + 15*min(filesTouched,3)
 *         + 20*successExit + 25*(clusterSize-1) - 10*(turnCount>200)
 *         + 10*trajErrorFree
 *
 * trajErrorFree：trajectory（0029）显示全部模型调用成功（无 error 步）——
 * 比单纯 exitCode===0 更强的"一次跑通"信号；trajectory 不可用时为 false，
 * 公式退化为原始 §6.2。
 *
 * @param {object} signals
 * @param {boolean} [signals.userMarked]
 * @param {number} [signals.correctionCount]
 * @param {number} [signals.filesTouched]
 * @param {boolean} [signals.successExit]
 * @param {number} [signals.turnCount]
 * @param {number} [signals.clusterSize]  L2 回填，首轮为 1
 * @param {boolean} [signals.trajErrorFree] trajectory 全部步骤 ok（0029）
 * @returns {number}
 */
function computeScore(signals = {}) {
    const userMarked = signals.userMarked ? 1 : 0;
    const corrections = Math.min(Number(signals.correctionCount) || 0, CORRECTION_CAP);
    const files = Math.min(Number(signals.filesTouched) || 0, FILES_TOUCHED_CAP);
    const success = signals.successExit ? 1 : 0;
    const cluster = Math.max(0, (Number(signals.clusterSize) || 1) - 1);
    const penalty = Number(signals.turnCount) > TURN_COUNT_PENALTY_THRESHOLD ? 1 : 0;
    const trajClean = signals.trajErrorFree ? 1 : 0;
    return (
        (100 * userMarked)
        + (30 * corrections)
        + (15 * files)
        + (20 * success)
        + (25 * cluster)
        - (10 * penalty)
        + (10 * trajClean)
    );
}

/**
 * 根据原始信号构建完整 signals 对象（供 skill_candidates.signals / skills.signals 存储）。
 * 补充 clusterSize（默认 1）与 userMarked（默认 false）。
 */
function buildSignals({ userMarked = false, correctionCount = 0, filesTouched = 0, successExit = false, turnCount = 0, clusterSize = 1, trajErrorFree = false, trajToolCalls = 0 } = {}) {
    return {
        userMarked: Boolean(userMarked),
        correctionCount: Number(correctionCount) || 0,
        filesTouched: Number(filesTouched) || 0,
        successExit: Boolean(successExit),
        turnCount: Number(turnCount) || 0,
        clusterSize: Number(clusterSize) || 1,
        trajErrorFree: Boolean(trajErrorFree),
        trajToolCalls: Number(trajToolCalls) || 0,
    };
}

module.exports = {
    MIN_SCORE,
    SINGLETON_MIN_SCORE,
    CORRECTION_RE,
    CORRECTION_MAX_CHARS,
    countCorrections,
    isCorrection,
    computeScore,
    buildSignals,
};
