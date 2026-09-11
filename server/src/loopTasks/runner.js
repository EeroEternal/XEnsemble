/**
 * LoopTask 调度执行器（挂进进程内 Scheduler，PG 乐观锁保证多实例单跑）。
 *
 * tick 职责：
 *   1. 僵尸 run 回收（服务崩溃后遗留的 running 行）
 *   2. 扫描到期任务（status='active' AND next_run_at <= now）
 *   3. 幂等触发：INSERT run ON CONFLICT (task_id, scheduled_for) DO NOTHING
 *      —— 30s tick 边界重叠 / 服务重启补触发 / 多实例并发全被唯一约束挡住
 *   4. 防重入：上一次 run 仍在 running → 仅推进 next_run_at
 *   5. executeRun 异步执行（不阻塞 tick），完成后回写终态 + SSE + 审计
 */

const crypto = require('crypto');
const { and, asc, eq, lt, lte } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');
const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const { getRuntime } = require('../runtime/registry');
const { broadcastSse } = require('../session/sseManager');
const { recordEvent } = require('../events/recordEvent');
const { nextRunForTask } = require('./cron');
const { executeTask } = require('./taskAgent');

const TIMEOUT_MS = Number(process.env.LOOP_TASK_TIMEOUT_MS) || 30 * 60_000;
const MAX_ROUNDS = Number(process.env.LOOP_TASK_MAX_ROUNDS) || 30;
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

/** 僵尸回收：进程崩溃后遗留的 running 行（超出 超时+缓冲 仍无终态） */
async function reapZombieRuns(now, log = console) {
    const cutoff = now - TIMEOUT_MS - ZOMBIE_BUFFER_MS;
    const stale = await db.select().from(schema.loopTaskRuns)
        .where(and(eq(schema.loopTaskRuns.status, 'running'), lt(schema.loopTaskRuns.startedAt, cutoff)))
        .limit(50);
    for (const run of stale) {
        await updateRun(run.id, { status: 'timeout', error: 'interrupted (service restart or timeout)', finishedAt: now });
        broadcastRun(run, { status: 'timeout' });
        log.warn?.(`[loop-task-runner] reaped zombie run ${run.id} (task ${run.taskId})`);
    }
    return stale.length;
}

/** 单次执行（异步；tick 内 fire-and-forget） */
async function executeRun(task, run, log = console) {
    const runId = run.id;
    let logs = [];
    const flushLogs = () => updateRun(runId, { logs, rounds: logs.length }).catch(() => {});

    try {
        const projects = await db.select().from(schema.projects)
            .where(eq(schema.projects.id, task.projectId))
            .limit(1);
        if (projects.length === 0) throw new Error('workspace not found');
        const project = projects[0];

        const ready = await ensureProjectRuntime(project, {});
        const runtime = ready.runtime;
        if (!runtime) throw new Error('runtime provisioning failed');
        const runtimeRef = runtime.runtimeRef;
        const workspacePath = ready.workspacePath || project.serverPath;
        if (!runtimeRef || !workspacePath) throw new Error('runtime not ready (no runtimeRef/workspace)');

        const rt = getRuntime();
        const result = await executeTask({
            runtime: { exec: rt.exec, fs: rt.fs },
            runtimeRef,
            workspacePath,
            task: { title: task.title, prompt: task.prompt },
            maxRounds: MAX_ROUNDS,
            timeoutMs: TIMEOUT_MS,
            onRound: (entry) => {
                logs.push({ ts: Date.now(), ...entry });
                void flushLogs();
                broadcastRun(run, { status: 'running', round: entry.round, action: entry.action });
            },
        });

        await updateRun(runId, {
            status: result.status === 'timeout' ? 'timeout' : (result.ok ? 'succeeded' : 'failed'),
            rounds: result.rounds,
            logs: logs.slice(-200),
            error: result.error || null,
            finishedAt: Date.now(),
        });
        await recordEvent({
            userId: task.userId,
            projectId: task.projectId,
            subjectType: 'loop_task_run',
            subjectId: runId,
            type: `loop_task_run_${result.ok ? 'succeeded' : result.status === 'timeout' ? 'timeout' : 'failed'}`,
            data: { taskId: task.id, rounds: result.rounds, error: result.error || undefined },
        }).catch(() => {});
        broadcastRun(run, { status: result.ok ? 'succeeded' : result.status });
        log.log?.(`[loop-task-runner] run ${runId} (task "${task.title}") → ${result.ok ? 'succeeded' : result.status} in ${result.rounds} rounds`);
    } catch (err) {
        logs.push({ ts: Date.now(), round: logs.length, action: 'error', summary: String(err?.message || err).slice(0, 300) });
        await updateRun(runId, {
            status: 'failed',
            logs: logs.slice(-200),
            error: String(err?.message || err).slice(0, 500),
            finishedAt: Date.now(),
        }).catch(() => {});
        broadcastRun(run, { status: 'failed' });
        log.warn?.(`[loop-task-runner] run ${runId} (task "${task.title}") failed: ${err?.message || err}`);
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
            nextAt = nextRunForTask(task, new Date(now));
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
        void executeRun(task, { id: runId }, log); // 异步执行，不阻塞 tick
    }
}

module.exports = { tick, executeRun };
