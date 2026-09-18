/**
 * LoopTask 调度执行器（挂进进程内 Scheduler，PG 乐观锁保证多实例单跑）。
 *
 * 执行模型（0030 起取代 TaskAgent）：一次 Run = 在项目沙箱内创建真实 Agent 会话
 * （用户的 Agent + 用户的模型额度），Agent 以 headless 一次性模式启动
 * （taskRunModes：`claude -p` 等），执行完任务即退出进程——
 *   exitCode 0    → run succeeded
 *   exitCode 非 0 → run failed
 *   超时          → run timeout（会话被终止）
 *
 * tick 职责：
 *   1. 僵尸 run 回收（服务崩溃后遗留的 running 行；会话已退出的按退出码定终态）
 *   2. 扫描到期任务（status='active' AND next_run_at <= now）
 *   3. 每用户并发闸：running run 数 >= 上限 → 推迟本槽位（不插 run、不推进 next_run_at）
 *   4. 幂等触发：INSERT run ON CONFLICT (task_id, scheduled_for) DO NOTHING
 *   5. 防重入：上一次 run 仍在 running → 仅推进 next_run_at
 *   6. executeRun 异步执行（不阻塞 tick），完成后回写终态 + SSE + 审计
 */

const crypto = require('crypto');
const { and, asc, eq, lt, lte, sql } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const sessionManager = require('../session/SessionManager');
const { broadcastSse } = require('../session/sseManager');
const { recordEvent } = require('../events/recordEvent');
const { computeNextRunAt } = require('./cron');
const { createAgentSession } = require('../session/createAgentSession');
const transcriptStore = require('../runtime/TranscriptStore');
const trajectory = require('../llm/trajectory');

// 任务超时默认 60min：qwen/gemini 系 headless 全程静默、只在结束时打印最终回复，
// 重任务（如风险扫描读数百提交 diff）30min 跑不完会被误杀——表现与挂死完全一致。
const TIMEOUT_MS = Number(process.env.LOOP_TASK_TIMEOUT_MS) || 60 * 60_000;
const SPAWN_WAIT_MS = Number(process.env.LOOP_TASK_SPAWN_WAIT_MS) || 5 * 60_000;
const ALIVE_POLL_MS = 2000;
const MAX_CONCURRENT_PER_USER = Number(process.env.LOOP_TASK_MAX_CONCURRENT_PER_USER) || 2;
const ZOMBIE_BUFFER_MS = 10 * 60_000;

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function broadcastRun(run, extra = {}) {
    try {
        broadcastSse({ type: 'loop_task_run_updated', runId: run.id, taskId: run.taskId, ...extra });
    } catch { /* SSE 失败不影响主流程 */ }
}

