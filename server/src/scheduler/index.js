/**
 * 进程内调度器（P2）——PG 乐观锁，多实例安全。
 *
 * - 每 30s tick 一次，检查各 job 的 next_run_at 是否到期。
 * - 到期 job 通过单条 UPDATE ... RETURNING 抢锁；抢到才执行。
 * - 执行完成后写 last_run_at / last_status / last_error / next_run_at。
 * - SCHEDULER_ENABLED=false 时 start() 为 no-op。
 *
 * 实例 id：`process.pid + '-' + randomUUID 前 8 位`，用于锁归属标识。
 */

const { randomUUID } = require('crypto');
const { eq, sql } = require('drizzle-orm');
const schema = require('../db/schema');

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 600_000; // 10 分钟：防实例崩溃后死锁

function instanceId() {
    return `${process.pid}-${randomUUID().slice(0, 8)}`;
}

/**
 * @param {object} opts
 * @param {Array<{name: string, intervalMs: number, run: (ctx: object) => Promise<void>}>} opts.jobs
 * @param {import('drizzle-orm/postgres-js').PostgresJsDatabase} [opts.db] 默认 require('../db').db
 * @param {number} [opts.tickMs]
 * @param {number} [opts.lockTimeoutMs]
 */
class Scheduler {
    constructor({ jobs = [], db, tickMs = DEFAULT_TICK_MS, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, enabled = true } = {}) {
        this.jobs = jobs;
        this.db = db || require('../db').db;
        this.tickMs = tickMs;
        this.lockTimeoutMs = lockTimeoutMs;
        this.enabled = enabled && process.env.SCHEDULER_ENABLED !== 'false';
        this.id = instanceId();
        this.timer = null;
        this.running = false;
        this.stopped = false;
        // jobName -> boolean：当前轮正在执行，防 tick 重入
        this.inFlight = new Set();
    }

    start() {
        if (!this.enabled || this.timer) return;
        this.stopped = false;
        // 首轮由定时器触发（不立即 tick）：避免测试 teardown 时仍有在途查询。
        this.timer = setInterval(() => void this.tick(), this.tickMs);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        // 释放当前实例持有的锁（best-effort）
        for (const job of this.jobs) {
            void this.releaseLock(job.name).catch(() => {});
        }
    }

    async tick() {
        if (this.running || this.stopped) return;
        this.running = true;
        try {
            const now = Date.now();
            for (const job of this.jobs) {
                if (this.stopped) break;
                if (this.inFlight.has(job.name)) continue;
                const due = await this.isDue(job.name, now);
                if (!due) continue;
                const acquired = await this.acquireLock(job.name, now);
                if (!acquired) continue;
                this.inFlight.add(job.name);
                try {
                    await job.run({ db: this.db, scheduler: this });
                    await this.markSuccess(job, now);
                } catch (err) {
                    await this.markError(job, now, err);
                } finally {
                    this.inFlight.delete(job.name);
                    await this.releaseLock(job.name).catch(() => {});
                }
            }
        } catch (err) {
            // 单轮调度异常不致命（DB 抖动等），下轮重试
            // eslint-disable-next-line no-console
            console.error('[scheduler] tick failed:', err?.message || err);
        } finally {
            this.running = false;
        }
    }

    async isDue(jobName, now) {
        const rows = await this.db
            .select({ nextRunAt: schema.schedulerJobs.nextRunAt })
            .from(schema.schedulerJobs)
            .where(eq(schema.schedulerJobs.jobName, jobName))
            .limit(1);
        if (rows.length === 0) return false;
        return Number(rows[0].nextRunAt) <= now;
    }

    /**
     * 单条 UPDATE ... RETURNING 乐观锁（规格 §5）：
     *   UPDATE scheduler_jobs
     *   SET locked_by=$id, locked_at=$now, last_run_at=$now
     *   WHERE job_name=$name AND (locked_at IS NULL OR locked_at < $now - $lockTimeoutMs)
     *   RETURNING job_name
     * 抢到返回 true（有 RETURNING 行），否则 false。
     */
    async acquireLock(jobName, now) {
        const rows = await this.db.execute(sql`
            UPDATE scheduler_jobs
            SET locked_by = ${this.id}, locked_at = ${now}, last_run_at = ${now}
            WHERE job_name = ${jobName}
              AND (locked_at IS NULL OR locked_at < ${now - this.lockTimeoutMs})
            RETURNING job_name
        `);
        return (rows?.length ?? 0) > 0;
    }

