/**
 * 会话级内置 AI 调用的计量归属解析（0043）。
 *
 * userId 一律以 sessions 行为准（sessions.user_id NOT NULL；会话删除为软删、
 * 用户删除为挂起，行始终存在），不引入任何兜底归属。查不到会话时返回不含
 * userId 的 metering，由 analyzeClient 的 LlmAttributionError fail-fast 暴露。
 *
 * 用法：const metering = await resolveSessionMetering(sessionId, 'session_title');
 *       await llm.chat({ ..., metering });
 */
const { eq } = require('drizzle-orm');

async function resolveSessionMetering(sessionId, feature) {
    const metering = { feature, sessionId: sessionId || null };
    if (!sessionId) return metering;
    // 惰性 require：保持本模块可被无 DATABASE_URL 的单测环境加载
    const { db } = require('../db');
    const schema = require('../db/schema');
    const rows = await db
        .select({ userId: schema.sessions.userId, projectId: schema.sessions.projectId })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);
    metering.userId = rows[0]?.userId;
    metering.projectId = rows[0]?.projectId || null;
    return metering;
}

module.exports = { resolveSessionMetering };
