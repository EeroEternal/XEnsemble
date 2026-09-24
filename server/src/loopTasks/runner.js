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
const { parseApprovalState } = require('./approvalState');
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
// 干完判定（requireReview 与自动结束两模式共用）：
//   TURN_MIN_MS / TURN_IDLE_MS：注入指令后至少跑满 1min 且输出静默 45s 才认为本轮
//   干完活（headless 靠进程退出判定，交互式只能靠静默启发式；过早误判无害——
//   只是提前按 succeeded 收口，会话还在，人打开会话能看到 agent 还在跑）
const TURN_MIN_MS = Number(process.env.LOOP_TASK_TURN_MIN_MS) || 60_000;
const TURN_IDLE_MS = Number(process.env.LOOP_TASK_TURN_IDLE_MS) || 45_000;
const TURN_POLL_MS = 10_000;

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
 * 轨迹层完成判据：Agent 是否仍在执行工具。
 * LLM proxy 逐次记录模型响应（trajectory），最后一步 finish_reason 为
 * 'tool_calls'（openai）/ 'tool_use'（anthropic）= 模型刚发出工具指令、
 * 还在等结果跑；'stop'/'end_turn'/null = 已收口或无轨迹（headless exit
 * 兜底不受影响）。终端静默不再单独作为「干完活」依据——GLM 等执行长
 * 工具（慢命令/长推理）时终端静默超 TURN_IDLE_MS 属正常现象，此前会被
 * 误判完成提前收口。
 * @returns {Promise<boolean>} true = 最后一步仍在跑工具（或轨迹明确 tool_use 收尾）
 */
async function agentStillWorking(sessionId) {
    try {
        const steps = await trajectory.getAllSteps(sessionId);
        if (!steps.length) return false; // 无轨迹（如审批门不经过 proxy 的纯 TUI 交互）→ 不拦
        const last = steps[steps.length - 1];
        const fr = last?.response?.finish_reason;
        return fr === 'tool_calls' || fr === 'tool_use';
    } catch {
        return false;
    }
}

