const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { eq } = require('drizzle-orm');

const { bootstrapTestDb } = require('../test/db');

let ctx;
let schema;
let db;
let svc;

before(async () => {
    ctx = await bootstrapTestDb([
        '../db/index',
        '../db/schema',
        './skillService',
    ], __dirname);
    ({ db, schema } = ctx);
    svc = ctx.reloaded['./skillService'];
});

after(async () => {
    if (ctx) await ctx.teardown();
});

async function makeUser() {
    const id = `user_${randomUUID()}`;
    const now = Date.now();
    await db.insert(schema.users).values({
        id,
        username: `u_${randomUUID().slice(0, 8)}`,
        passwordHash: 'hash',
        role: 'user',
        status: 'active',
        createdAt: now,
        updatedAt: now,
    });
    return id;
}

test('createSkill creates a private draft with normalized tags', async () => {
    const userId = await makeUser();
    const skill = await svc.createSkill({
        userId,
        title: '  跑通 PostgreSQL 迁移  ',
        content: '标准流程',
        tags: ['drizzle', '', 'postgres', 'drizzle'],
        category: 'database',
    });
    assert.match(skill.id, /^skl_/);
    assert.equal(skill.title, '跑通 PostgreSQL 迁移');
    assert.deepEqual(skill.tags, ['drizzle', 'postgres']);
    assert.equal(skill.status, 'draft');
    assert.equal(skill.visibility, 'private');
    assert.equal(skill.category, 'database');
    assert.equal(skill.source, 'manual');
});

test('createSkill rejects missing title / over-long title', async () => {
    const userId = await makeUser();
    await assert.rejects(
        () => svc.createSkill({ userId, title: '', content: 'x' }),
        (e) => e.code === 'skill_validation_failed',
    );
    await assert.rejects(
        () => svc.createSkill({ userId, title: 'x'.repeat(101), content: 'x' }),
        (e) => e.code === 'skill_validation_failed',
    );
});

test('updateSkill edits fields but keeps status', async () => {
    const userId = await makeUser();
    const skill = await svc.createSkill({ userId, title: 't', content: 'c' });
    const updated = await svc.updateSkill(userId, skill.id, { title: 't2', tags: ['a', 'b'] });
    assert.equal(updated.title, 't2');
    assert.deepEqual(updated.tags, ['a', 'b']);
    assert.equal(updated.status, 'draft');
});

test('changeStatus follows state machine and rejects illegal transitions', async () => {
    const userId = await makeUser();
    const skill = await svc.createSkill({ userId, title: 't', content: 'c' });

    const active = await svc.changeStatus(userId, skill.id, 'activate');
    assert.equal(active.status, 'active');

    const archived = await svc.changeStatus(userId, skill.id, 'archive');
    assert.equal(archived.status, 'archived');

    const restored = await svc.changeStatus(userId, skill.id, 'restore');
    assert.equal(restored.status, 'active');

    // draft->archived illegal
    const skill2 = await svc.createSkill({ userId, title: 't2', content: 'c' });
    await assert.rejects(
        () => svc.changeStatus(userId, skill2.id, 'archive'),
        (e) => e.code === 'skill_invalid_transition',
    );
});

test('getSkill forbids cross-user access to private skill', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const skill = await svc.createSkill({ userId: owner, title: 'private', content: 'c' });
    await assert.rejects(
        () => svc.getSkill(other, skill.id),
        (e) => e.code === 'skill_not_found',
    );
    // owner can read
    const seen = await svc.getSkill(owner, skill.id);
    assert.equal(seen.id, skill.id);
});

test('publish/unpublish toggles market visibility', async () => {
    const userId = await makeUser();
    const skill = await svc.createSkill({ userId, title: 'public skill', content: 'c', category: 'workflow' });

    const published = await svc.publishSkill(userId, skill.id);
    assert.equal(published.visibility, 'public');
    assert.ok(published.publishedAt > 0);

    // now visible in market
    const market = await svc.listMarket({});
    assert.ok(market.items.some((s) => s.id === skill.id));

    const unpublished = await svc.unpublishSkill(userId, skill.id);
    assert.equal(unpublished.visibility, 'private');
    assert.equal(unpublished.publishedAt, null);

    const marketAfter = await svc.listMarket({});
    assert.ok(!marketAfter.items.some((s) => s.id === skill.id));
});

test('listMarket filters by category and q, paginates', async () => {
    const userId = await makeUser();
    const a = await svc.createSkill({ userId, title: 'DB 迁移', content: 'migration', category: 'database' });
    const b = await svc.createSkill({ userId, title: 'Git 规范', content: 'commit', category: 'workflow' });
    await svc.publishSkill(userId, a.id);
    await svc.publishSkill(userId, b.id);

    const dbOnly = await svc.listMarket({ category: 'database' });
    assert.equal(dbOnly.items.length, 1);
    assert.equal(dbOnly.items[0].id, a.id);

    const search = await svc.listMarket({ q: 'Git' });
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0].id, b.id);

    const page = await svc.listMarket({ page: 1, pageSize: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 1);
});

test('installSkill copies a public skill to private draft and bumps install_count', async () => {
    const owner = await makeUser();
    const installer = await makeUser();
    const source = await svc.createSkill({ userId: owner, title: '共享技能', content: 'content', tags: ['x'], category: 'debug' });
    await svc.publishSkill(owner, source.id);

    const installed = await svc.installSkill(installer, source.id);
    assert.equal(installed.userId, installer);
    assert.equal(installed.status, 'draft');
    assert.equal(installed.source, 'installed');
    assert.equal(installed.forkedFrom, source.id);
    assert.equal(installed.title, '共享技能');
    assert.equal(installed.visibility, 'private');

    const updated = await svc.getSkill(owner, source.id);
    assert.equal(updated.installCount, 1);

    // market still returns source
    const market = await svc.listMarket({});
    assert.ok(market.items.some((s) => s.id === source.id));
});

test('installSkill rejects private / unpublished skill', async () => {
    const owner = await makeUser();
    const installer = await makeUser();
    const privateSkill = await svc.createSkill({ userId: owner, title: '私有', content: 'c' });
    await assert.rejects(
        () => svc.installSkill(installer, privateSkill.id),
        (e) => e.code === 'skill_not_found',
    );
});

test('deleteSkill removes a skill (owner only)', async () => {
    const userId = await makeUser();
    const other = await makeUser();
    const skill = await svc.createSkill({ userId, title: 'del', content: 'c' });
    await assert.rejects(() => svc.deleteSkill(other, skill.id), (e) => e.code === 'skill_not_found');
    await svc.deleteSkill(userId, skill.id);
    await assert.rejects(() => svc.getSkill(userId, skill.id), (e) => e.code === 'skill_not_found');
});
