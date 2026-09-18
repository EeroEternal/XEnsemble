/**
 * 对话线标识（lineKey）。
 *
 * 一个 session 下可能存在多条并行对话线：Agent 派生并行子任务时，子任务请求与
 * 主任务共用 sessionId，但各自维护独立的 messages 历史。若只用 sessionId 作为
 * 粘性 / 前序比对的键，多条线会互相覆盖，导致压缩误判与粘性串味。
 *
 * 线指纹取「首条消息 + 首条 user 消息」：同一线内这两条始终不变（历史只在尾部
 * 追加），不同线因任务 prompt 不同而区分开。
 */

const crypto = require('crypto');

const EMPTY_LINE_KEY = '';

function messageText(message) {
    const content = message?.content;
    if (content == null) return '';
    if (typeof content === 'string') return content;
    try {
        return JSON.stringify(content);
    } catch (_) {
        return String(content);
    }
}

/**
 * 计算对话线标识。messages 为空或无可辨识内容时返回空串（调用方按"无线索"处理）。
 * @param {Array} messages OpenAI 风格的 messages 数组
 * @returns {string} 16 位十六进制指纹
 */
function lineKeyOf(messages) {
    const list = Array.isArray(messages) ? messages : [];
    if (list.length === 0) return EMPTY_LINE_KEY;
    const head = messageText(list[0]);
    const firstUser = list.length > 1 ? messageText(list[1]) : '';
    if (!head && !firstUser) return EMPTY_LINE_KEY;
    return crypto.createHash('sha1').update(`${head}\u0000${firstUser}`).digest('hex').slice(0, 16);
}

module.exports = { lineKeyOf, EMPTY_LINE_KEY };
