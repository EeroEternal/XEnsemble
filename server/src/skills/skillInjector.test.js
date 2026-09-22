const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { eq } = require('drizzle-orm');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 0030：本文件既有断言基于 Local 回落路径（技能落工程内）。默认 RUNTIME_PROVIDER
// 是 boxlite（载体模式），这里显式钉住 local；载体模式用 useSkillCarrier 覆盖单独测。
// skillCarrierDir 触达真实宿主目录 → WORKSPACE_ROOT 指向临时目录（须在任何 src require 前设置）。
process.env.RUNTIME_PROVIDER = 'local';
const WORKSPACE_ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-injector-test-'));
process.env.WORKSPACE_ROOT = WORKSPACE_ROOT_TMP;

const { bootstrapTestDb } = require('../test/db');

const workspace = require('../workspace');

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
        '../workspace',
        '../workspace/agentBootstrap',
        './skillInjector',
    ], __dirname);
    ({ db, schema } = ctx);
    injector = ctx.reloaded['./skillInjector'];
});

after(async () => {
    if (ctx) await ctx.teardown();
    fs.rmSync(WORKSPACE_ROOT_TMP, { recursive: true, force: true });
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

test('getInstructionFile + getUserSkillDirs per agent', () => {
    const defs = ctx.reloaded['../agents/defaultAgents'];
    assert.equal(defs.getInstructionFile('claude-code'), 'CLAUDE.md');
    assert.equal(defs.getInstructionFile('qwen-code'), 'AGENTS.md');
    assert.deepEqual(defs.getUserSkillDirs('claude-code'), ['.claude/skills']);
    assert.deepEqual(defs.getUserSkillDirs('qwen-code'), ['.qwen/skills']);
    assert.deepEqual(defs.getUserSkillDirs('codebuddy'), ['.codebuddy/skills']);
    assert.deepEqual(defs.getUserSkillDirs('kimi-code'), ['.kimi/skills']);
    assert.deepEqual(defs.getUserSkillDirs('opencode'), ['.config/opencode/skills']);
    assert.deepEqual(defs.getUserSkillDirs('pi'), ['.pi/agent/skills']);
    assert.deepEqual(defs.getUserSkillDirs('github-copilot'), ['.copilot/skills']);
    // glm-agent / minimax-cli：无 skills 支持
    assert.deepEqual(defs.getUserSkillDirs('glm-agent'), []);
    assert.deepEqual(defs.getUserSkillDirs('minimax-cli'), []);
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
    // 非 ASCII 字符（中文等）会被 OpenCode 等的目录名校验拒绝，统一丢弃
    assert.equal(injector.slugify('跑通 PostgreSQL 迁移'), 'postgresql');
    // 无 ASCII 残留 → 短哈希兜底，且不同名不撞名（此前统一塌缩为 'skill'）
    assert.match(injector.slugify('跑通 迁移'), /^skill-[0-9a-f]{8}$/);
    assert.match(injector.slugify('...'), /^skill-[0-9a-f]{8}$/);
    assert.notEqual(injector.slugify('跑通 迁移'), injector.slugify('...'));
    assert.equal(injector.slugify('跑通 迁移'), injector.slugify('跑通 迁移')); // 确定性
    assert.equal(injector.slugify('a'.repeat(100)).length, 60);
    assert.ok(!/\.\./.test(injector.slugify('../etc')));
    // Agent 原生目录的硬校验（OpenCode：^[a-z0-9]+(-[a-z0-9]+)*$）
    assert.match(injector.slugify('跑通 PostgreSQL 迁移'), /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.match(injector.slugify('跑通 迁移'), /^[a-z0-9]+(-[a-z0-9]+)*$/);
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
    const dir = await injector.writeSkillDirectory(fsAdapter, '/ws', skill, '.xensemble/skills');
    assert.equal(dir, 'fix-pool');
    // 0023：frontmatter name 归一化为小写连字符 slug，与目录名一致
    assert.match(files['.xensemble/skills/fix-pool/SKILL.md'], /^name: fix-pool$/m);
    assert.ok(files['.xensemble/skills/fix-pool/SKILL.md'].includes('## Steps'));
    assert.equal(files['.xensemble/skills/fix-pool/scripts/main.sh'], '#!/bin/bash\necho hi');
    assert.equal(files['.xensemble/skills/fix-pool/scripts/verify.py'], 'print(1)');
    assert.equal(chmodded.length, 2);
    assert.equal(chmodded[0].mode, 0o755);
});

test('writeSkillDirectory writes references/ and assets/ files without chmod (0046)', async () => {
    const files = {};
    const chmodded = [];
    const fsAdapter = {
        async writeFile(rootDir, rel, content) { files[rel] = content; },
        async chmod(rootDir, rel, mode) { chmodded.push({ rel, mode }); },
    };
    const skill = {
        title: 'With Files',
        content: '---\nname: With Files\n---\n## Steps',
        scripts: [{ path: 'scripts/main.sh', content: 'echo hi' }],
        files: [
            { path: 'references/guide.md', content: '# Guide' },
            { path: 'assets/template.md', content: 'TPL' },
        ],
    };
    await injector.writeSkillDirectory(fsAdapter, '/ws', skill, '.xensemble/skills');
    assert.equal(files['.xensemble/skills/with-files/references/guide.md'], '# Guide');
    assert.equal(files['.xensemble/skills/with-files/assets/template.md'], 'TPL');
    // 仅脚本 chmod，资源文件不 chmod
    assert.equal(chmodded.length, 1);
    assert.equal(chmodded[0].rel, '.xensemble/skills/with-files/scripts/main.sh');
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
        '.xensemble/skills/old/.xensemble-managed': 'managed\n',
    };
    const removed = [];
    const fsAdapter = {
        async readFile(rootDir, rel) { return files[rel] ?? null; },
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

test('cleanupSkillDirectories skips unmarked dirs (0029 P0 fix: 用户/Agent 自建技能不被误删)', async () => {
    const files = {
        '.claude/skills/my-own-skill/SKILL.md': 'user content', // 用户自建，无标记
        '.claude/skills/stale-managed/SKILL.md': 'platform old', // 平台写入，有标记
        '.claude/skills/stale-managed/.xensemble-managed': 'managed\n',
    };
    const removed = [];
    const fsAdapter = {
        async readFile(rootDir, rel) { return files[rel] ?? null; },
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
    await injector.cleanupSkillDirectories(fsAdapter, '/ws', [], ['.claude/skills']);
    assert.deepEqual(removed, ['.claude/skills/stale-managed']);
    assert.ok(files['.claude/skills/my-own-skill/SKILL.md'], 'unmarked user skill survives');
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

            const instructionFile = defs.getInstructionFile(agent.id);
            const problems = [];
            if (!res.injected) problems.push(`injected=false (${res.reason})`);
            if (!files['.xensemble/AGENTS.md']) problems.push('platform index missing');
            else if (!files['.xensemble/AGENTS.md'].includes('### DB migrate')) problems.push('platform index lacks skill');
            if (!files[instructionFile]) problems.push(`instruction file ${instructionFile} not written`);
            else if (!files[instructionFile].includes('.xensemble/AGENTS.md')) problems.push(`${instructionFile} lacks pointer`);

            results.push({ agent: agent.id, instructionFile, ok: problems.length === 0, problems });
        }

        // 汇总输出（便于人工核对覆盖矩阵）
        // eslint-disable-next-line no-console
        console.log('\n[0025 injection matrix]');
        for (const r of results) {
            console.log(`${r.ok ? '  OK ' : 'FAIL '} ${r.agent.padEnd(16)} → ${r.instructionFile}${r.problems.length ? '  ✗ ' + r.problems.join('; ') : ''}`);
        }

        const failed = results.filter((r) => !r.ok);
        assert.deepEqual(failed.map((r) => ({ agent: r.agent, problems: r.problems })), [], 'all agents must inject correctly');
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

// ---------------------------------------------------------------------------
// 0030（.git 搭车）：技能载体模式（projectDir/.git/xe-skills，零新增挂载设备）
// ---------------------------------------------------------------------------

function makeWritesAdapter() {
    const writes = new Map();
    return {
        writes,
        fsAdapter: {
            async readFile(rootDir, rel) { return (writes.get(rootDir) || {})[rel] ?? null; },
            async writeFile(rootDir, rel, content) {
                const bucket = writes.get(rootDir) || {};
                bucket[rel] = content;
                writes.set(rootDir, bucket);
            },
            async chmod() {},
            async rmrf() {},
            async readDir(rootDir, rel) {
                return Object.keys(writes.get(rootDir) || {})
                    .filter((k) => k.startsWith(`${rel}/`))
                    .map((k) => ({ name: k.slice(rel.length + 1).split('/')[0], isDirectory: true }));
            },
        },
    };
}

test('isSkillCarrierEnabled: boxlite 默认开、local 关、显式 false 停用', () => {
    const prevProvider = process.env.RUNTIME_PROVIDER;
    const prevCarrier = process.env.SKILL_CARRIER_ENABLED;
    try {
        delete process.env.SKILL_CARRIER_ENABLED;
        delete process.env.RUNTIME_PROVIDER;
        assert.equal(injector.isSkillCarrierEnabled(), true, 'default provider is boxlite → carrier ON');

        process.env.RUNTIME_PROVIDER = 'local';
        assert.equal(injector.isSkillCarrierEnabled(), false, 'local never uses carrier');

        process.env.RUNTIME_PROVIDER = 'boxlite';
        assert.equal(injector.isSkillCarrierEnabled(), true);

        process.env.SKILL_CARRIER_ENABLED = 'false';
        assert.equal(injector.isSkillCarrierEnabled(), false, 'explicit opt-out');
    } finally {
        if (prevProvider === undefined) delete process.env.RUNTIME_PROVIDER;
        else process.env.RUNTIME_PROVIDER = prevProvider;
        if (prevCarrier === undefined) delete process.env.SKILL_CARRIER_ENABLED;
        else process.env.SKILL_CARRIER_ENABLED = prevCarrier;
    }
});

test('skillCarrierDir: git 工程返回 .git/xe-skills，非 git 工程返回 null', async () => {
    const user = await makeUser();
    const gitProj = await makeProject(user, 'Git');
    const plainProj = await makeProject(user, 'Plain');

    const gitProjectDir = workspace.projectDir(user, gitProj);
    fs.mkdirSync(path.join(gitProjectDir, '.git'), { recursive: true });
    // 非 git 工程：仅创建目录（无 .git）
    fs.mkdirSync(workspace.projectDir(user, plainProj), { recursive: true });

    assert.equal(injector.skillCarrierDir(user, gitProj), path.join(gitProjectDir, '.git', 'xe-skills'));
    assert.equal(injector.skillCarrierDir(user, plainProj), null);
    assert.equal(injector.skillCarrierDir(user, null), null);
});

test('injectForSession carrier mode writes into .git/xe-skills with managed markers (0030)', async () => {
    const user = await makeUser();
    const proj = await makeProject(user, 'Car');
    await makeActiveSkill(user, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run migration\n---\n## Steps\n1. migrate',
        projectId: proj,
    });

    // git 工程（载体前提）
    const projectDir = workspace.projectDir(user, proj);
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });

    const { writes, fsAdapter } = makeWritesAdapter();
    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        const result = await injector.injectForSession({
            userId: user, projectId: proj, agentId: 'kimi-code',
            workspacePath: '/ws', fsAdapter, bumpUsage: false, useSkillCarrier: true,
        });
        assert.equal(result.injected, true);

        // 载体（projectDir/.git/xe-skills）：kimi-code 主目录落技能 + 平台标记
        const carrier = injector.skillCarrierDir(user, proj);
        const carrierFiles = writes.get(carrier) || {};
        assert.ok(carrierFiles['.kimi/skills/db-migrate/SKILL.md'], 'skill lands in carrier .kimi/skills');
        assert.ok(carrierFiles['.kimi/skills/db-migrate/.xensemble-managed'], 'managed marker written');
        // 载体与工作树隔离：不写工程内技能目录
        const wsFiles = writes.get('/ws') || {};
        assert.ok(!wsFiles['.xensemble/skills/db-migrate/SKILL.md'], 'no skills in working tree');
        assert.ok(!wsFiles['.kimi-code/skills/db-migrate/SKILL.md'], 'no skills in native dirs');

        // 0030：载体模式（原生发现）不再写索引/指针，git 工作区零污染
        assert.ok(!wsFiles['.xensemble/AGENTS.md'], 'no platform index in workspace (native discovery)');
        assert.ok(!wsFiles['AGENTS.md'], 'no pointer into user AGENTS.md');
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

test('injectForSession carrier mode falls back to workspace for non-git projects / agents without userSkillDirs', async () => {
    const user = await makeUser();
    const plainProj = await makeProject(user, 'PlainC');
    const gitProj = await makeProject(user, 'GitC');
    await makeActiveSkill(user, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run migration\n---\n## Steps\n1. migrate',
        projectId: plainProj,
    });
    await makeActiveSkill(user, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run migration\n---\n## Steps\n1. migrate',
        projectId: gitProj,
    });
    // plainProj 无 .git；gitProj 有 .git
    fs.mkdirSync(workspace.projectDir(user, plainProj), { recursive: true });
    fs.mkdirSync(path.join(workspace.projectDir(user, gitProj), '.git'), { recursive: true });

    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        // 非 git 工程 → 载体不可用，回落工程内平台根
        const plain = makeWritesAdapter();
        const r1 = await injector.injectForSession({
            userId: user, projectId: plainProj, agentId: 'kimi-code',
            workspacePath: '/ws', fsAdapter: plain.fsAdapter, bumpUsage: false, useSkillCarrier: true,
        });
        assert.equal(r1.injected, true);
        const ws1 = plain.writes.get('/ws') || {};
        assert.ok(ws1['.xensemble/skills/db-migrate/SKILL.md'], 'non-git project falls back to platform root');
        assert.ok(ws1['.xensemble/skills/db-migrate/.xensemble-managed'], 'fallback write also marked');

        // git 工程 + 无 userSkillDirs 的 agent（glm-agent，工具型 CLI）→ 回落工程内
        const cop = makeWritesAdapter();
        const r2 = await injector.injectForSession({
            userId: user, projectId: gitProj, agentId: 'glm-agent',
            workspacePath: '/ws', fsAdapter: cop.fsAdapter, bumpUsage: false, useSkillCarrier: true,
        });
        assert.equal(r2.injected, true);
        const ws2 = cop.writes.get('/ws') || {};
        assert.ok(ws2['.xensemble/skills/db-migrate/SKILL.md'], 'agent without userSkillDirs falls back');
        assert.ok(!cop.writes.has(injector.skillCarrierDir(user, gitProj)), 'no carrier writes');
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});

test('reRenderForSkillChange carrier mode lands skills across all agents main dirs in .git/xe-skills (0030)', async () => {
    const user = await makeUser();
    const proj = await makeProject(user, 'CarR');
    await makeActiveSkill(user, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run migration\n---\n## Steps\n1. migrate',
        projectId: proj,
    });
    fs.mkdirSync(path.join(workspace.projectDir(user, proj), '.git'), { recursive: true });

    const { writes, fsAdapter } = makeWritesAdapter();
    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        await injector.reRenderForSkillChange({ userId: user, projectId: proj, fsAdapter, useSkillCarrier: true });

        // 载体：全部 agent 的主用户级目录都有该技能（每个 agent 会话 symlink 后原生发现）
        const carrier = injector.skillCarrierDir(user, proj);
        const carrierFiles = writes.get(carrier) || {};
        for (const dir of ['.kimi/skills', '.claude/skills', '.factory/skills', '.qwen/skills', '.pi/agent/skills', '.openclaw/skills']) {
            assert.ok(carrierFiles[`${dir}/db-migrate/SKILL.md`], `skill lands in carrier ${dir}`);
            assert.ok(carrierFiles[`${dir}/db-migrate/.xensemble-managed`], `marker in carrier ${dir}`);
        }
        // 0030：载体模式（原生发现）不写索引/指针，工作树零污染
        const wsFiles = writes.get(workspace.projectDir(user, proj)) || {};
        assert.ok(!wsFiles['.xensemble/AGENTS.md'], 'no platform index in workspace (native discovery)');
        assert.ok(!wsFiles['AGENTS.md'] && !wsFiles['CLAUDE.md'], 'no pointer into user instruction files');
        assert.ok(!wsFiles['.xensemble/skills/db-migrate/SKILL.md'], 'no skill dirs in working tree');
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }
});
