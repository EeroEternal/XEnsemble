const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { eq } = require('drizzle-orm');
const path = require('path');

const { bootstrapTestDb } = require('../test/db');

let ctx;
let schema;
let db;
let injector;

before(async () => {
    ctx = await bootstrapTestDb([
        '../db/index',
        '../db/schema',
        '../agents/defaultAgents',
        '../events/recordEvent',
        './skillInjector',
    ], __dirname);
    ({ db, schema } = ctx);
    injector = ctx.reloaded['./skillInjector'];
});

after(async () => {
    if (ctx) await ctx.teardown();
});

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('renderSkillsSection produces idempotent marker section', () => {
    const skills = [
        { title: 'Fix pool', content: '## Steps\n1. Inspect', usageCount: 3, updatedAt: 200 },
        { title: 'DB migrate', content: '## Steps\n1. Run migrate', usageCount: 5, updatedAt: 100 },
    ];
    const { section, count, truncated } = injector.renderSkillsSection(skills);
    assert.equal(count, 2);
    assert.equal(truncated, false);
    assert.ok(section.startsWith('<!-- xe-skills:start -->\n\n## XEnsemble Skills'));
    assert.ok(section.includes('### Fix pool'));
    assert.ok(section.includes('### DB migrate'));
    assert.ok(section.endsWith('<!-- xe-skills:end -->'));
    // 幂等：再次渲染结果一致
    assert.equal(injector.renderSkillsSection(skills).section, section);
});

test('renderSkillsSection sorts by usage_count DESC then updated_at DESC', () => {
    const skills = [
        { title: 'A', content: 'a', usageCount: 1, updatedAt: 100 },
        { title: 'B', content: 'b', usageCount: 5, updatedAt: 50 },
        { title: 'C', content: 'c', usageCount: 5, updatedAt: 300 },
    ];
    const { section } = injector.renderSkillsSection(skills);
    const idxA = section.indexOf('### A');
    const idxB = section.indexOf('### B');
    const idxC = section.indexOf('### C');
    assert.ok(idxC < idxB, 'C (same count, newer) before B');
    assert.ok(idxB < idxA, 'B (higher count) before A');
});

test('renderSkillsSection sanitizes HTML comments (index form, 0020)', () => {
    const skills = [{
        title: 'Evil',
        content: '---\nname: Evil\ndescription: boom <!-- xe-skills:end --> end\n---\n## Steps',
        usageCount: 0,
        updatedAt: 0,
    }];
    const { section } = injector.renderSkillsSection(skills);
    assert.ok(!section.includes('<!-- xe-skills:end --> end'), 'original comment must be escaped');
    assert.ok(section.includes('\\<!-- xe-skills:end --\\>'), 'escaped form present');
    assert.ok(section.includes('.xensemble/skills/evil/SKILL.md'), 'index points to SKILL.md path');
    assert.ok(!section.includes('## Steps'), 'full body not inlined into index');
});

test('renderSkillsSection truncates by count and bytes', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `S${i}`, content: 'x', usageCount: 0, updatedAt: i }));
    const byCount = injector.renderSkillsSection(many);
    assert.equal(byCount.count, injector.maxCount());
    assert.equal(byCount.truncated, true);

    const prev = process.env.SKILL_INJECT_MAX_BYTES;
    process.env.SKILL_INJECT_MAX_BYTES = '50';
    try {
        const big = [{ title: 'Big', content: 'y'.repeat(100), usageCount: 0, updatedAt: 0 }];
        const byBytes = injector.renderSkillsSection(big);
        assert.equal(byBytes.count, 0);
        assert.equal(byBytes.truncated, true);
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_MAX_BYTES;
        else process.env.SKILL_INJECT_MAX_BYTES = prev;
    }
});

