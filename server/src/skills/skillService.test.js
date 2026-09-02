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
    // 0021：激活需合法 SKILL.md frontmatter（name/description）
    const skill = await svc.createSkill({
        userId, title: 't', content: '---\nname: t\ndescription: d\n---\n## Steps\n1. x',
    });

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

// ---------------------------------------------------------------------------
// 0021：落盘门槛——激活校验
// ---------------------------------------------------------------------------

test('changeStatus rejects activate when content has no valid frontmatter', async () => {
    const userId = await makeUser();
    const bad = await svc.createSkill({ userId, title: 'bad', content: '## Steps\n1. x' }); // 无 frontmatter
    await assert.rejects(
        () => svc.changeStatus(userId, bad.id, 'activate'),
        (e) => e.code === 'skill_not_landable',
    );

    const noDesc = await svc.createSkill({ userId, title: 'nd', content: '---\nname: nd\n---\nbody' }); // 缺 description
    await assert.rejects(
        () => svc.changeStatus(userId, noDesc.id, 'activate'),
        (e) => e.code === 'skill_not_landable',
    );
});

test('changeStatus rejects activate for low-confidence auto skill (SKILL_LAND_MIN_CONFIDENCE)', async () => {
    const userId = await makeUser();
    const auto = await svc.createSkill({
        userId, title: 'auto-low', source: 'auto', confidence: 0.2,
        content: '---\nname: auto-low\ndescription: d\n---\nbody',
    });
    const prev = process.env.SKILL_LAND_MIN_CONFIDENCE;
    process.env.SKILL_LAND_MIN_CONFIDENCE = '0.5';
    try {
        await assert.rejects(
            () => svc.changeStatus(userId, auto.id, 'activate'),
            (e) => e.code === 'skill_not_landable',
        );
    } finally {
        if (prev === undefined) delete process.env.SKILL_LAND_MIN_CONFIDENCE;
        else process.env.SKILL_LAND_MIN_CONFIDENCE = prev;
    }
});

test('changeStatus allows activate for manual skill regardless of confidence', async () => {
    const userId = await makeUser();
    const manual = await svc.createSkill({
        userId, title: 'manual', source: 'manual', confidence: 0.1,
        content: '---\nname: manual\ndescription: d\n---\nbody',
    });
    const active = await svc.changeStatus(userId, manual.id, 'activate');
    assert.equal(active.status, 'active');
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

// ---------------------------------------------------------------------------
// 0020 脚本级 Skill：scripts 字段存取
// ---------------------------------------------------------------------------

test('createSkill stores and returns validated scripts (0020)', async () => {
    const userId = await makeUser();
    const skill = await svc.createSkill({
        userId,
        title: 'Auto fix',
        content: 'c',
        scripts: [
            { path: 'scripts/main.sh', content: '#!/bin/bash' },
            { path: '../evil.sh', content: 'x' },          // 过滤：穿越
            { path: 'scripts/noext', content: 'x' },       // 过滤：扩展名
        ],
    });
    assert.deepEqual(skill.scripts, [{ path: 'scripts/main.sh', content: '#!/bin/bash' }]);
});

test('updateSkill patches scripts', async () => {
    const userId = await makeUser();
    const skill = await svc.createSkill({ userId, title: 't', content: 'c' });
    const updated = await svc.updateSkill(userId, skill.id, {
        scripts: [{ path: 'scripts/fix.py', content: 'print(1)' }],
    });
    assert.deepEqual(updated.scripts, [{ path: 'scripts/fix.py', content: 'print(1)' }]);
});

test('installSkill copies scripts to the new copy', async () => {
    const owner = await makeUser();
    const installer = await makeUser();
    const source = await svc.createSkill({
        userId: owner,
        title: '共享脚本技能',
        content: 'c',
        scripts: [{ path: 'scripts/run.sh', content: '#!/bin/bash\nrun' }],
    });
    await svc.publishSkill(owner, source.id);

    const copy = await svc.installSkill(installer, source.id);
    assert.deepEqual(copy.scripts, [{ path: 'scripts/run.sh', content: '#!/bin/bash\nrun' }]);
    assert.equal(copy.source, 'installed');
    assert.equal(copy.forkedFrom, source.id);
});

// ---------------------------------------------------------------------------
// 0022：本地目录导入（外部开源技能安装）
// ---------------------------------------------------------------------------

const { mkdtemp, mkdir, writeFile, rm } = require('fs/promises');
const os = require('os');
const path = require('path');

async function makeTempSkillRoot({ withScripts = true } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'xe-skill-import-'));
    const skillDir = path.join(root, 'fix-pool');
    await mkdir(skillDir);
    await mkdir(path.join(skillDir, 'scripts')).catch(() => {});
    await writeFile(path.join(skillDir, 'SKILL.md'), [
        '---',
        'name: fix-pool',
        'description: fix db pool leak',
        '---',
        '## Steps\n1. inspect',
    ].join('\n'));
    if (withScripts) {
        await writeFile(path.join(skillDir, 'scripts', 'run.sh'), '#!/bin/bash\necho fix');
        await writeFile(path.join(skillDir, 'scripts', 'ignore.txt'), 'not a script');
    }
    return root;
}

test('importSkillFromPath imports valid skill dirs with scripts (0022)', async () => {
    const userId = await makeUser();
    const root = await makeTempSkillRoot();
    try {
        const imported = await svc.importSkillFromPath(userId, root);
        assert.equal(imported.length, 1);
        const skill = imported[0];
        assert.equal(skill.title, 'fix-pool');
        assert.equal(skill.source, 'external');
        assert.equal(skill.status, 'draft');
        assert.deepEqual(skill.scripts, [{ path: 'scripts/run.sh', content: '#!/bin/bash\necho fix' }]);
        assert.ok(skill.content.includes('fix db pool leak'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('importSkillFromPath skips invalid dirs and rejects when nothing valid (0022)', async () => {
    const userId = await makeUser();
    const root = await mkdtemp(path.join(os.tmpdir(), 'xe-skill-import-bad-'));
    try {
        // 缺 frontmatter description / 目录名不匹配
        await mkdir(path.join(root, 'bad'));
        await writeFile(path.join(root, 'bad', 'SKILL.md'), '---\nname: bad\n---\nno desc');
        await mkdir(path.join(root, 'mismatch'));
        await writeFile(path.join(root, 'mismatch', 'SKILL.md'), '---\nname: other-name\ndescription: d\n---\nbody');
        await assert.rejects(
            () => svc.importSkillFromPath(userId, root),
            (e) => e.code === 'skill_import_invalid',
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('importSkillFromPath requires dirPath and rejects empty (0022)', async () => {
    const userId = await makeUser();
    await assert.rejects(
        () => svc.importSkillFromPath(userId, ''),
        (e) => e.code === 'skill_import_invalid',
    );
    await assert.rejects(
        () => svc.importSkillFromPath(userId, path.join(os.tmpdir(), 'does-not-exist-xyz')),
        (e) => e.code === 'skill_import_not_found',
    );
});
