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
// 人工复核（requireReview=true）模式：
//   TURN_MIN_MS / TURN_IDLE_MS：注入指令后至少跑满 1min 且输出静默 45s 才认为本轮
//   干完活（headless 靠进程退出判定，交互式只能靠静默启发式；过早误判无害——
//   awaiting_review 只是把会话标记为等人，人打开会话能看到 agent 还在跑）
const TURN_MIN_MS = Number(process.env.LOOP_TASK_TURN_MIN_MS) || 60_000;
const TURN_IDLE_MS = Number(process.env.LOOP_TASK_TURN_IDLE_MS) || 45_000;
const TURN_POLL_MS = 10_000;
// 复核超时：awaiting_review 停留超过此时长由 tick sweep 自动按 succeeded 收口
const REVIEW_TIMEOUT_MS = Number(process.env.LOOP_TASK_REVIEW_TIMEOUT_MS) || 24 * 60 * 60_000;

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
 * 标记 exited → 从内存表清理。对已退出的会话幂等（进程已死则跳过 kill，
 * 仅补写 DB 终态并清内存）。
 * @param {number|null} [exitCode] 进程退出码；成功/失败路径由 onExit 传入，
 *   供但尸回收 reapZombieRuns 按 exit_code===0 判 succeeded。
 */