/**
 * 终止任务会话（镜像 /exit 语义）：beginHibernate 防 onExit 覆盖状态 → kill →
 * 标记 exited → 从内存表清理。对已退出的会话幂等（进程已死则跳过 kill，
 * 仅补写 DB 终态并清内存）。
 * @param {number|null} [exitCode] 进程退出码；成功/失败路径由 onExit 传入，
 *   供僵尸回收 reapZombieRuns 按 exit_code===0 判 succeeded。
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
    let turnPoll = null;
    let offExit = null;

    const finalize = async (status, error) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
        if (turnPoll) { clearInterval(turnPoll); turnPoll = null; }
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
        //   复核模式：干完活 → succeeded，会话保留不退出（人工打开会话复核）
        //   自动结束模式：干完活 → 静默后自动按 succeeded 收口并退出会话
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

        // 订阅退出：headless 模式下 exitCode 即任务结果；进程在 run 收口前中途退出
        // 属异常崩溃 → failed（收口后 settled=true，finalize 变 no-op——复核模式
        // 会话保留不退出，事后用户 /exit 或空闲休眠触发的退出只走 stopTaskSession
        // 补会话行终态）。finalize 只更新 run 行；会话行必须显式落 exited
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
            // ④ 12s 内转录 out 帧无注入文本的回显视为未提交，重试至多 3 次
            // （重试先补 \r 提交可能残留在输入框里的文本，再重新写一遍）。
            //
            // 验证为什么用回显而不是「有新输出」：SessionManager 对任意 PTY 输出
            // 刷新 lastOutputAt，TUI 启动期的动画/重绘/主界面渲染都会造成假阳性
            // （实测 claude-code 卡欢迎屏、copilot 卡信任弹窗时注入无反应但验证
            // 通过）。TUI 收到文本必然在输入框回显——在转录 out 帧里找注入文本
            // 开头片段（去 ANSI、压空白后比对）才是「已进入 TUI」的可靠信号。
            const taskPromptText = String(task.prompt).replace(/\r?\n+/g, ' ');
            // cline / glm-agent 的 TUI 审批态控制（都无 CLI 免审 flag 或 flag 与 TUI
            // 不兼容，见 taskRunModes）TUI 就绪后、任务指令注入前落实：
            //   cline：TUI 默认 auto-approve 全开（无人值守事故实测），双象限都靠
            //     Shift+Tab 切到目标态，闭环校验见 verifyClineApprovalState。
            //   glm-agent：TUI 默认逐个审批（手动批准象限=默认态无需处理），仅
            //     自动批准象限注入 shift-tab 切 auto-accept。
            const glmAutoAcceptInject = task.agentId === 'glm-agent' && task.autoApprove !== false;
            const normForEcho = (s) => stripAnsi(String(s || '')).replace(/\s+/g, ' ').trim();
            const echoNeedle = normForEcho(taskPromptText).slice(0, 24);
            let injectedAt = null;
            let committedAt = null;
            let injectAttempts = 0;
            // 输入回显确认：TUI 收到注入文本必然在输入框渲染出来（会进转录 out 帧）
            const hasPromptEcho = (session) => {
                if (!echoNeedle) return true; // 空 prompt 无从验证，等价旧行为
                const ref = session?.transcriptRef;
                if (!ref) return false;
                try {
                    const { frames } = transcriptStore.readTail(ref, 65536);
                    let text = '';
                    for (const f of frames) {
                        if (f.kind === 'out' && typeof f.data === 'string') text += f.data;
                    }
                    return normForEcho(text).includes(echoNeedle);
                } catch {
                    return false;
                }
            };
            const injectTry = () => {
                if (settled || injectAttempts >= 3) return;
                injectAttempts += 1;
                if (injectAttempts > 1) {
                    // 重试：先补一个回车提交可能残留在输入框里的文本
                    sessionManager.getSession(sessionId)?.handle?.write('\r');
                }
                const cur = sessionManager.getSession(sessionId);
                if (!cur) return;
                const writePrompt = () => {
                    if (settled) return;
                    const live = sessionManager.getSession(sessionId);
                    if (!live) return;
                    if (live.transcriptRef) {
                        transcriptStore.append(live.transcriptRef, { kind: 'in', data: `${taskPromptText}\r` });
                    }
                    live?.handle?.write(taskPromptText);
                    sessionManager.touchActivity(sessionId, 'input');
                    setTimeout(() => {
                        if (settled) return;
                        const cur2 = sessionManager.getSession(sessionId);
                        if (!cur2) return;
                        cur2?.handle?.write('\r');
                        // 验证：12s 内出现注入文本回显 → 已提交；否则重试
                        setTimeout(() => {
                            if (settled) return;
                            const cur3 = sessionManager.getSession(sessionId);
                            if (!cur3) return;
                            if (hasPromptEcho(cur3)) {
                                injectedAt = Date.now();
                                committedAt = injectedAt;
                                return;
                            }
                            if (injectAttempts >= 3) {
                                // 3 次仍未确认（可能仍卡在引导屏/弹窗）：不再重试，
                                // 放行 turnPoll 但 committed 门控会阻止收口，挂到
                                // 执行超时兜底抓终端尾定位
                                injectedAt = Date.now();
                                log.warn?.(`[loop-task-runner] run ${runId}: prompt injection unconfirmed after ${injectAttempts} attempts — keep running until timeout (terminal tail will be captured)`);
                                return;
                            }
                            log.warn?.(`[loop-task-runner] run ${runId}: prompt injection appeared swallowed (no echo within 12s), retrying (${injectAttempts}/3)`);
                            injectTry();
                        }, 12_000);
                    }, 400);
                };
                // cline 审批态闭环校验：Shift+Tab 按键无回显，状态靠扫转录帧判定——
                // 目标态不匹配就 PTY 注入按键再扫（seq 过滤只看按键后的新输出，
                // 避免旧头部渲染污染判定）。匹配串与 cline TUI 头部文案耦合（镜像
                // pin 版本，升级须复核）。
                //
                // 事故复盘（2026-09，cline@3.0.55 二进制核实）：cline 首启弹
                // "Try ClinePass" 促销 modal，激活期间吞掉全部非修饰键（enter=开
                // 浏览器、其余键一律 dismiss）——Shift+Tab 首按只把弹窗关掉，
                // auto-approve 纹丝不动，重绘帧仍含 enabled 串，旧逻辑误判「按键
                // 生效但停在非目标态」直接 fail-closed 误杀 run。修复：
                //   ① spawn env 注入官方开关 CLINE_DISABLE_CLINE_PASS_NOTICE=1
                //     禁弹（agents/agentTuiEnv，根治）；
                //   ② 此处兜底：每次按键先发 Esc dismiss 可能存在的 modal（空输入
                //     主屏 Esc 是 no-op，TUI 退出是 Ctrl+C），隔 250ms 再 Shift+Tab；
                //   ③ 状态解析改为「两串各自最后出现位置较新者胜」（loopTasks/
                //     approvalState.parseApprovalState）——Esc dismiss 弹窗的重绘
                //     （enabled）与 toggle 后的重绘（disabled）会先后出现在同一
                //     扫描窗口，单串 includes 会误读中间态；
                //   ④ 状态明确非目标/未知/按键被吞一律重试而非立即 fail-closed，
                //     总轮次上限 5（每轮约 1s，fail-closed 只在持续无法确认时触发：
                //     宁可 run failed，不可审批状态不明就无人值守开跑）。
                const APPROVAL_VERIFY_MAX_ATTEMPTS = 5;
                const verifyClineApprovalState = (attempt, scanFromSeq) => {
                    if (settled) return;
                    const live = sessionManager.getSession(sessionId);
                    if (!live?.transcriptRef) return; // 会话已不在：走既有超时兜底
                    const targetEnabled = task.autoApprove !== false;
                    let text = '';
                    let headSeq = scanFromSeq;
                    let readable = true;
                    try {
                        const { frames } = transcriptStore.readTail(live.transcriptRef, 65536);
                        for (const f of frames) {
                            if (typeof f.seq !== 'number') continue;
                            if (f.seq > headSeq) headSeq = f.seq;
                            if (f.kind === 'out' && typeof f.data === 'string' && f.seq > scanFromSeq) text += f.data;
                        }
                    } catch { readable = false; }
                    const failClosed = () => {
                        log.warn?.(`[loop-task-runner] run ${runId}: cline auto-approve state unverifiable (target=${targetEnabled ? 'on' : 'off'}, attempt ${attempt}) — refusing to start unattended run`);
                        void (async () => {
                            await finalize('failed', 'cline auto-approve state could not be confirmed; refusing unattended run (approval-state verification failed)');
                            await stopTaskSession(sessionId, log);
                        })();
                    };
                    // 先 Esc 关掉可能存在的促销/引导 modal（吞键元凶），再 Shift+Tab
                    const press = () => {
                        live.handle?.write('\x1b');
                        setTimeout(() => {
                            if (settled) return;
                            const cur = sessionManager.getSession(sessionId);
                            if (!cur?.handle) return;
                            cur.handle.write('\x1b[Z');
                            setTimeout(() => verifyClineApprovalState(attempt + 1, headSeq), 800);
                        }, 250);
                    };
                    if (!readable) { failClosed(); return; } // 转录不可读 → 无法闭环验证
                    const stripped = stripAnsi(text).toLowerCase();
                    const state = parseApprovalState(stripped);
                    const promoDialogSeen = stripped.includes('clinepass is a');
                    if (promoDialogSeen) {
                        log.warn?.(`[loop-task-runner] run ${runId}: cline ClinePass promo dialog rendered during approval-state verification (attempt ${attempt})`);
                    }
                    if (state !== null && state === targetEnabled) { writePrompt(); return; }
                    if (attempt === 0) {
                        press(); // 初扫不在目标态（默认全开、手动象限为目标关）→ 按键
                        return;
                    }
                    if (attempt >= APPROVAL_VERIFY_MAX_ATTEMPTS) { failClosed(); return; }
                    press(); // 按键被吞（无新输出）/窗口内只有弹窗帧（状态未知）/明确非目标（弹窗吃了上一次 Shift+Tab）→ dismiss 后重试
                };
                if (task.agentId === 'cline') {
                    verifyClineApprovalState(0, 0);
                } else if (glmAutoAcceptInject) {
                    // glm-agent 自动批准象限：zai 交互 TUI 无 CLI 免审 flag，
                    // 靠官方快捷键 shift-tab 切 auto-accept。TUI 就绪后、prompt
                    // 注入前 PTY 注入 \x1b[Z 切模式（等 400ms 让 TUI 处理重绘，
                    // 避免模式切换吞掉 prompt 文本）。手动批准象限不发——TUI
                    // 默认逐个审批正是手动象限要的行为。
                    cur?.handle?.write('\x1b[Z');
                    setTimeout(writePrompt, 400);
                } else {
                    writePrompt();
                }
            };
            const bootStart = Date.now();
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
            //   ① 注入必须回显确认（committedAt 非空）且确认后出现过新的 agent
            //      输出（lastOutputAt > committedAt）——TUI 首帧/启动期的静默不算
            //      开工；注入始终被吞（未确认提交）时保持 running 直到执行超时，
            //      超时会抓终端尾打进 error 便于定位。
            //   ② 开工后输出静默 TURN_IDLE_MS（至少距注入 TURN_MIN_MS）→ 认为干完
            //      活：立即按 succeeded 收口；复核模式（requireReview）会话保留
            //      不退出，自动结束模式收口后退出会话。
            let warnedNoStart = false;
            // 完成判定：静默满足后进入异步收口。轨迹检查（agentStillWorking）
            // 显示仍在跑工具时，重建轮询等下一轮——不做同步重入，避免 DB 查询
            // 堵塞 interval 回调。
            const turnTick = () => {
                if (settled) { clearInterval(turnPoll); turnPoll = null; return; }
                if (injectedAt == null) return;
                if (committedAt == null) return; // 回显确认前不判定（假阳性：TUI 动画/弹窗重绘都会刷新 lastOutputAt）
                const live = sessionManager.getSession(sessionId);
                if (!live) return;
                const now = Date.now();
                if (now - committedAt < TURN_MIN_MS) return;
                const started = Number(live.lastOutputAt || 0) > committedAt;
                const lastOut = Number(live.lastOutputAt || live.lastActivityAt || injectedAt);
                if (now - lastOut < TURN_IDLE_MS) return;
                if (!started) {
                    if (!warnedNoStart) {
                        warnedNoStart = true;
                        log.warn?.(`[loop-task-runner] run ${runId}: no agent output after prompt injection — keep running until timeout (terminal tail will be captured)`);
                    }
                    return;
                }
                clearInterval(turnPoll);
                turnPoll = null;
                void (async () => {
                    try {
                        // 终端静默只是必要条件（可能正在执行长工具），轨迹最后
                        // 一步 finish_reason 为 tool_calls/tool_use = 模型还在
                        // 等工具结果跑，不判完成、下轮轮询再看。
                        if (await agentStillWorking(sessionId)) {
                            if (!settled) {
                                turnPoll = setInterval(turnTick, TURN_POLL_MS);
                                log.log?.(`[loop-task-runner] run ${runId}: terminal idle but last trajectory step is a tool call — still working`);
                            }
                            return;
                        }
                        // 干完即记成功：立即按 succeeded 收口（结果提取在 finalize 内）。
                        // 两种模式差别只在会话生命周期——复核模式（requireReview）
                        // 会话保留不退出，人工从侧栏打开查看/继续对话，空闲回收交给
                        // 既有 idle hibernate；自动结束模式收口后终止会话。
                        if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
                        await finalize('succeeded', null);
                        if (!reviewMode) await stopTaskSession(sessionId, log);
                        log.log?.(`[loop-task-runner] run ${runId} (task "${task.title}") → succeeded${reviewMode ? ' (session kept alive for human review)' : ' (session closed)'}`);
                    } catch (err) {
                        log.warn?.({ err, runId }, '[loop-task-runner] failed to complete interactive turn');
                    }
                })();
            };
            turnPoll = setInterval(turnTick, TURN_POLL_MS);
        }

        // 超时兜底（两种模式共用；干完活收口时会提前清除本定时器）：到点判 timeout
        // 并终止会话
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
