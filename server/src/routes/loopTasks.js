/**
 * LoopTask REST 路由（Task Automation，Architecture.md §5.3）。
 *
 * 端点概览：
 *  - GET    /api/v1/loop-tasks                  当前用户任务列表
 *  - POST   /api/v1/loop-tasks                  创建（校验 workspace 归属 + cron 合法）
 *  - PATCH  /api/v1/loop-tasks/:id              编辑 / 暂停恢复（status）
 *  - DELETE /api/v1/loop-tasks/:id              删除（级联删 runs）
 *  - POST   /api/v1/loop-tasks/:id/run-now      立即执行一次（同样幂等 + 防重入）
 *  - GET    /api/v1/loop-tasks/:id/runs         执行历史（最新 50 条）
 *
 * 执行模型：Run 由 loop-task-runner（Scheduler job）触发，在项目沙箱内创建真实
 * Agent 会话执行（用户的 Agent + 用户的模型额度，headless 一次性模式，
 * 见 loopTasks/runner.js 与 session/createAgentSession.js）。
 */

const crypto = require('crypto');
const { and, desc, eq, inArray } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');
const { sendPublicError } = require('../http/publicError');
const { t } = require('../i18n');
const { validateCron, describeSchedule, computeNextRunAt, MIN_INTERVAL_MS, MAX_INTERVAL_MS } = require('../loopTasks/cron');
const runner = require('../loopTasks/runner');
const policy = require('../auth/PolicyService');
const { isTaskRunSupported } = require('../agents/taskRunModes');

const MAX_TASKS_PER_USER = Number(process.env.LOOP_TASK_MAX_PER_USER) || 12;

// 时区接受任意合法 IANA 名称（覆盖用户全局偏好的所有条目），非法值回退。
// 此前是 11 项硬编码白名单——不在表内的全局偏好会被静默回退 UTC，属隐患。
const SUPPORTED_TZ = new Set(
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [],
);