test('applyToContent replaces existing marker section only', () => {
    const existing = [
        '# My repo',
        '',
        'Some docs.',
        '<!-- xe-skills:start -->',
        '## XEnsemble Skills',
        '### Old',
        'old',
        '<!-- xe-skills:end -->',
        '## Footer',
    ].join('\n');
    const next = injector.applyToContent(existing, '<!-- xe-skills:start -->\n\n## XEnsemble Skills\n\n### New\nnew\n\n<!-- xe-skills:end -->');
    assert.ok(next.includes('# My repo'));
    assert.ok(next.includes('## Footer'));
    assert.ok(next.includes('### New'));
    assert.ok(!next.includes('### Old'));
});

test('applyToContent appends when no marker exists', () => {
    const next = injector.applyToContent('# My repo\n', '<!-- xe-skills:start -->\n\n## XEnsemble Skills\n\n<!-- xe-skills:end -->');
    assert.ok(next.startsWith('# My repo'));
    assert.ok(next.includes('## XEnsemble Skills'));
    assert.ok(next.endsWith('<!-- xe-skills:end -->\n'));
});

test('applyToContent returns section alone for empty file', () => {
    const next = injector.applyToContent('', '<!-- xe-skills:start -->\n\n## XEnsemble Skills\n\n<!-- xe-skills:end -->');
    assert.equal(next, '<!-- xe-skills:start -->\n\n## XEnsemble Skills\n\n<!-- xe-skills:end -->\n');
});

test('removeSection strips marker and keeps surrounding content', () => {
    const existing = [
        '# My repo',
        '',
        '<!-- xe-skills:start -->',
        '## XEnsemble Skills',
        '### Old',
        'old',
        '<!-- xe-skills:end -->',
        '',
        '## Footer',
    ].join('\n');
    const next = injector.removeSection(existing);
    assert.ok(next.includes('# My repo'));
    assert.ok(next.includes('## Footer'));
    assert.ok(!next.includes('XEnsemble Skills'));
    assert.ok(!next.includes('<!-- xe-skills:'));
});

test('removeSection returns unchanged when no marker present', () => {
    assert.equal(injector.removeSection('# plain\n'), '# plain\n');
    assert.equal(injector.removeSection(null), '');
});

// ---------------------------------------------------------------------------
// DB 集成 + fsAdapter
// ---------------------------------------------------------------------------

async function makeUser() {
    const id = `user_${randomUUID()}`;
    const now = Date.now();
    await db.insert(schema.users).values({
        id, username: `u_${randomUUID().slice(0, 8)}`, passwordHash: 'hash',
        role: 'user', status: 'active', createdAt: now, updatedAt: now,
    });
    return id;
}

async function makeProject(userId, name = 'proj') {
    const id = `prj_${randomUUID()}`;
    const now = Date.now();
    await db.insert(schema.projects).values({
        id, userId, name, serverPath: `/ws/${id}`, createdAt: now,
    });
    return id;
}

async function makeActiveSkill(userId, { title, content, projectId = null }) {
    const now = Date.now();
    await db.insert(schema.skills).values({
        id: `skl_${randomUUID()}`, userId, projectId, sessionId: null,
        title, content, tags: [], status: 'active', source: 'manual',
        confidence: null, duplicateOf: null, clusterSize: 1, signals: null,
        usageCount: 0, visibility: 'private', publishedAt: null,
        installCount: 0, category: null, forkedFrom: null, createdAt: now, updatedAt: now,
    });
}

test('listActiveSkills scopes by user + project-or-global', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const projA = await makeProject(user, 'A');
    const projB = await makeProject(user, 'B');
    await makeActiveSkill(user, { title: 'global', content: 'g', projectId: null });
    await makeActiveSkill(user, { title: 'projA', content: 'p', projectId: projA });
    await makeActiveSkill(user, { title: 'projB', content: 'p', projectId: projB });
    await makeActiveSkill(other, { title: 'other', content: 'o', projectId: null });

    const forA = await injector.listActiveSkills(user, projA);
    assert.deepEqual(forA.map((s) => s.title).sort(), ['global', 'projA']);

    const global = await injector.listActiveSkills(user, null);
    assert.deepEqual(global.map((s) => s.title), ['global']);
});