    /**
     * 释放锁：locked_by/locked_at 置空。
     */
    async releaseLock(jobName) {
        await this.db
            .update(schema.schedulerJobs)
            .set({ lockedBy: null, lockedAt: null })
            .where(eq(schema.schedulerJobs.jobName, jobName));
    }

    async markSuccess(job, now) {
        await this.db
            .update(schema.schedulerJobs)
            .set({
                lastStatus: 'ok',
                lastError: null,
                nextRunAt: now + job.intervalMs,
            })
            .where(eq(schema.schedulerJobs.jobName, job.name));
    }

    async markError(job, now, err) {
        await this.db
            .update(schema.schedulerJobs)
            .set({
                lastStatus: 'error',
                lastError: String(err?.message || err).slice(0, 500),
                nextRunAt: now + job.intervalMs,
            })
            .where(eq(schema.schedulerJobs.jobName, job.name));
    }
}

// ---------------------------------------------------------------------------
// 模块级单例（对齐 TranscriptStore / SessionManager 的仓库单例习惯）
// ---------------------------------------------------------------------------

let activeScheduler = null;
let activeJobs = [];

/**
 * 启动全局 scheduler。幂等：已启动则直接返回。
 * @param {object} [opts] 透传给 Scheduler（jobs 默认用 createJobs()）
 */
async function startScheduler(opts = {}) {
    if (activeScheduler) return activeScheduler;
    if (process.env.SCHEDULER_ENABLED === 'false') return null;
    const { createJobs } = require('./jobs');
    activeJobs = opts.jobs || createJobs();
    activeScheduler = new Scheduler({
        jobs: activeJobs,
        db: opts.db,
        tickMs: opts.tickMs,
    });
    activeScheduler.start();
    return activeScheduler;
}

/**
 * 停止全局 scheduler（释放锁 + 清定时器）。
 */
async function stopScheduler() {
    if (activeScheduler) {
        activeScheduler.stop();
        activeScheduler = null;
        activeJobs = [];
    }
}

/**
 * 读取所有 job 的状态（供 Admin API）。
 * @returns {Promise<Array>} job 状态数组（缺行时按已注册 job 名补齐）
 */
async function getSchedulerStatus() {
    const { db } = require('../db');
    const { eq } = require('drizzle-orm');
    const schema = require('../db/schema');
    const rows = await db.select().from(schema.schedulerJobs);
    const byName = new Map(rows.map((r) => [r.jobName, r]));
    const names = new Set([
        ...activeJobs.map((j) => j.name),
        ...byName.keys(),
        'conversation-summarize',
        'skill-pipeline',
    ]);
    return [...names].map((name) => {
        const r = byName.get(name);
        return {
            jobName: name,
            lockedBy: r?.lockedBy ?? null,
            lockedAt: r?.lockedAt ?? null,
            lastRunAt: r?.lastRunAt ?? null,
            lastStatus: r?.lastStatus ?? null,
            lastError: r?.lastError ?? null,
            nextRunAt: r?.nextRunAt ?? null,
        };
    });
}

/**
 * 手动触发某个 job 立即执行一次（Admin 调试）。
 * @param {string} jobName
 * @returns {Promise<boolean>} 是否已触发（job 未注册返回 false）
 */
async function triggerJob(jobName) {
    const job = activeJobs.find((j) => j.name === jobName);
    if (!job || !activeScheduler) return false;
    // 直接在实例 id 下执行，跳过锁判定（Admin 明确触发的调试路径）；
    // 复用 Scheduler 的执行管线以保证 last_status/next_run_at 正确。
    const now = Date.now();
    const acquired = await activeScheduler.acquireLock(jobName, now);
    if (!acquired) return 'locked';
    try {
        await job.run({ db: activeScheduler.db, scheduler: activeScheduler });
        await activeScheduler.markSuccess(job, now);
        return true;
    } catch (err) {
        await activeScheduler.markError(job, now, err);
        return 'error';
    } finally {
        await activeScheduler.releaseLock(jobName).catch(() => {});
    }
}

module.exports = {
    Scheduler,
    instanceId,
    DEFAULT_TICK_MS,
    DEFAULT_LOCK_TIMEOUT_MS,
    startScheduler,
    stopScheduler,
    getSchedulerStatus,
    triggerJob,
};