async function updateRun(runId, patch) {
    await db.update(schema.loopTaskRuns).set(patch).where(eq(schema.loopTaskRuns.id, runId));
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

const TERMINAL_TAIL_BYTES = 8192;
const RESULT_MAX_CHARS = 16 * 1024;

function stripAnsi(text) {
    return String(text || '')
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
}

/** 失败/超时时提取会话终端输出末尾（CLI stderr/stdout），用于落 run.error。 */
function captureTerminalTail(sessionId) {
    try {
        const live = sessionManager.getSession(sessionId);
        const ref = live?.transcriptRef;
        if (!ref) return null;
        const { frames } = transcriptStore.readTail(ref, TERMINAL_TAIL_BYTES);
        let text = '';
        for (const f of frames) {
            if (f.kind === 'out' && typeof f.data === 'string') text += f.data;
        }
        const clean = stripAnsi(text).trim().slice(-TERMINAL_TAIL_BYTES).trim();
        return clean || null;
    } catch {
        return null;
    }
}

/**
 * 成功 run 的输出物：提取最终回复（业界定时 Agent 标配）。
 * 优先取轨迹里最后一条带文本的模型响应（对话式 headless CLI 的最终答复），
 * 回退终端尾部。null = 会话没有任何文本产出。
 */
async function extractRunResult(sessionId) {
    try {
        const steps = await trajectory.getAllSteps(sessionId);
        for (let i = steps.length - 1; i >= 0; i -= 1) {
            const content = steps[i]?.response?.content;
            if (!Array.isArray(content)) continue;
            const text = content
                .filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
                .map((b) => b.text.trim())
                .join('\n\n');
            if (text) return text.slice(0, RESULT_MAX_CHARS);
        }
    } catch { /* 轨迹不可用 → 回退终端 */ }
    return captureTerminalTail(sessionId);
}

/**
 * 终止任务会话（镜像 /exit 语义）：beginHibernate 防 onExit 覆盖状态 → kill →
 * 标记 exited → 从内存表清理。对已退出的会话幂等。
 */
async function stopTaskSession(sessionId, log = console) {
    try {
        const live = sessionManager.getSession(sessionId);
        if (live?.handle) {
            sessionManager.beginHibernate(sessionId);
            try { live.handle.kill(); } catch (err) {
                log.warn?.({ err, sessionId }, '[loop-task-runner] failed to kill task session handle');
            }
        }
        await db.update(schema.sessions)
            .set({ status: 'exited', exitedAt: Date.now(), updatedAt: Date.now() })
            .where(eq(schema.sessions.id, sessionId));
        sessionManager.deleteSession(sessionId);
    } catch (err) {
        log.warn?.({ err, sessionId }, '[loop-task-runner] stopTaskSession failed');
    }
}

/** 僵尸 run 回收：进程崩溃后遗留的 running 行（超出 超时+缓冲 仍无终态）。
 *  会话已退出的按退出码定终态；仍存活/待命的（重启后由 recoverRunningSessions 接管）
 *  留给下一轮 reap——超过缓冲仍未了结才判 timeout。 */
async function reapZombieRuns(now, log = console) {
    const cutoff = now - TIMEOUT_MS - ZOMBIE_BUFFER_MS;
    const stale = await db.select().from(schema.loopTaskRuns)
        .where(and(eq(schema.loopTaskRuns.status, 'running'), lt(schema.loopTaskRuns.startedAt, cutoff)))
        .limit(50);
    let reaped = 0;
    for (const run of stale) {
        let status = 'timeout';
        let error = 'interrupted (service restart or timeout)';
        if (run.sessionId) {
            const sessionRows = await db.select({
                status: schema.sessions.status,
                exitCode: schema.sessions.exitCode,
                provisioningError: schema.sessions.provisioningError,
            }).from(schema.sessions).where(eq(schema.sessions.id, run.sessionId)).limit(1);
            const session = sessionRows[0] || null;
            if (session && (session.status === 'running' || session.status === 'pending')) {
                continue; // 会话还在跑（重启后被正常恢复），不抢判定
            }
            if (session && session.status === 'exited' && Number(session.exitCode) === 0) {
                status = 'succeeded';
                error = null;
            } else if (session?.provisioningError) {
                status = 'failed';
                error = session.provisioningError;
            }
        }
        await updateRun(run.id, { status, error, finishedAt: now });
        broadcastRun(run, { status });
        log.warn?.(`[loop-task-runner] reaped zombie run ${run.id} (task ${run.taskId}) → ${status}`);
        reaped += 1;
    }
    return reaped;
}

/** 每用户并发闸：running run 数（跨该用户全部任务） */
async function runningCountByUser() {
    const rows = await db.select({
        userId: schema.loopTasks.userId,
        cnt: sql`count(*)`,
    })
        .from(schema.loopTaskRuns)
        .innerJoin(schema.loopTasks, eq(schema.loopTaskRuns.taskId, schema.loopTasks.id))
        .where(eq(schema.loopTaskRuns.status, 'running'))
        .groupBy(schema.loopTasks.userId);
    return new Map(rows.map((r) => [r.userId, Number(r.cnt) || 0]));
}

/** 单次执行（异步；tick 内 fire-and-forget） */
async function executeRun(task, run, log = console) {
    const runId = run.id;
    let settled = false; // 首个终态（exit / 超时 / 创建失败）胜出，其余忽略
    let sessionId = null;
    let deadlineTimer = null;
    let offExit = null;

    const finalize = async (status, error) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
        try { offExit?.(); } catch { /* ignore */ }

        // 失败/超时：把 agent 终端输出末尾落进 run.error，否则 CLI 级报错（exit 1）
        // 只在终端里（轨迹、exitCode 都没有），事后无法定位失败原因。
        // 成功：提取最终回复落 run.result（业界定时 Agent 的输出物一等公民）。
        let storedError = error || null;
        let storedResult = null;
        if (sessionId) {
            if (status === 'succeeded') {
                storedResult = await extractRunResult(sessionId);
            } else {
                const tail = captureTerminalTail(sessionId);
                if (tail) storedError = `${error || status}\n\n${tail}`;
            }
        }

        await updateRun(runId, {
            status,
            error: storedError,
            result: storedResult,
            sessionId,
            agentId: task.agentId || null,
            finishedAt: Date.now(),
        }).catch(() => {});
        broadcastRun({ id: runId, taskId: task.id }, { status });
        void recordEvent({
            userId: task.userId,
            projectId: task.projectId,
            subjectType: 'loop_task_run',
            subjectId: runId,
            type: `loop_task_run_${status}`,
            data: { taskId: task.id, sessionId: sessionId || undefined, error: error || undefined },
        }).catch(() => {});
        log.log?.(`[loop-task-runner] run ${runId} (task "${task.title}") → ${status}${sessionId ? ` session=${sessionId}` : ''}${error ? ` error=${error}` : ''}`);
    };

    try {
        const projects = await db.select().from(schema.projects)
            .where(eq(schema.projects.id, task.projectId))
            .limit(1);
        if (projects.length === 0) throw new Error('workspace not found');
        const project = projects[0];
        if (!task.agentId) throw new Error('task has no agent configured — edit the task and pick an agent');

        // 创建 headless Agent 会话（source=loop_task；豁免配额由调用方不检查实现）
        const created = await createAgentSession({
            user: { id: task.userId, role: 'member' },
            project,
            agentId: task.agentId,
            source: 'loop_task',
            title: task.title,
            taskPrompt: task.prompt,
            taskAutoApprove: task.autoApprove !== false,
            log,
        });
        if (!created.ok) throw new Error(created.error || 'failed to create agent session');
        sessionId = created.sessionId;
        await updateRun(runId, { sessionId, agentId: task.agentId }).catch(() => {});

        // 等待会话就绪（异步供应：VM + Agent spawn）
        const waitUntil = Date.now() + SPAWN_WAIT_MS;
        while (!sessionManager.isAlive(sessionId)) {
            if (settled) return;
            if (Date.now() > waitUntil) throw new Error(`session did not become ready within ${SPAWN_WAIT_MS}ms`);
            await sleep(ALIVE_POLL_MS);
        }

        // 订阅退出：headless Agent 跑完即退出进程，exitCode 即任务结果
        offExit = sessionManager.onExit(sessionId, (exitCode) => {
            const ok = Number(exitCode) === 0;
            void finalize(ok ? 'succeeded' : 'failed', ok ? null : `agent exited with code ${exitCode}`);
        });

        // 超时兜底：到点判 timeout 并终止会话（finalize 幂等，与 exit 竞争首个终态）
        deadlineTimer = setTimeout(() => {
            void (async () => {
                const mins = Math.round(TIMEOUT_MS / 60_000);
                await finalize('timeout', `task timed out after ${mins} min`);
                await stopTaskSession(sessionId, log);
            })();
        }, TIMEOUT_MS);
    } catch (err) {
        await finalize('failed', String(err?.message || err).slice(0, 500));
        if (sessionId) await stopTaskSession(sessionId, log);
    }
}