test('injectForSession writes instruction file via fsAdapter', async () => {
    const user = await makeUser();
    const projX = await makeProject(user, 'X');
    await makeActiveSkill(user, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run migration\n---\n## Steps\n1. run migrate',
        projectId: projX,
    });

    const files = {
        'AGENTS.md': '# My repo\n',
        'CLAUDE.md': '# My repo\n',
    };
    const fsAdapter = {
        async readFile(rootDir, rel) { return files[rel] ?? null; },
        async writeFile(rootDir, rel, content) { files[rel] = content; },
    };

    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        const result = await injector.injectForSession({
            userId: user, projectId: projX, agentId: 'opencode', workspacePath: '/ws', fsAdapter,
        });
        assert.equal(result.injected, true);
        assert.equal(result.instructionFile, 'AGENTS.md');
        assert.equal(result.count, 1);
        // 0025（方案 B）：索引段写入平台文件 .xensemble/AGENTS.md；用户文件只有一行指针
        assert.ok(files['.xensemble/AGENTS.md'].includes('### DB migrate'));
        assert.ok(files['AGENTS.md'].includes('.xensemble/AGENTS.md'));
        assert.ok(!files['AGENTS.md'].includes('### DB migrate'));

        // claude-code → CLAUDE.md（同样只写指针）
        await injector.injectForSession({
            userId: user, projectId: projX, agentId: 'claude-code', workspacePath: '/ws', fsAdapter,
        });
        assert.ok(files['CLAUDE.md'].includes('.xensemble/AGENTS.md'));
        assert.ok(!files['CLAUDE.md'].includes('### DB migrate'));
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

// ---------------------------------------------------------------------------
// 0021：getSkillTargets / isLandableSkill / 原生目录落盘
// ---------------------------------------------------------------------------

test('getSkillTargets resolves instructionFile + nativeSkillDirs per agent', () => {
    const defs = ctx.reloaded['../agents/defaultAgents'];
    assert.equal(defs.getSkillTargets('claude-code').instructionFile, 'CLAUDE.md');
    assert.deepEqual(defs.getSkillTargets('claude-code').nativeSkillDirs, ['.claude/skills']);
    assert.deepEqual(defs.getSkillTargets('qwen-code').nativeSkillDirs, ['.qwen/skills']);
    assert.deepEqual(defs.getSkillTargets('codebuddy').nativeSkillDirs, ['.codebuddy/skills']);
    assert.deepEqual(defs.getSkillTargets('kimi-code').nativeSkillDirs, ['.kimi-code/skills']);
    assert.deepEqual(defs.getSkillTargets('qoder').nativeSkillDirs, ['.qoder/r/s/skills']);
    assert.deepEqual(defs.getSkillTargets('opencode').nativeSkillDirs, ['.opencode/skills', '.agents/skills']);
    assert.deepEqual(defs.getSkillTargets('pi').nativeSkillDirs, ['.pi/skills']);
    // 未确认的 Agent → 空数组（AGENTS.md 兜底）
    assert.deepEqual(defs.getSkillTargets('github-copilot').nativeSkillDirs, []);
});

test('isLandableSkill requires valid frontmatter and confidence threshold', () => {
    // 合法 frontmatter（name+description）
    const ok = {
        status: 'active', source: 'manual', confidence: 0.1,
        content: '---\nname: fix\ndescription: fix things\n---\n## Steps',
    };
    assert.equal(injector.isLandableSkill(ok), true);
    // 缺 frontmatter / 缺 description / 非 active → false
    assert.equal(injector.isLandableSkill({ ...ok, content: '## Steps' }), false);
    assert.equal(injector.isLandableSkill({ ...ok, content: '---\nname: fix\n---\nbody' }), false);
    assert.equal(injector.isLandableSkill({ ...ok, status: 'draft' }), false);

    // auto 低置信度 → false；auto 高置信度 → true
    const prev = process.env.SKILL_LAND_MIN_CONFIDENCE;
    process.env.SKILL_LAND_MIN_CONFIDENCE = '0.5';
    try {
        assert.equal(injector.isLandableSkill({ ...ok, source: 'auto', confidence: 0.3 }), false);
        assert.equal(injector.isLandableSkill({ ...ok, source: 'auto', confidence: 0.7 }), true);
    } finally {
        if (prev === undefined) delete process.env.SKILL_LAND_MIN_CONFIDENCE;
        else process.env.SKILL_LAND_MIN_CONFIDENCE = prev;
    }
});

test('injectForSession enabled by default when SKILL_INJECT_ENABLED unset', async () => {
    const user = await makeUser();
    const proj = await makeProject(user, 'S0021d');
    await makeActiveSkill(user, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run migration\n---\n## Steps',
        projectId: proj,
    });

    const files = {};
    const fsAdapter = {
        async readFile(rootDir, rel) { return files[rel] ?? null; },
        async writeFile(rootDir, rel, content) { files[rel] = content; },
        async chmod() {},
        async rmrf() {},
        async readDir(rootDir, rel) {
            return Object.keys(files)
                .filter((k) => k.startsWith(`${rel}/`))
                .map((k) => ({ name: k.slice(rel.length + 1).split('/')[0], isDirectory: true }));
        },
    };

    const prev = process.env.SKILL_INJECT_ENABLED;
    delete process.env.SKILL_INJECT_ENABLED;
    try {
        const result = await injector.injectForSession({
            userId: user, projectId: proj, agentId: 'opencode', workspacePath: '/ws', fsAdapter,
        });
        assert.equal(result.injected, true);
        assert.equal(result.reason, undefined);
        assert.ok(files['.xensemble/skills/db-migrate/SKILL.md'], 'default-on lands skill dir');
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

test('injectForSession writes skill to platform root + agent native dirs (0021)', async () => {
    const user = await makeUser();
    const proj = await makeProject(user, 'S0021');
    await makeActiveSkill(user, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run migration\n---\n## Steps',
        projectId: proj,
    });

    const files = {
        'AGENTS.md': '# My repo\n',
        'CLAUDE.md': '# My repo\n',
    };
    const fsAdapter = {
        async readFile(rootDir, rel) { return files[rel] ?? null; },
        async writeFile(rootDir, rel, content) { files[rel] = content; },
        async chmod() {},
        async rmrf(rootDir, rel) {
            for (const k of Object.keys(files)) {
                if (k === rel || k.startsWith(`${rel}/`)) delete files[k];
            }
        },
        async readDir(rootDir, rel) {
            return Object.keys(files)
                .filter((k) => k.startsWith(`${rel}/`))
                .map((k) => ({ name: k.slice(rel.length + 1).split('/')[0], isDirectory: true }));
        },
    };

    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        // claude-code → CLAUDE.md 指针 + .claude/skills
        const result = await injector.injectForSession({
            userId: user, projectId: proj, agentId: 'claude-code', workspacePath: '/ws', fsAdapter,
        });
        assert.equal(result.injected, true);
        assert.ok(files['.xensemble/AGENTS.md'].includes('.xensemble/skills/db-migrate/SKILL.md'));
        assert.ok(files['CLAUDE.md'].includes('.xensemble/AGENTS.md'), 'user file gets pointer only');
        assert.ok(!files['CLAUDE.md'].includes('.xensemble/skills/db-migrate/SKILL.md'));
        assert.ok(files['.xensemble/skills/db-migrate/SKILL.md']);
        assert.ok(files['.claude/skills/db-migrate/SKILL.md'], 'writes to agent native dir');
        // 0023：落盘时 frontmatter name 归一化为小写连字符（与目录名一致）
        const written = files['.xensemble/skills/db-migrate/SKILL.md'];
        assert.match(written, /^name: db-migrate$/m);

        // opencode → AGENTS.md 指针 + .opencode/skills + .agents/skills
        await injector.injectForSession({
            userId: user, projectId: proj, agentId: 'opencode', workspacePath: '/ws', fsAdapter,
        });
        assert.ok(files['AGENTS.md'].includes('.xensemble/AGENTS.md'));
        assert.ok(files['.opencode/skills/db-migrate/SKILL.md'], 'opencode native dir');
        assert.ok(files['.agents/skills/db-migrate/SKILL.md'], 'opencode agent-compatible dir');
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

test('injectForSession is no-op when disabled', async () => {
    const user = await makeUser();
    const projY = await makeProject(user, 'Y');
    await makeActiveSkill(user, {
        title: 'S',
        content: '---\nname: S\ndescription: d\n---\nbody',
        projectId: projY,
    });
    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'false';
    try {
        const result = await injector.injectForSession({
            userId: user, projectId: projY, agentId: 'opencode', workspacePath: '/ws',
        });
        assert.equal(result.injected, false);
        assert.equal(result.reason, 'disabled');
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

test('injectForSession returns no_landable_skills when none pass gate', async () => {
    const user = await makeUser();
    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        const result = await injector.injectForSession({
            userId: user, projectId: 'prj_Z', agentId: 'opencode', workspacePath: '/ws',
        });
        assert.equal(result.injected, false);
        assert.equal(result.reason, 'no_landable_skills');
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

test('getInstructionFile integration via injector deps', () => {
    const defs = ctx.reloaded['../agents/defaultAgents'];
    assert.equal(defs.getInstructionFile('claude-code'), 'CLAUDE.md');
    assert.equal(defs.getInstructionFile('opencode'), 'AGENTS.md');
});

// ---------------------------------------------------------------------------
// 0020 脚本级 Skill：slugify / safeRel / 目录落盘 / 清理
// ---------------------------------------------------------------------------

test('slugify produces safe directory names', () => {
    assert.equal(injector.slugify('Fix Postgres Pool'), 'fix-postgres-pool');
    assert.equal(injector.slugify('跑通 迁移'), '跑通-迁移');
    assert.equal(injector.slugify('...'), 'skill'); // 全符号回退
    assert.equal(injector.slugify('a'.repeat(100)).length, 60);
    assert.ok(!/\.\./.test(injector.slugify('../etc')));
});

test('safeRel blocks path traversal', () => {
    assert.equal(injector.safeRel('scripts/main.sh', 'foo'), path.posix.join('foo', 'scripts/main.sh'));
    assert.throws(() => injector.safeRel('../evil.sh', 'foo'));
    assert.throws(() => injector.safeRel('scripts/../../evil.sh', 'foo'));
});

test('normalizeFrontmatterName rewrites name to lowercase-hyphen slug (0023)', () => {
    const md = '---\nname: Fix Pool\n description: x\n---\n## Steps';
    const out = injector.normalizeFrontmatterName(md, 'fix-pool');
    assert.match(out, /^name: fix-pool$/m);
    assert.match(out, /description: x/);
    assert.match(out, /## Steps/);
    // 无 frontmatter / 无 name → 原样返回
    assert.equal(injector.normalizeFrontmatterName('plain', 'x'), 'plain');
    assert.equal(injector.normalizeFrontmatterName('---\ndescription: d\n---\nbody', 'x'), '---\ndescription: d\n---\nbody');
});

test('writeSkillDirectory writes SKILL.md + scripts with chmod', async () => {
    const files = {};
    const chmodded = [];
    const fsAdapter = {
        async writeFile(rootDir, rel, content) { files[rel] = content; },
        async chmod(rootDir, rel, mode) { chmodded.push({ rel, mode }); },
    };
    const skill = {
        title: 'Fix Pool',
        content: '---\nname: Fix Pool\n---\n## Steps',
        scripts: [
            { path: 'scripts/main.sh', content: '#!/bin/bash\necho hi' },
            { path: 'scripts/verify.py', content: 'print(1)' },
        ],
    };
    const dir = await injector.writeSkillDirectory(fsAdapter, '/ws', skill);
    assert.equal(dir, 'fix-pool');
    // 0023：frontmatter name 归一化为小写连字符 slug，与目录名一致
    assert.match(files['.xensemble/skills/fix-pool/SKILL.md'], /^name: fix-pool$/m);
    assert.ok(files['.xensemble/skills/fix-pool/SKILL.md'].includes('## Steps'));
    assert.equal(files['.xensemble/skills/fix-pool/scripts/main.sh'], '#!/bin/bash\necho hi');
    assert.equal(files['.xensemble/skills/fix-pool/scripts/verify.py'], 'print(1)');
    assert.equal(chmodded.length, 2);
    assert.equal(chmodded[0].mode, 0o755);
});

test('writeSkillDirectory ignores unsafe script paths', async () => {
    const files = {};
    const fsAdapter = {
        async writeFile(rootDir, rel, content) { files[rel] = content; },
    };
    const skill = {
        title: 'Safe',
        content: 'body',
        scripts: [
            { path: '../evil.sh', content: 'rm -rf' },   // 穿越 → 抛错
            { path: 'scripts/ok.sh', content: 'echo ok' },
        ],
    };
    // 第一个脚本路径非法 → 整技能写入失败（调用方捕获后跳过）
    await assert.rejects(() => injector.writeSkillDirectory(fsAdapter, '/ws', skill));
});

test('injectForSession writes index to instruction file and skill directory (0020)', async () => {
    const user = await makeUser();
    const proj = await makeProject(user, 'S0020');
    await makeActiveSkill(user, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run db migration\n---\n## Steps',
        projectId: proj,
    });

    const files = {
        'AGENTS.md': '# My repo\n',
    };
    const fsAdapter = {
        async readFile(rootDir, rel) { return files[rel] ?? null; },
        async writeFile(rootDir, rel, content) { files[rel] = content; },
        async chmod() {},
        async rmrf(rootDir, rel) {
            removed.push(rel);
            for (const k of Object.keys(files)) {
                if (k === rel || k.startsWith(`${rel}/`)) delete files[k];
            }
        },
        async readDir(rootDir, rel) {
            return Object.keys(files)
                .filter((k) => k.startsWith(`${rel}/`))
                .map((k) => ({ name: k.slice(rel.length + 1).split('/')[0], isDirectory: true }));
        },
    };

    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        const result = await injector.injectForSession({
            userId: user, projectId: proj, agentId: 'opencode', workspacePath: '/ws', fsAdapter,
        });
        assert.equal(result.injected, true);
        // 0025（方案 B）：索引在平台文件，用户 AGENTS.md 只有指针
        assert.ok(files['.xensemble/AGENTS.md'].includes('### DB migrate'));
        assert.ok(files['.xensemble/AGENTS.md'].includes('.xensemble/skills/db-migrate/SKILL.md'));
        assert.ok(!files['.xensemble/AGENTS.md'].includes('## Steps'));
        assert.ok(files['AGENTS.md'].includes('.xensemble/AGENTS.md'));
        assert.ok(!files['AGENTS.md'].includes('### DB migrate'));
        // 目录落盘
        assert.ok(files['.xensemble/skills/db-migrate/SKILL.md'].includes('## Steps'));
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

test('cleanupSkillDirectories removes dirs not in activeSlugs', async () => {
    const files = {
        '.xensemble/skills/keep/SKILL.md': 'x',
        '.xensemble/skills/old/SKILL.md': 'y',
    };
    const removed = [];
    const fsAdapter = {
        async rmrf(rootDir, rel) {
            removed.push(rel);
            for (const k of Object.keys(files)) {
                if (k === rel || k.startsWith(`${rel}/`)) delete files[k];
            }
        },
        async readDir(rootDir, rel) {
            return Object.keys(files)
                .filter((k) => k.startsWith(`${rel}/`))
                .map((k) => ({ name: k.slice(rel.length + 1).split('/')[0], isDirectory: true }));
        },
    };
    await injector.cleanupSkillDirectories(fsAdapter, '/ws', ['keep']);
    assert.deepEqual(removed, ['.xensemble/skills/old']);
    assert.ok(!files['.xensemble/skills/old/SKILL.md']);
    assert.ok(files['.xensemble/skills/keep/SKILL.md']);
});

// ---------------------------------------------------------------------------
// T4.4 重渲染
// ---------------------------------------------------------------------------

async function makeSession(userId, projectId, status) {
    const id = `sess_${randomUUID()}`;
    const now = Date.now();
    await db.insert(schema.sessions).values({
        id, userId, projectId, agentId: 'opencode', cwd: '/ws',
        streamRef: `local:pty:${randomUUID()}`, status, createdAt: now,
    });
    return id;
}

test('reRenderForSkillChange writes platform index + pointers for existing instruction files', async () => {
    const user = await makeUser();
    const proj = await makeProject(user, 'R1');
    await makeActiveSkill(user, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run\n---\n## Steps\n1. run',
        projectId: proj,
    });

    const files = {
        'AGENTS.md': '# My repo\n',
        'CLAUDE.md': '# My repo\n',
    };
    const fsAdapter = {
        async readFile(rootDir, rel) { return files[rel] ?? null; },
        async writeFile(rootDir, rel, content) { files[rel] = content; },
    };

    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        const result = await injector.reRenderForSkillChange({ userId: user, projectId: proj, fsAdapter });
        assert.equal(result.reRendered, 2); // AGENTS.md + CLAUDE.md 各写入一行指针
        // 0025（方案 B）：索引在平台文件，用户文件只含指针
        assert.ok(files['.xensemble/AGENTS.md'].includes('### DB migrate'));
        assert.ok(files['AGENTS.md'].includes('.xensemble/AGENTS.md'));
        assert.ok(!files['AGENTS.md'].includes('### DB migrate'));
        assert.ok(files['CLAUDE.md'].includes('.xensemble/AGENTS.md'));
        assert.ok(files['AGENTS.md'].includes('# My repo')); // 用户原有内容保留
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

test('reRenderForSkillChange lands skill dirs but skips instruction file update while running (0021 hot reload)', async () => {
    const user = await makeUser();
    const proj = await makeProject(user, 'R2');
    await makeActiveSkill(user, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run\n---\nbody',
        projectId: proj,
    });
    await makeSession(user, proj, 'running');

    const files = {};
    const fsAdapter = {
        async readFile() { return null; },
        async writeFile(rootDir, rel, content) { files[rel] = content; },
    };

    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        const result = await injector.reRenderForSkillChange({ userId: user, projectId: proj, fsAdapter });
        assert.equal(result.reRendered, 0); // 用户指令文件更新被跳过（且用户文件不存在则不创建）
        // 0025（方案 B）：平台索引文件仍写入（gitignore 内，无需避开 running session）
        assert.ok(files['.xensemble/AGENTS.md'], 'platform index written');
        // 0021：技能目录仍落盘（Agent 原生目录热加载），无需重启会话
        assert.ok(files['.xensemble/skills/db-migrate/SKILL.md'], 'platform root landed');
        assert.ok(files['.claude/skills/db-migrate/SKILL.md'], 'native dir landed for hot reload');
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

test('reRenderForSkillChange removes pointer when no active skills remain (archive)', async () => {
    const user = await makeUser();
    const proj = await makeProject(user, 'R3');

    const files = {
        'AGENTS.md': '# My repo\n\n<!-- xe-skills-pointer:start -->\nXEnsemble Skills 索引详见 `.xensemble/AGENTS.md`（技能列表按需加载）\n<!-- xe-skills-pointer:end -->\n',
    };
    const fsAdapter = {
        async readFile(rootDir, rel) { return files[rel] ?? null; },
        async writeFile(rootDir, rel, content) { files[rel] = content; },
    };

    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        const result = await injector.reRenderForSkillChange({ userId: user, projectId: proj, fsAdapter });
        assert.ok(result.reRendered >= 1);
        assert.ok(files['AGENTS.md'].includes('# My repo'));
        assert.ok(!files['AGENTS.md'].includes('XEnsemble Skills'));
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

// ---------------------------------------------------------------------------
// 0025：注入矩阵——每个已注册 Agent 都应正确注入（索引 + 指针 + 原生目录）
// ---------------------------------------------------------------------------

test('0025 injection matrix: every registered agent receives platform index + pointer + native dirs', async () => {
    const defs = ctx.reloaded['../agents/defaultAgents'];
    const agents = defs.DEFAULT_AGENTS || [];
    assert.ok(agents.length >= 10, `expected a non-trivial agent catalog, got ${agents.length}`);

    const user = await makeUser();
    const proj = await makeProject(user, 'Mtx');
    await makeActiveSkill(user, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run migration\n---\n## Steps\n1. migrate',
        projectId: proj,
    });

    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';

    const results = [];
    try {
        for (const agent of agents) {
            const files = {
                'AGENTS.md': '# My repo\n',
                'CLAUDE.md': '# My repo\n',
            };
            const fsAdapter = {
                async readFile(rootDir, rel) { return files[rel] ?? null; },
                async writeFile(rootDir, rel, content) { files[rel] = content; },
                async chmod() {},
                async rmrf(rootDir, rel) {
                    for (const k of Object.keys(files)) {
                        if (k === rel || k.startsWith(`${rel}/`)) delete files[k];
                    }
                },
                async readDir(rootDir, rel) {
                    return Object.keys(files)
                        .filter((k) => k.startsWith(`${rel}/`))
                        .map((k) => ({ name: k.slice(rel.length + 1).split('/')[0], isDirectory: true }));
                },
            };

            const res = await injector.injectForSession({
                userId: user, projectId: proj, agentId: agent.id, workspacePath: '/ws', fsAdapter, bumpUsage: false,
            });

            const { instructionFile, nativeSkillDirs } = defs.getSkillTargets(agent.id);
            const problems = [];
            if (!res.injected) problems.push(`injected=false (${res.reason})`);
            if (!files['.xensemble/AGENTS.md']) problems.push('platform index missing');
            else if (!files['.xensemble/AGENTS.md'].includes('### DB migrate')) problems.push('platform index lacks skill');
            if (!files[instructionFile]) problems.push(`instruction file ${instructionFile} not written`);
            else if (!files[instructionFile].includes('.xensemble/AGENTS.md')) problems.push(`${instructionFile} lacks pointer`);
            for (const dir of nativeSkillDirs || []) {
                if (!files[`${dir}/db-migrate/SKILL.md`]) problems.push(`native dir ${dir} missing`);
            }

            results.push({ agent: agent.id, instructionFile, nativeSkillDirs: nativeSkillDirs || [], ok: problems.length === 0, problems });
        }

        // 汇总输出（便于人工核对覆盖矩阵）
        // eslint-disable-next-line no-console
        console.log('\n[0025 injection matrix]');
        for (const r of results) {
            console.log(`${r.ok ? '  OK ' : 'FAIL '} ${r.agent.padEnd(16)} → ${r.instructionFile}${r.nativeSkillDirs.length ? ' + ' + r.nativeSkillDirs.join(', ') : ''}${r.problems.length ? '  ✗ ' + r.problems.join('; ') : ''}`);
        }

        const failed = results.filter((r) => !r.ok);
        assert.deepEqual(failed.map((r) => ({ agent: r.agent, problems: r.problems })), [], 'all agents must inject correctly');
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});