function isValidTimezone(tz) {
    if (SUPPORTED_TZ.size) return SUPPORTED_TZ.has(tz);
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function normalizeTimezone(value, fallback) {
    const tz = String(value ?? '').trim();
    return tz && isValidTimezone(tz) ? tz : fallback;
}

function httpError(statusCode, code, message) {
    const err = new Error(message);
    err.statusCode = statusCode;
    err.code = code;
    return err;
}

function loopError(locale, code, params = {}, statusCode = 400) {
    return httpError(statusCode, code, t(`errors:${code}`, params, locale));
}

function scheduleDescription(task, locale) {
    try {
        return describeSchedule(task, locale);
    } catch {
        return null;
    }
}

// 任务列表内联展示的最近 run 摘要上限：表格只显示一行，完整内容看执行历史
const LAST_RUN_SUMMARY_MAX_CHARS = 200;

/** 最近 run 摘要：压成单行并截断（表格单元格只放一行文本） */
function summarizeRunText(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    return s.length > LAST_RUN_SUMMARY_MAX_CHARS ? `${s.slice(0, LAST_RUN_SUMMARY_MAX_CHARS)}…` : s;
}

function serializeTask(row, locale = 'en', lastRun = null) {
    let desc = scheduleDescription(row, locale);
    // 工作日感知任务：描述补充日历语义（节假日跳过 / 调休补班照跑）
    if (desc && row.holidayAware === true && (row.scheduleKind || 'cron') === 'cron') {
        desc += locale?.startsWith('zh')
            ? '（按中国法定日历：节假日跳过，调休补班照常）'
            : ' (CN holiday-aware: skips statutory holidays, runs on makeup workdays)';
    }
    return {
        id: row.id,
        userId: row.userId,
        projectId: row.projectId,
        title: row.title,
        prompt: row.prompt,
        agentId: row.agentId ?? null,
        autoApprove: row.autoApprove !== false,
        holidayAware: row.holidayAware === true,
        scheduleKind: row.scheduleKind || 'cron',
        cronExpr: row.cronExpr,
        timezone: row.timezone,
        intervalMs: row.intervalMs ?? null,
        status: row.status,
        scheduleDescription: desc,
        nextRunAt: row.nextRunAt ?? null,
        lastRunAt: row.lastRunAt ?? null,
        // 最近一次 run 概要（列表直接可见成败，不必进历史弹窗；完整内容仍走 /runs）
        lastRun: lastRun ? {
            status: lastRun.status,
            startedAt: lastRun.startedAt ?? null,
            finishedAt: lastRun.finishedAt ?? null,
            result: summarizeRunText(lastRun.result),
            error: summarizeRunText(lastRun.error),
        } : null,
        createdAt: row.createdAt ?? null,
        updatedAt: row.updatedAt ?? null,
    };
}

function serializeRun(row) {
    return {
        id: row.id,
        taskId: row.taskId,
        scheduledFor: row.scheduledFor ?? null,
        status: row.status,
        sessionId: row.sessionId ?? null,
        agentId: row.agentId ?? null,
        rounds: row.rounds ?? null,
        logs: Array.isArray(row.logs) ? row.logs.slice(-200) : [],
        result: row.result ?? null,
        error: row.error ?? null,
        startedAt: row.startedAt ?? null,
        finishedAt: row.finishedAt ?? null,
    };
}

/**
 * 执行 Agent 校验：必填 + 用户可用 + 支持无人值守一次性执行。
 * 不满足任一条（含存量 NULL）都拒绝——无 TaskAgent 兜底。
 */
async function validateTaskAgent(userId, userRole, agentId, locale) {
    if (!agentId) throw loopError(locale, 'loop_agent_required', {}, 400);
    const access = await policy.checkAgentAccess(userId, agentId, userRole);
    if (!access.ok) {
        throw httpError(403, 'agent_not_available', access.error || t('errors:agent_not_found', {}, locale));
    }
    if (!isTaskRunSupported(agentId)) {
        throw loopError(locale, 'agent_task_unsupported', {}, 400);
    }
}

async function getOwnedTask(taskId, userId, locale) {
    const rows = await db.select().from(schema.loopTasks)
        .where(and(eq(schema.loopTasks.id, taskId), eq(schema.loopTasks.userId, userId)))
        .limit(1);
    if (rows.length === 0) {
        throw loopError(locale, 'loop_task_not_found', {}, 404);
    }
    return rows[0];
}

function parseRunAt(value) {
    if (value == null) return NaN;
    // 接受 epoch ms 或 ISO 8601 字符串
    if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return Date.parse(value);
    return Number(value);
}

/**
 * 解析调度参数（三种类型：cron / every / at）。
 * existing 用于 PATCH 时回填未传字段；无 existing（POST）时给默认值。
 */
function parseSchedule(body, existing, locale) {
    const kind = ['cron', 'every', 'at'].includes(String(body?.kind))
        ? String(body.kind)
        : (existing?.scheduleKind || 'cron');
    const timezone = normalizeTimezone(body?.timezone, String(existing?.timezone || 'UTC'));

    const draft = {
        scheduleKind: kind,
        timezone,
        cronExpr: String(body?.cronExpr ?? body?.cron_expr ?? existing?.cronExpr ?? '* * * * *').trim(),
        intervalMs: body?.intervalMs != null ? Number(body.intervalMs) : (existing?.intervalMs ?? null),
        holidayAware: body?.holidayAware !== undefined
            ? Boolean(body.holidayAware)
            : Boolean(existing?.holidayAware),
        nextRunAt: existing?.nextRunAt ?? 0,
    };

    if (kind === 'every') {
        const interval = Number(draft.intervalMs);
        if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS || interval > MAX_INTERVAL_MS) {
            throw loopError(locale, 'loop_interval_invalid', {
                min: Math.round(MIN_INTERVAL_MS / 60_000),
                max: Math.round(MAX_INTERVAL_MS / 86_400_000),
            });
        }
        draft.intervalMs = interval;
        draft.nextRunAt = Date.now() + interval;
    } else if (kind === 'at') {
        const runAt = parseRunAt(body?.runAt ?? body?.run_at ?? existing?.nextRunAt);
        if (!Number.isFinite(runAt)) throw loopError(locale, 'loop_schedule_past');
        if (runAt <= Date.now()) throw loopError(locale, 'loop_schedule_past');
        draft.nextRunAt = runAt;
    } else {
        try {
            draft.cronExpr = validateCron(draft.cronExpr);
        } catch (err) {
            throw loopError(locale, 'loop_cron_invalid', { message: String(err?.message || err).slice(0, 200) });
        }
    }

    // 语法/参数校验完成后统一算 next_run_at（at 已在上方确定）
    // holidayAware 的 cron 任务走工作日日历（computeNextRunAt 内部自动降级）
    try {
        draft.nextRunAt = kind === 'at'
            ? draft.nextRunAt
            : computeNextRunAt(draft, new Date());
    } catch (err) {
        throw loopError(locale, err?.code === 'loop_interval_invalid' ? 'loop_interval_invalid' : 'loop_cron_invalid', {
            message: String(err?.message || err).slice(0, 200),
            min: Math.round(MIN_INTERVAL_MS / 60_000),
            max: Math.round(MAX_INTERVAL_MS / 86_400_000),
        });
    }
    return draft;
}