/**
 * Scheduler job 入口（30s tick）。
 */
async function tick({ log = console } = {}) {
    const now = Date.now();
    await reapZombieRuns(now, log);

    const due = await db.select().from(schema.loopTasks)
        .where(and(eq(schema.loopTasks.status, 'active'), lte(schema.loopTasks.nextRunAt, now)))
        .orderBy(asc(schema.loopTasks.nextRunAt))
        .limit(20);
    if (due.length === 0) return;

    const runningByUser = await runningCountByUser();

    for (const task of due) {
        // 防重入：上一次 run 仍在跑 → 推进 next_run_at，本轮跳过
        const active = await db.select({ id: schema.loopTaskRuns.id })
            .from(schema.loopTaskRuns)
            .where(and(eq(schema.loopTaskRuns.taskId, task.id), eq(schema.loopTaskRuns.status, 'running')))
            .limit(1);
        if (active.length > 0) {
            await db.update(schema.loopTasks)
                .set({ lastRunAt: now, updatedAt: now })
                .where(eq(schema.loopTasks.id, task.id));
            log.warn?.(`[loop-task-runner] task "${task.title}" skipped: previous run still active`);
            continue;
        }

        // 每用户并发闸：不插 run、不推进 next_run_at——下个 tick 重试同一槽位，
        // 避免幂等锚点（scheduled_for）被空转消耗
        const used = runningByUser.get(task.userId) || 0;
        if (used >= MAX_CONCURRENT_PER_USER) {
            log.warn?.(`[loop-task-runner] task "${task.title}" deferred: user concurrency limit (${used}/${MAX_CONCURRENT_PER_USER})`);
            continue;
        }

        // 幂等触发：唯一槽位约束挡住 tick 重叠 / 重启补触发 / 多实例并发
        const runId = newId('ltr');
        const inserted = await db.insert(schema.loopTaskRuns)
            .values({
                id: runId,
                taskId: task.id,
                scheduledFor: task.nextRunAt,
                status: 'running',
                startedAt: now,
                logs: [],
            })
            .onConflictDoNothing({ target: [schema.loopTaskRuns.taskId, schema.loopTaskRuns.scheduledFor] })
            .returning({ id: schema.loopTaskRuns.id });

        // 推进调度（kind 感知）：at 单次触发后任务置 completed 不再推进
        let nextAt = now + 60 * 60_000; // 解析失败兜底：1h 后重试
        let taskPatch = { lastRunAt: now, updatedAt: now };
        try {
            nextAt = computeNextRunAt(task, new Date(now));
            taskPatch.nextRunAt = nextAt;
        } catch (e) {
            log.warn?.(`[loop-task-runner] schedule parse failed for task "${task.title}": ${e.message}`);
        }
        if ((task.scheduleKind || 'cron') === 'at') {
            taskPatch.status = 'completed'; // 单次任务：已触发即完成
        }
        await db.update(schema.loopTasks)
            .set(taskPatch)
            .where(eq(schema.loopTasks.id, task.id));

        if (inserted.length === 0) continue; // 槽位已触发过
        runningByUser.set(task.userId, used + 1); // 闸计数同步，防止同 tick 超放
        void executeRun(task, { id: runId }, log); // 异步执行，不阻塞 tick
    }
}

module.exports = { tick, executeRun };
