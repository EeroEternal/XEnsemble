/**
 * 0025 端到端验证：技能注入 → 真实落盘 → git 不污染 → Agent 可消费。
 *
 * 与单元测试（内存 fsAdapter mock）不同，本测试用真实文件系统：
 * 1. 临时目录作为 WORKSPACE_ROOT（不触碰 server/data/workspaces 真实数据）
 * 2. 真实 PostgreSQL（bootstrapTestDb）创建用户/项目/激活技能
 * 3. localFs 真实写盘：平台索引 .xensemble/AGENTS.md + 各 Agent 原生技能目录
 * 4. 真实 git init → 验证 .xensemble/、.claude/skills 等被 gitignore 隐藏（changes 干净）
 * 5. 模拟 Agent 消费链路：指令文件指针 → 平台索引 → SKILL.md 全链可读
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-e2e-ws-'));
process.env.WORKSPACE_ROOT = WORKSPACE_ROOT;

const { bootstrapTestDb } = require('../test/db');

let ctx;
let schema;
let db;
let injector;
let defs;
let workspace;
let git;

const tmpGit = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-e2e-git-'));

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
    defs = ctx.reloaded['../agents/defaultAgents'];
    workspace = ctx.reloaded['../workspace'];
});

after(async () => {
    if (ctx) await ctx.teardown();
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    fs.rmSync(tmpGit, { recursive: true, force: true });
});

async function makeUser() {
    const id = `user_${randomUUID()}`;
    const now = Date.now();
    await db.insert(schema.users).values({
        id, username: `u_${randomUUID().slice(0, 8)}`, passwordHash: 'hash',
        role: 'user', status: 'active', createdAt: now, updatedAt: now,
    });
    return id;
}

async function makeProject(userId, name = 'e2e-proj') {
    const id = `prj_${randomUUID()}`;
    const now = Date.now();
    await db.insert(schema.projects).values({
        id, userId, name, serverPath: `/ws/${id}`, createdAt: now,
    });
    return id;
}

async function makeActiveSkill(userId, projectId, { title, content }) {
    const now = Date.now();
    await db.insert(schema.skills).values({
        id: `skl_${randomUUID()}`, userId, projectId, sessionId: null,
        title, content, tags: [], status: 'active', source: 'manual',
        confidence: null, duplicateOf: null, clusterSize: 1, signals: null,
        usageCount: 0, visibility: 'private', publishedAt: null,
        installCount: 0, category: null, forkedFrom: null, createdAt: now, updatedAt: now,
    });
}

/** 模拟 Agent 消费链路：读指令文件 → 解析指针 → 读平台索引 → 读 SKILL.md */
async function simulateAgentConsumption(workspacePath, instructionFile) {
    const inst = fs.readFileSync(path.join(workspacePath, instructionFile), 'utf8');
    const m = inst.match(/<!-- xe-skills-pointer:start -->\n([\s\S]*?)<!-- xe-skills-pointer:end -->/);
    assert.ok(m, `${instructionFile} 应包含引导指针`);
    const pointer = m[1];
    const indexRel = pointer.match(/\.xensemble\/AGENTS\.md/);
    assert.ok(indexRel, `指针应指向平台索引，实际: ${pointer}`);

    const indexPath = path.join(workspacePath, '.xensemble', 'AGENTS.md');
    assert.ok(fs.existsSync(indexPath), '平台索引应落盘');
    const index = fs.readFileSync(indexPath, 'utf8');
    assert.ok(index.includes('## XEnsemble Skills'), '索引应含标题');
    const refs = [...index.matchAll(/详见 (\.xensemble\/skills\/[^\s]+)/g)].map((x) => x[1]);
    assert.ok(refs.length >= 1, '索引应含技能引用');
    for (const rel of refs) {
        const p = path.join(workspacePath, rel);
        assert.ok(fs.existsSync(p), `SKILL.md 应可读: ${rel}`);
        assert.ok(fs.readFileSync(p, 'utf8').length > 0, `SKILL.md 非空: ${rel}`);
    }
    return { indexRefs: refs.length };
}