function registerLoopTaskRoutes(fastify) {
    const authPre = [fastify.authenticate];

    fastify.get('/api/v1/loop-tasks', { preValidation: authPre }, async (request) => {
        const locale = request.locale || 'en';
        const rows = await db.select().from(schema.loopTasks)
            .where(eq(schema.loopTasks.userId, request.user.id))
            .orderBy(desc(schema.loopTasks.createdAt));

        // 每个任务取最近一条 run（DISTINCT ON + started_at 排序），列表内联展示成败
        const taskIds = rows.map((row) => row.id);
        let lastRuns = [];
        if (taskIds.length > 0) {
            lastRuns = await db.selectDistinctOn([schema.loopTaskRuns.taskId], {
                taskId: schema.loopTaskRuns.taskId,
                status: schema.loopTaskRuns.status,
                result: schema.loopTaskRuns.result,
                error: schema.loopTaskRuns.error,
                startedAt: schema.loopTaskRuns.startedAt,
                finishedAt: schema.loopTaskRuns.finishedAt,
            })
                .from(schema.loopTaskRuns)
                .where(inArray(schema.loopTaskRuns.taskId, taskIds))
                .orderBy(schema.loopTaskRuns.taskId, desc(schema.loopTaskRuns.startedAt));
        }
        const lastRunByTask = new Map(lastRuns.map((run) => [run.taskId, run]));
        return { tasks: rows.map((row) => serializeTask(row, locale, lastRunByTask.get(row.id) || null)) };
    });

    // 调度实时预览（弹窗输入防抖调用）：三种类型的人类可读描述或行内错误
    fastify.post('/api/v1/loop-tasks/schedule-preview', { preValidation: authPre }, async (request, reply) => {
        const locale = request.locale || 'en';
        const body = request.body || {};
        const kind = ['cron', 'every', 'at'].includes(String(body?.kind)) ? String(body.kind) : 'cron';
        if (kind === 'at' && (body?.runAt == null || Number.isNaN(parseRunAt(body.runAt)))) {
            return { description: null };
        }
        const draft = {
            scheduleKind: kind,
            timezone: normalizeTimezone(body?.timezone, 'UTC'),
            cronExpr: String(body?.cronExpr ?? '').trim(),
            intervalMs: body?.intervalMs != null ? Number(body.intervalMs) : null,
            nextRunAt: kind === 'at' ? parseRunAt(body.runAt) : 0,
        };
        if (kind === 'at' && draft.nextRunAt <= Date.now()) {
            return reply.code(200).send({
                description: null,
                valid: false,
                error: t('errors:loop_schedule_past', {}, locale),
            });
        }
        try {
            if (kind !== 'at' && kind !== 'every') validateCron(draft.cronExpr); // 语法错误 → 行内红字
            return { description: describeSchedule(draft, locale) }; // 结构不支持时为 null，前端隐藏描述行
        } catch (err) {
            const code = err?.code === 'loop_interval_invalid' ? 'loop_interval_invalid' : 'loop_cron_invalid';
            return reply.code(200).send({
                description: null,
                valid: false,
                error: t(`errors:${code}`, {
                    message: String(err?.message || err).slice(0, 200),
                    min: Math.round(MIN_INTERVAL_MS / 60_000),
                    max: Math.round(MAX_INTERVAL_MS / 86_400_000),
                }, locale),
            });
        }
    });

    fastify.post('/api/v1/loop-tasks', { preValidation: authPre }, async (request, reply) => {
        const locale = request.locale || 'en';
        try {
            const body = request.body || {};
            const title = String(body.title || '').trim();
            const prompt = String(body.prompt || '').trim();
            const projectId = String(body.projectId || body.project_id || '').trim();
            if (!title) throw loopError(locale, 'loop_field_required', { field: 'title' });
            if (!prompt) throw loopError(locale, 'loop_field_required', { field: 'prompt' });
            if (!projectId) throw loopError(locale, 'loop_field_required', { field: 'workspace' });

            // workspace 归属校验
            const projects = await db.select({ id: schema.projects.id })
                .from(schema.projects)
                .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, request.user.id)))
                .limit(1);
            if (projects.length === 0) {
                throw httpError(404, 'project_not_found', t('errors:project_not_found', {}, locale));
            }

            // 数量上限（防滥用；CodeArts 同类产品为每项目 3 个，此处放宽为每用户）
            const existing = await db.select({ id: schema.loopTasks.id })
                .from(schema.loopTasks)
                .where(eq(schema.loopTasks.userId, request.user.id));
            if (existing.length >= MAX_TASKS_PER_USER) {
                throw loopError(locale, 'loop_task_limit_exceeded', { limit: MAX_TASKS_PER_USER });
            }

            const schedule = parseSchedule(body, null, locale);

            // 执行 Agent（必填）+ 无人值守自动批准
            const agentId = String(body.agentId || body.agent_id || '').trim();
            await validateTaskAgent(request.user.id, request.user.role, agentId, locale);
            const autoApprove = body.autoApprove !== undefined ? Boolean(body.autoApprove) : true;

            const now = Date.now();
            const task = {
                id: `lt_${crypto.randomBytes(8).toString('hex')}`,
                userId: request.user.id,
                projectId,
                title,
                prompt,
                agentId,
                autoApprove,
                holidayAware: schedule.holidayAware === true,
                scheduleKind: schedule.scheduleKind,
                cronExpr: schedule.cronExpr,
                timezone: schedule.timezone,
                intervalMs: schedule.scheduleKind === 'every' ? schedule.intervalMs : null,
                status: 'active',
                nextRunAt: schedule.nextRunAt,
                createdAt: now,
                updatedAt: now,
            };
            await db.insert(schema.loopTasks).values(task);
            return reply.code(201).send(serializeTask(task, locale));
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to create loop task', 500, locale);
        }
    });

    fastify.patch('/api/v1/loop-tasks/:id', { preValidation: authPre }, async (request, reply) => {
        const locale = request.locale || 'en';
        try {
            const task = await getOwnedTask(request.params.id, request.user.id, locale);
            const body = request.body || {};
            const patch = { updatedAt: Date.now() };

            if (body.title !== undefined) {
                const title = String(body.title || '').trim();
                if (!title) throw loopError(locale, 'loop_field_required', { field: 'title' });
                patch.title = title;
            }
            if (body.prompt !== undefined) {
                const prompt = String(body.prompt || '').trim();
                if (!prompt) throw loopError(locale, 'loop_field_required', { field: 'prompt' });
                patch.prompt = prompt;
            }
            if (body.status !== undefined) {
                const status = String(body.status);
                if (!['active', 'paused'].includes(status)) {
                    throw httpError(400, 'operation_not_permitted', t('errors:operation_not_permitted', {}, locale));
                }
                patch.status = status;
            }

            if (body.agentId !== undefined || body.agent_id !== undefined) {
                const agentId = String(body.agentId ?? body.agent_id ?? '').trim();
                await validateTaskAgent(request.user.id, request.user.role, agentId, locale);
                patch.agentId = agentId;
            }
            if (body.autoApprove !== undefined) {
                patch.autoApprove = Boolean(body.autoApprove);
            }

            // 调度字段变更（含工作日感知开关），或恢复 active → 重算 next_run_at
            const scheduleChanged = body.kind !== undefined || body.cronExpr !== undefined || body.cron_expr !== undefined
                || body.intervalMs !== undefined || body.runAt !== undefined || body.run_at !== undefined
                || body.timezone !== undefined || body.holidayAware !== undefined;
            if (scheduleChanged) {
                const schedule = parseSchedule(body, task, locale);
                patch.scheduleKind = schedule.scheduleKind;
                patch.cronExpr = schedule.cronExpr;
                patch.timezone = schedule.timezone;
                patch.intervalMs = schedule.scheduleKind === 'every' ? schedule.intervalMs : null;
                patch.holidayAware = schedule.holidayAware === true;
                patch.nextRunAt = schedule.nextRunAt;
            } else if (patch.status === 'active' && task.status !== 'active') {
                // 恢复：按当前类型重算（at 类型目标时间已过 → 明确报错）
                const schedule = parseSchedule({}, task, locale);
                patch.nextRunAt = schedule.nextRunAt;
            }

            const updated = await db.update(schema.loopTasks)
                .set(patch)
                .where(eq(schema.loopTasks.id, task.id))
                .returning();
            return serializeTask(updated[0] || task, locale);
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to update loop task', 500, locale);
        }
    });

    fastify.delete('/api/v1/loop-tasks/:id', { preValidation: authPre }, async (request, reply) => {
        const locale = request.locale || 'en';
        try {
            const task = await getOwnedTask(request.params.id, request.user.id, locale);
            await db.delete(schema.loopTasks).where(eq(schema.loopTasks.id, task.id));
            return reply.code(204).send();
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to delete loop task', 500, locale);
        }
    });

    fastify.post('/api/v1/loop-tasks/:id/run-now', { preValidation: authPre }, async (request, reply) => {
        const locale = request.locale || 'en';
        try {
            const task = await getOwnedTask(request.params.id, request.user.id, locale);

            // 防重入：上一次 run 仍在跑
            const active = await db.select({ id: schema.loopTaskRuns.id })
                .from(schema.loopTaskRuns)
                .where(and(eq(schema.loopTaskRuns.taskId, task.id), eq(schema.loopTaskRuns.status, 'running')))
                .limit(1);
            if (active.length > 0) {
                throw loopError(locale, 'loop_run_in_progress', {}, 409);
            }

            const now = Date.now();
            const runId = `ltr_${crypto.randomBytes(8).toString('hex')}`;
            const inserted = await db.insert(schema.loopTaskRuns)
                .values({
                    id: runId,
                    taskId: task.id,
                    scheduledFor: now,
                    status: 'running',
                    startedAt: now,
                    logs: [],
                })
                .onConflictDoNothing({ target: [schema.loopTaskRuns.taskId, schema.loopTaskRuns.scheduledFor] })
                .returning({ id: schema.loopTaskRuns.id });
            if (inserted.length === 0) {
                throw loopError(locale, 'loop_run_in_progress', {}, 409);
            }
            await db.update(schema.loopTasks)
                .set({ lastRunAt: now, updatedAt: now })
                .where(eq(schema.loopTasks.id, task.id));

            void runner.executeRun(task, { id: runId }, console); // 异步执行
            return reply.code(202).send({ runId, status: 'running' });
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to run loop task', 500, locale);
        }
    });

    fastify.get('/api/v1/loop-tasks/:id/runs', { preValidation: authPre }, async (request, reply) => {
        const locale = request.locale || 'en';
        try {
            const task = await getOwnedTask(request.params.id, request.user.id, locale);
            const rows = await db.select().from(schema.loopTaskRuns)
                .where(eq(schema.loopTaskRuns.taskId, task.id))
                .orderBy(desc(schema.loopTaskRuns.startedAt))
                .limit(50);
            return { runs: rows.map(serializeRun) };
        } catch (err) {
            return sendPublicError(reply, err, 'Failed to list loop task runs', 500, locale);
        }
    });
}

module.exports = { registerLoopTaskRoutes };
