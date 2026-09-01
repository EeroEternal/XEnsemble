const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { eq } = require('drizzle-orm');

const { bootstrapTestDb } = require('../test/db');

process.env.SCHEDULER_ENABLED = 'true';
process.env.CONVERSATION_SUMMARY_BATCH = '5';

let ctx;
let schema;
let db;
let SchedulerMod;

before(async () => {
    ctx = await bootstrapTestDb([
        '../db/index',
        '../db/schema',
    ], __dirname);
    ({ db, schema } = ctx);
    SchedulerMod = require('./index');
});

after(async () => {
    delete process.env.SCHEDULER_ENABLED;
    delete process.env.CONVERSATION_SUMMARY_BATCH;
    await SchedulerMod.stopScheduler();
    if (ctx) await ctx.teardown();
});

async function ensureJob(name, { nextRunAt = 0, lockedBy = null, lockedAt = null } = {}) {
    await db.insert(schema.schedulerJobs).values({
        jobName: name,
        lockedBy,
        lockedAt,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        nextRunAt,
    }).onConflictDoUpdate({
        target: schema.schedulerJobs.jobName,
        set: { lockedBy, lockedAt, nextRunAt, lastStatus: null, lastError: null },
    });
}

function makeJob(name, run) {
    return { name, intervalMs: 60000, run };
}

test('acquireLock succeeds when job is idle and returns true', async () => {
    await ensureJob('job-idle');
    const s = new SchedulerMod.Scheduler({ jobs: [], db, enabled: true });
    const ok = await s.acquireLock('job-idle', 1000);
    assert.equal(ok, true);

    const rows = await db.select().from(schema.schedulerJobs)
        .where(eq(schema.schedulerJobs.jobName, 'job-idle'));
    assert.equal(rows[0].lockedBy, s.id);
    assert.equal(rows[0].lockedAt, 1000);
    assert.equal(rows[0].lastRunAt, 1000);
});

test('acquireLock fails when locked by another instance recently', async () => {
    await ensureJob('job-locked', { lockedBy: 'other', lockedAt: Date.now() });
    const s = new SchedulerMod.Scheduler({ jobs: [], db, enabled: true });
    const ok = await s.acquireLock('job-locked', Date.now());
    assert.equal(ok, false);
});

test('acquireLock reclaims expired lock after timeout', async () => {
    const now = Date.now();
    await ensureJob('job-expired', { lockedBy: 'dead', lockedAt: now - 700_000 }); // > 10min timeout
    const s = new SchedulerMod.Scheduler({ jobs: [], db, enabled: true, lockTimeoutMs: 600_000 });
    const ok = await s.acquireLock('job-expired', now);
    assert.equal(ok, true);
});

test('tick runs due job, marks ok and schedules next run', async () => {
    await ensureJob('job-run', { nextRunAt: 0 });
    let runs = 0;
    const s = new SchedulerMod.Scheduler({
        jobs: [makeJob('job-run', async () => { runs += 1; })],
        db,
        enabled: true,
    });
    await s.tick();
    assert.equal(runs, 1);

    const rows = await db.select().from(schema.schedulerJobs)
        .where(eq(schema.schedulerJobs.jobName, 'job-run'));
    assert.equal(rows[0].lastStatus, 'ok');
    assert.ok(rows[0].nextRunAt > 0);
});

test('tick does not run job that is not due', async () => {
    await ensureJob('job-notdue', { nextRunAt: Date.now() + 60_000 });
    let runs = 0;
    const s = new SchedulerMod.Scheduler({
        jobs: [makeJob('job-notdue', async () => { runs += 1; })],
        db,
        enabled: true,
    });
    await s.tick();
    assert.equal(runs, 0);
});

test('job error records last_error and does not break next tick', async () => {
    await ensureJob('job-err', { nextRunAt: 0 });
    const s = new SchedulerMod.Scheduler({
        jobs: [makeJob('job-err', async () => { throw new Error('boom'); })],
        db,
        enabled: true,
    });
    await s.tick(); // should not throw
    await s.tick();

    const rows = await db.select().from(schema.schedulerJobs)
        .where(eq(schema.schedulerJobs.jobName, 'job-err'));
    assert.equal(rows[0].lastStatus, 'error');
    assert.match(rows[0].lastError, /boom/);
});

test('SCHEDULER_ENABLED=false makes start() a no-op', async () => {
    process.env.SCHEDULER_ENABLED = 'false';
    try {
        const s = new SchedulerMod.Scheduler({ jobs: [makeJob('job-x', async () => {})], db, enabled: true });
        s.start();
        assert.equal(s.timer, null);
    } finally {
        process.env.SCHEDULER_ENABLED = 'true';
    }
});

test('startScheduler/stopScheduler manage the singleton', async () => {
    const s = await SchedulerMod.startScheduler({ db, tickMs: 1e9 });
    assert.ok(s);
    const s2 = await SchedulerMod.startScheduler({ db, tickMs: 1e9 });
    assert.equal(s2, s); // idempotent
    await SchedulerMod.stopScheduler(); // stop before assertion to avoid dangling timer
    const status = await SchedulerMod.getSchedulerStatus();
    assert.ok(Array.isArray(status));
});