test('E2E: 技能注入真实落盘 → git changes 干净 → Agent 可消费', async () => {
    const user = await makeUser();
    const proj = await makeProject(user);
    // 先建目录 + 写用户文件（避免 createProjectDirectory 对空目录 seed index.html 干扰 git 断言）
    const wsPath = path.join(WORKSPACE_ROOT, user, proj);
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'AGENTS.md'), '# My repo\n');
    fs.writeFileSync(path.join(wsPath, 'main.py'), 'print("hello")\n');
    // 真实链路：createProjectDirectory → seedAgentWorkspaceFiles + ensureGitignoreEntries
    workspace.createProjectDirectory(user, proj);

    // 预置 git 仓库
    git = execFileSync('git', ['init', '-q'], { cwd: wsPath });
    git = execFileSync('git', ['config', 'user.email', 'e2e@test'], { cwd: wsPath });
    git = execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: wsPath });
    git = execFileSync('git', ['add', 'AGENTS.md', 'main.py'], { cwd: wsPath });
    git = execFileSync('git', ['commit', '-qm', 'initial'], { cwd: wsPath });

    // 激活一个真实技能
    await makeActiveSkill(user, proj, {
        title: 'DB migrate',
        content: '---\nname: DB migrate\ndescription: run db migration\n---\n## Steps\n1. run\n2. verify',
    });

    // 真实重渲染（localFs 写盘）
    const prev = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        const result = await injector.reRenderForSkillChange({ userId: user, projectId: proj });
        assert.ok(result.reRendered >= 1, '应至少更新一个指令文件');
    } finally {
        if (prev === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev;
    }

    // 1. 真实落盘断言（磁盘文件系统）
    const assertFile = (rel) => {
        const p = path.join(wsPath, rel);
        assert.ok(fs.existsSync(p), `应落盘: ${rel}`);
        return fs.readFileSync(p, 'utf8');
    };
    const indexContent = assertFile('.xensemble/AGENTS.md');
    assert.ok(indexContent.includes('DB migrate'), '平台索引应含技能');
    const skillContent = assertFile('.xensemble/skills/db-migrate/SKILL.md');
    assert.ok(skillContent.includes('## Steps'), 'SKILL.md 应含正文');

    // 2. git 不污染：changes 应只有用户自己的文件，平台注入文件被忽略
    const status = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: wsPath, encoding: 'utf8' });
    const changed = status.split('\n').filter(Boolean);
    // 用户 AGENTS.md 会因指针被改（预期最小污染），main.py 不应有变化
    assert.ok(changed.some((l) => l.includes('AGENTS.md')), '用户 AGENTS.md 因指针被改（最小污染）');
    assert.ok(!changed.some((l) => l.includes('main.py')), '用户源码文件不应被改');
    assert.ok(!changed.some((l) => l.includes('.xensemble')), '.xensemble 应被 gitignore 隐藏');
    assert.ok(!changed.some((l) => l.includes('.claude/skills')), '.claude/skills 应被 gitignore 隐藏');

    // 3. Agent 可消费链路：读指针 → 平台索引 → SKILL.md
    const consumption = await simulateAgentConsumption(wsPath, 'AGENTS.md');
    assert.ok(consumption.indexRefs >= 1, 'Agent 应能通过索引读到技能');

    // 4. claude-code 场景：预置 CLAUDE.md（方案 B 语义：仅对已存在文件写指针），
    //    验证 CLAUDE.md 指针链路同样可消费 + .claude/skills 原生目录落盘
    fs.writeFileSync(path.join(wsPath, 'CLAUDE.md'), '# Claude repo\n');
    const prev2 = process.env.SKILL_INJECT_ENABLED;
    process.env.SKILL_INJECT_ENABLED = 'true';
    try {
        await injector.injectForSession({
            userId: user, projectId: proj, agentId: 'claude-code', workspacePath: wsPath, bumpUsage: false,
        });
    } finally {
        if (prev2 === undefined) delete process.env.SKILL_INJECT_ENABLED;
        else process.env.SKILL_INJECT_ENABLED = prev2;
    }
    assert.ok(fs.existsSync(path.join(wsPath, '.claude/skills/db-migrate/SKILL.md')), 'claude 原生技能目录应落盘');
    await simulateAgentConsumption(wsPath, 'CLAUDE.md');
});