async function stopTaskSession(sessionId, log = console, exitCode = null) {
    try {
        const live = sessionManager.getSession(sessionId);
        if (live?.handle) {
            sessionManager.beginHibernate(sessionId);
            try { live.handle.kill(); } catch (err) {
                log.warn?.({ err, sessionId }, '[loop-task-runner] failed to kill task session handle');
            }
        }
        await db.update(schema.sessions)
            .set({ status: 'exited', exitCode, exitedAt: Date.now(), updatedAt: Date.now() })
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

/** 复核超时清扫：awaiting_review 停留超过 REVIEW_TIMEOUT_MS → 自动按
 *  succeeded 收口并退出会话。覆盖进程内定时器无法覆盖的场景（服务重启后
 *  定时器丢失、run 在另一实例进入复核）。 */
async function sweepReviewTimeouts(now, log = console) {
    const cutoff = now - REVIEW_TIMEOUT_MS;
    const stale = await db.select().from(schema.loopTaskRuns)
        .where(and(eq(schema.loopTaskRuns.status, 'awaiting_review'), lt(schema.loopTaskRuns.reviewStartedAt, cutoff)))
        .limit(50);
    let swept = 0;
    for (const run of stale) {
        await updateRun(run.id, { status: 'succeeded', finishedAt: now });
        broadcastRun(run, { status: 'succeeded' });
        if (run.sessionId) await stopTaskSession(run.sessionId, log);
        log.warn?.(`[loop-task-runner] review timeout run ${run.id} (task ${run.taskId}) → succeeded (auto-closed)`);
        swept += 1;
    }
    return swept;
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
    let reviewPoll = null;
    let offExit = null;

    const finalize = async (status, error) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
        if (reviewPoll) { clearInterval(reviewPoll); reviewPoll = null; }
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

        // 创建 Agent 会话（source=loop_task；豁免配额由调用方不检查实现）。
        // interactive = 复核模式或 TUI 自动收口模式：不走 headless 一次性参数，
        // 以交互式拉起，任务指令由 runner 就绪后注入 PTY。
        //   复核模式：干完活 → awaiting_review 挂起等人
        //   TUI 自动收口：干完活 → 静默后自动按 succeeded 收口并退出会话
        //  （终端全程已渲染，回放即历史；退出码语义让位于过程可视化）
        // 所有循环任务一律【交互式】拉起（TUI 可见可回放）；手动批准场景由
        // TUI 逐个审批，自动批准场景由 runner 注入各 CLI 免审批 flag。
        // 成败以「本轮完整走完」为准，不再依赖退出码（过程可视化优先）。
        const reviewMode = task.requireReview === true;
        const interactive = true;
        const created = await createAgentSession({
            user: { id: task.userId, role: 'member' },
            project,
            agentId: task.agentId,
            source: 'loop_task',
            title: task.title,
            taskPrompt: interactive ? null : task.prompt,
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

        // 订阅退出：headless 模式下 exitCode 即任务结果；复核模式下进程中途退出
        // 属异常崩溃 → failed。finalize 只更新 run 行；会话行必须显式落 exited
        //（否则 DB 停留 running，重启后被 reconcile 误标为可恢复的 idle——
        // 任务会话永远进不了「已退出」）。
        offExit = sessionManager.onExit(sessionId, (exitCode) => {
            // 交互模式下 agent 进程不应自行退出：提前退出即异常（崩溃/被杀），无论退出码一律判 failed
            void (async () => {
                await finalize('failed', `agent exited unexpectedly with code ${exitCode}`);
                await stopTaskSession(sessionId, log, exitCode);
            })();
        });

        {
            // 注入任务指令（所有模式均交互式拉起：镜像 /terminal/input：写 PTY +
            // 落转录 + 触碰活动戳）。两段式写入：先写文本、间隔 400ms 再单独写
            // \r（回车）。同一次 write 里的「text + \r」会被部分 TUI（实测
            // codebuddy）当作普通文本填进输入框而不提交——回车必须是独立的写入
            // 事件。多行指令压成单行（裸换行会被 TUI 当回车逐行提交）。
            // 时序：① 等 TUI 首帧（lastOutputAt 非空，60s 强制兜底）；② 等输出静默
            // ≥3s（启动 spinner 停止，ink 系 TUI 启动期会丢弃 stdin）；③ 注入；
            // ④ 8s 内无新输出视为未提交，重试至多 3 次（重试先补 \r 提交可能残留
            // 在输入框里的文本，再重新写一遍）。
            let injectedAt = null;
            let injectAttempts = 0;
            const bootStart = Date.now();
            const injectTry = () => {
                if (settled || injectAttempts >= 3) return;
                injectAttempts += 1;
                if (injectAttempts > 1) {
                    // 重试：先补一个回车提交可能残留在输入框里的文本
                    sessionManager.getSession(sessionId)?.handle?.write('\r');
                }
                const cur = sessionManager.getSession(sessionId);
                if (!cur) return;
                const text = `${String(task.prompt).replace(/\r?\n+/g, ' ')}`;
                if (cur.transcriptRef) {
                    transcriptStore.append(cur.transcriptRef, { kind: 'in', data: `${text}\r` });
                }
                cur?.handle?.write(text);
                sessionManager.touchActivity(sessionId, 'input');
                setTimeout(() => {
                    if (settled) return;
                    const cur2 = sessionManager.getSession(sessionId);
                    if (!cur2) return;
                    const before = Number(cur2.lastOutputAt || 0);
                    cur2?.handle?.write('\r');
                    injectedAt = Date.now();
                    // 验证：8s 内出现新输出 → 已提交；否则重试
                    setTimeout(() => {
                        if (settled || injectAttempts >= 3) return;
                        const cur3 = sessionManager.getSession(sessionId);
                        if (!cur3) return;
                        if (Number(cur3.lastOutputAt || 0) > before) return;
                        log.warn?.(`[loop-task-runner] run ${runId}: prompt injection appeared swallowed (no output in 8s), retrying (${injectAttempts}/3)`);
                        injectTry();
                    }, 8_000);
                }, 400);
            };
            const bootPoll = setInterval(() => {
                if (settled) { clearInterval(bootPoll); return; }
                const live = sessionManager.getSession(sessionId);
                if (!live) return;
                const now = Date.now();
                if (!live.lastOutputAt) {
                    // 迟迟无首帧也兜底试一次（静默 spawn 场景）
                    if (now - bootStart > 60_000) { clearInterval(bootPoll); injectTry(); }
                    return;
                }
                if (now - Number(live.lastOutputAt) >= 3_000) {
                    clearInterval(bootPoll);
                    injectTry();
                }
            }, 1_000);

            // 静默检测本轮任务结束（headless 靠进程退出，交互式只能靠静默启发式）：
            //   ① 注入之后必须出现过新的 agent 输出（lastOutputAt > injectedAt）——
            //      TUI 首帧/启动期的静默不算开工；注入始终被吞时保持 running 直到
            //      执行超时，超时会抓终端尾打进 error 便于定位。
            //   ② 开工后输出静默 TURN_IDLE_MS（至少距注入 TURN_MIN_MS）→ 认为干完
            //      活：复核模式进入 awaiting_review 挂起等人；自动结束模式自动按
            //      成功收口并退出会话。
            let warnedNoStart = false;
            reviewPoll = setInterval(() => {
                if (settled) { clearInterval(reviewPoll); reviewPoll = null; return; }
                if (injectedAt == null) return;
                const live = sessionManager.getSession(sessionId);
                if (!live) return;
                const now = Date.now();
                if (now - injectedAt < TURN_MIN_MS) return;
                const started = Number(live.lastOutputAt || 0) > injectedAt;
                const lastOut = Number(live.lastOutputAt || live.lastActivityAt || injectedAt);
                if (now - lastOut < TURN_IDLE_MS) return;
                if (!started) {
                    if (!warnedNoStart) {
                        warnedNoStart = true;
                        log.warn?.(`[loop-task-runner] run ${runId}: no agent output after prompt injection — keep running until timeout (terminal tail will be captured)`);
                    }
                    return;
                }
                clearInterval(reviewPoll);
                reviewPoll = null;
                void (async () => {
                    try {
                        if (reviewMode) {
                            const result = await extractRunResult(sessionId);
                            if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
                            await updateRun(runId, { status: 'awaiting_review', result, reviewStartedAt: Date.now() });
                            broadcastRun(run, { status: 'awaiting_review' });
                            log.log?.(`[loop-task-runner] run ${runId} (task "${task.title}") → awaiting_review (session ${sessionId} kept alive for human review)`);
                        } else {
                            // TUI 自动收口：干完活自动按成功收口并退出会话；
                            // 全过程已写入终端转录，回放即可查看
                            if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
                            await finalize('succeeded', null);
                            await stopTaskSession(sessionId, log);
                            log.log?.(`[loop-task-runner] run ${runId} (task "${task.title}") → succeeded (tui auto-finish, session closed)`);
                        }
                    } catch (err) {
                        log.warn?.({ err, runId }, '[loop-task-runner] failed to complete interactive turn');
                    }
                })();
            }, TURN_POLL_MS);
        }

        // 超时兜底（两种模式共用；复核模式若已进入 awaiting_review 会提前清除本定时器，
        // 改由 REVIEW_TIMEOUT_MS 清扫收口）：到点判 timeout 并终止会话
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
    await sweepReviewTimeouts(now, log);

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

/** 人工复核收口：通过 → succeeded；打回 → failed。仅对 awaiting_review 生效，
 *  收口后终止会话（镜像 /exit，任务会话生命周期就此结束）。 */
async function completeReviewRun(runId, approved, log = console) {
    const rows = await db.select().from(schema.loopTaskRuns).where(eq(schema.loopTaskRuns.id, runId)).limit(1);
    const run = rows[0] || null;
    if (!run || run.status !== 'awaiting_review') {
        return { ok: false, error: 'run is not awaiting review' };
    }
    const status = approved ? 'succeeded' : 'failed';
    await updateRun(runId, {
        status,
        error: approved ? null : 'rejected by user',
        finishedAt: Date.now(),
    });
    broadcastRun(run, { status });
    if (run.sessionId) await stopTaskSession(run.sessionId, log);
    log.log?.(`[loop-task-runner] run ${runId} review → ${status} (by human)`);
    return { ok: true, status };
}

module.exports = { tick, executeRun, completeReviewRun };
