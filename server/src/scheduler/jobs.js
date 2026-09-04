/**
 * Scheduler jobs（P2）——conversation-summarize：定时增量摘要。
 *
 * 设计说明（A+B 模式对齐）：
 * - A 路 turns 实时读 chat transcript，天然最新，无需定时。
 * - B 路 LLM 摘要遵循「首次或 exit / 手动 force 才调用」的低成本哲学，
 *   因此定时 job 调用 summarizeSession **不带 force**：对尚无摘要的
 *   长跑会话自动生成首次摘要，对已有摘要的会话仅推进游标 + 落库 turns，
 *   不重复调用 LLM。
 * - 候选筛选按「该会话的源是否有新内容」判定（chat 源比 chat seq，
 *   transcript/state_dir 源比 stream head_seq），只有新内容才会被选中。
 */

const { sql } = require('drizzle-orm');
const { db } = require('../db');
const { broadcastSse } = require('../session/sseManager');

const DEFAULT_INTERVAL_MS = 300_000; // 5 分钟

function getSummaryService() {
    return require('../session/conversationSummaryService');
}

/**
 * 选出待处理的会话（running/idle，且其数据源有新内容）。
 * 返回 [{ id, user_id }]，按 created_at 倒序，LIMIT batch。
 */
async function listCandidateSessions(batch) {
    const result = await db.execute(sql`
        SELECT s.id, s.user_id
        FROM sessions s
        LEFT JOIN session_conversations sc ON sc.session_id = s.id
        LEFT JOIN session_streams st ON st.session_id = s.id
        WHERE s.status IN ('running', 'idle')
          AND (
            sc.session_id IS NULL
            OR (
              COALESCE(sc.error_count, 0) < 3
              AND (
                (sc.source = 'chat'
                  AND sc.last_summarized_seq < COALESCE(
                    (SELECT MAX(m.seq) FROM session_chat_messages m WHERE m.session_id = s.id), 0))
                OR (sc.source IS DISTINCT FROM 'chat'
                  AND sc.last_summarized_seq < COALESCE(st.head_seq, 0))
              )
            )
          )
        ORDER BY s.created_at DESC
        LIMIT ${batch}
    `);
    return result.rows || result || [];
}

async function runConversationSummarize({ log = console } = {}) {
    const batch = Number(process.env.CONVERSATION_SUMMARY_BATCH) || 5;
    const rows = await listCandidateSessions(batch);

    let processed = 0;
    for (const row of rows) {
        const sessionId = row.id;
        try {
            await getSummaryService().summarizeSession(sessionId);
            processed += 1;
            try {
                broadcastSse({
                    type: 'session_conversation_updated',
                    sessionId,
                    userId: row.user_id,
                    updatedAt: Date.now(),
                });
            } catch (_) { /* SSE 失败不影响主流程 */ }
        } catch (err) {
            // no_content / 瞬时 LLM 失败：本轮跳过该会话，下轮再试
            // 注意：log.warn(...) 返回 undefined，不能用 `??` 链式 fallback——
            // 那会总是执行 log?.(...)，而 log 默认是 console 对象（不可调用），
            // 抛 `log is not a function` 导致整个 job 中断。
            const message = `[scheduler:conversation-summarize] skip ${sessionId}: ${err?.message || err}`;
            if (typeof log?.warn === 'function') log.warn(message);
            else if (typeof log === 'function') log(message);
            else console.warn(message);
        }
    }
    return processed;
}

/**
 * 返回当前启用的一组 job 定义（供 Scheduler 注入）。
 */
function createJobs() {
    return [
        {
            name: 'conversation-summarize',
            intervalMs: Number(process.env.CONVERSATION_SUMMARY_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
            run: (ctx) => runConversationSummarize(ctx),
        },
        {
            name: 'skill-pipeline',
            intervalMs: Number(process.env.SKILL_PIPELINE_INTERVAL_MS) || require('../skills/skillPipeline').DEFAULT_INTERVAL_MS,
            run: (ctx) => require('../skills/skillPipeline').runPipeline({ log: ctx?.log || console }),
        },
    ];
}

module.exports = { createJobs, runConversationSummarize, listCandidateSessions, DEFAULT_INTERVAL_MS };
