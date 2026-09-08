const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapTestDb } = require('../test/db');

let ctx;
let db;
let schema;
let runRepoCloneReap;

before(async () => {
    ctx = await bootstrapTestDb([
        '../db/index',
        './jobs',
    ], __dirname);
    ({ db, schema } = ctx);
    ({ runRepoCloneReap } = ctx.reloaded['./jobs']);
});

after(async () => {
    if (ctx) await ctx.teardown();
});

const STALE = Date.now() - 20 * 60_000; // 20 分钟前（超过 15 分钟阈值）
const FRESH = Date.now() - 60_000;      // 1 分钟前（正常进行中）

async function seedProject(id, name, cloneStatus, createdAt) {
    await db.insert(schema.users).values({
        id: `u_${id}`, username: id, passwordHash: 'x', passwordSalt: 'y',
        role: 'user', status: 'active', createdAt: Date.now(), updatedAt: Date.now(),
    }).onConflictDoNothing();
    await db.insert(schema.projects).values({
        id, userId: `u_${id}`, name, serverPath: '/tmp',
        cloneStatus, createdAt, remoteFullName: name,
    });
}

async function seedRepo(id, projectId, subPath, cloneStatus, updatedAt) {
    await db.insert(schema.projectRepos).values({
        id, projectId, role: 'custom', subPath,
        repoProvider: 'url', repoUrl: `https://x/${subPath}.git`,
        isPrimary: true, cloneStatus, createdAt: Date.now(), updatedAt,
    });
}

test('超时 cloning 的 repo 与 project 被收割为 failed', async () => {
    await seedProject('proj_reap1', 'reap1', 'cloning', STALE);
    await seedRepo('pr_reap1', 'proj_reap1', 'web', 'cloning', STALE);

    const reaped = await runRepoCloneReap({ log: { warn: () => {} } });

    assert.ok(reaped >= 1);
    const [repo] = await db.select().from(schema.projectRepos).where(
        require('drizzle-orm').eq(schema.projectRepos.id, 'pr_reap1'));
    assert.equal(repo.cloneStatus, 'failed');
    assert.match(repo.cloneError, /interrupted/);
    const [proj] = await db.select().from(schema.projects).where(
        require('drizzle-orm').eq(schema.projects.id, 'proj_reap1'));
    assert.equal(proj.cloneStatus, 'failed');
});

test('fresh cloning（正常进行中）不被误杀', async () => {
    await seedProject('proj_reap2', 'reap2', 'cloning', FRESH);
    await seedRepo('pr_reap2', 'proj_reap2', 'web', 'cloning', FRESH);

    await runRepoCloneReap({ log: { warn: () => {} } });

    const [repo] = await db.select().from(schema.projectRepos).where(
        require('drizzle-orm').eq(schema.projectRepos.id, 'pr_reap2'));
    assert.equal(repo.cloneStatus, 'cloning');
    const [proj] = await db.select().from(schema.projects).where(
        require('drizzle-orm').eq(schema.projects.id, 'proj_reap2'));
    assert.equal(proj.cloneStatus, 'cloning');
});

test('primary ready + secondary stale failed：project 收割，ready repo 不动', async () => {
    await seedProject('proj_reap3', 'reap3', 'cloning', STALE);
    await db.insert(schema.projectRepos).values({
        id: 'pr_reap3a', projectId: 'proj_reap3', role: 'custom', subPath: 'web',
        repoProvider: 'url', repoUrl: 'https://x/web.git',
        isPrimary: true, cloneStatus: 'ready', createdAt: STALE, updatedAt: STALE,
    });
    await seedRepo('pr_reap3b', 'proj_reap3', 'api', 'cloning', STALE);

    await runRepoCloneReap({ log: { warn: () => {} } });

    const [ready] = await db.select().from(schema.projectRepos).where(
        require('drizzle-orm').eq(schema.projectRepos.id, 'pr_reap3a'));
    assert.equal(ready.cloneStatus, 'ready'); // 已完成的不动
    const [failed] = await db.select().from(schema.projectRepos).where(
        require('drizzle-orm').eq(schema.projectRepos.id, 'pr_reap3b'));
    assert.equal(failed.cloneStatus, 'failed');
    const [proj] = await db.select().from(schema.projects).where(
        require('drizzle-orm').eq(schema.projects.id, 'proj_reap3'));
    assert.equal(proj.cloneStatus, 'failed'); // 有 failed repo → project failed
});
