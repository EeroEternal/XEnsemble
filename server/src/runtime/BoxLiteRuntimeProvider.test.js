const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 测试用临时 WORKSPACE_ROOT（resolveSkillCarrierGuestRoot/ensureReady 会触达宿主目录），
// 避免在开发机/CI 上创建 /var/lib/... 真实目录。
const WORKSPACE_ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-boxlite-test-'));
process.env.WORKSPACE_ROOT = WORKSPACE_ROOT_TMP;

const BoxLiteRuntimeProvider = require('./BoxLiteRuntimeProvider');
const workspace = require('../workspace');
const agentBootstrap = require('../workspace/agentBootstrap');

class MockBoxLiteClient {
    constructor() {
        this.deleted = [];
        this.stopped = [];
        this.opened = [];
        this.execResults = [{ exitCode: 0, stdout: '', stderr: '' }];
    }

    async deleteSession(name) {
        this.deleted.push(name);
    }

    async stopSession(name) {
        this.stopped = this.stopped || [];
        this.stopped.push(name);
    }

    async openSession(name, image, warm = false, options = {}) {
        this.opened.push({
            name,
            image,
            warm,
            volumes: options.volumes || [],
            network: options.network || null,
        });
        return { event: 'session_opened' };
    }

    async execForResult(sessionName, command, args = [], env = {}, workingDir = null) {
        this.execCalls = this.execCalls || [];
        this.execCalls.push({ sessionName, command, args, env, workingDir });
        if (typeof this.execHandler === 'function') {
            return this.execHandler({ sessionName, command, args, env, workingDir });
        }
        return this.execResults.shift() || { exitCode: 0, stdout: '', stderr: '' };
    }
}

let originalEnsureBootstrap;

before(() => {
    originalEnsureBootstrap = agentBootstrap.ensureAgentBootstrap;
    agentBootstrap.ensureAgentBootstrap = async () => ({ status: 'skipped' });
});

after(() => {
    agentBootstrap.ensureAgentBootstrap = originalEnsureBootstrap;
    fs.rmSync(WORKSPACE_ROOT_TMP, { recursive: true, force: true });
});

test('ensureReady recreates blink session when stored image differs', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const project = { id: 'proj_image_swap', userId: 'usr_swap' };
    const result = await provider.ensureReady(project, {
        runtimeId: 'rt_swap',
        agentId: 'droid',
        image: 'xensemble/agent-droid:latest',
        storedImage: 'xensemble/box-base:bookworm',
    });

    assert.deepEqual(client.deleted, ['rt_swap']);
    assert.equal(client.opened.length, 1);
    assert.equal(client.opened[0].name, 'rt_swap');
    assert.equal(client.opened[0].image, 'xensemble/agent-droid:latest');
    assert.equal(client.opened[0].volumes.length, 1);
    assert.match(client.opened[0].volumes[0].host_path, /usr_swap[/\\]proj_image_swap$/);
    assert.equal(client.opened[0].volumes[0].guest_path, '/workspace');
    assert.deepEqual(client.opened[0].network, { mode: 'enabled', allow_net: [] });
    assert.equal(result.runtimeRef, 'rt_swap');
    assert.equal(result.image, 'xensemble/agent-droid:latest');
    assert.match(result.mountKey, /=>[/\\]workspace$/);
});

test('ensureReady recreates blink session when stored image is missing', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const project = { id: 'proj_first_agent', userId: 'usr_first' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_first',
        agentId: 'kimi-code',
        image: 'xensemble/agent-kimi-code:latest',
        storedImage: null,
    });

    assert.deepEqual(client.deleted, ['rt_first']);
    assert.equal(client.opened[0].image, 'xensemble/agent-kimi-code:latest');
});

test('ensureReady forceRecreate deletes blink session when image differs', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const image = 'xensemble/agent-kimi-code:latest';
    const project = { id: 'proj_force', userId: 'usr_force' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_force',
        agentId: 'kimi-code',
        image,
        storedImage: 'xensemble/agent-old:latest',
        storedMount: resultMountKey(project),
        forceRecreate: true,
    });

    assert.deepEqual(client.deleted, ['rt_force']);
});

test('ensureReady keeps existing session when image is unchanged', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const image = 'xensemble/agent-claude-code:latest';
    const project = { id: 'proj_same_image', userId: 'usr_same' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_same',
        agentId: 'claude-code',
        image,
        storedImage: image,
        storedMount: resultMountKey(project),
    });

    assert.deepEqual(client.deleted, []);
    assert.equal(client.opened[0].image, image);
});

test('ensureReady recreates blink session when agent command probe fails', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;
    let probeAttempts = 0;
    client.execHandler = ({ command, args }) => {
        const shell = Array.isArray(args) ? args.join(' ') : '';
        if (command === 'sh' && shell.includes('command -v')) {
            probeAttempts += 1;
            return { exitCode: probeAttempts >= 2 ? 0 : 127, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    };

    const project = { id: 'proj_probe', userId: 'usr_probe' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_probe',
        agentId: 'kimi-code',
        image: 'xensemble/agent-kimi-code:latest',
        storedImage: 'xensemble/agent-kimi-code:latest',
        storedMount: resultMountKey(project),
    });

    assert.equal(probeAttempts, 2);
    assert.deepEqual(client.deleted, ['rt_probe']);
    assert.equal(client.opened.length, 2);
});

test('ensureReady keeps existing session when image differs but agentId is absent', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const project = { id: 'proj_attach', userId: 'usr_attach' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_attach',
        image: 'xensemble/box-base:bookworm',
        storedImage: 'xensemble/agent-kimi-code:latest',
        storedMount: resultMountKey(project),
    });

    assert.deepEqual(client.deleted, []);
    assert.equal(client.opened[0].image, 'xensemble/box-base:bookworm');
});

test('ensureReady recreates blink session when workspace mount differs', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const project = { id: 'proj_mount', userId: 'usr_mount' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_mount',
        storedMount: '/old/host=>/workspace',
    });

    assert.deepEqual(client.deleted, ['rt_mount']);
    assert.equal(client.opened.length, 1);
    assert.match(client.opened[0].volumes[0].host_path, /usr_mount[/\\]proj_mount$/);
});

test('ensureReady runs post-boot boxlite execs sequentially (no concurrent zygote race)', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    let inFlight = 0;
    let maxInFlight = 0;
    client.execHandler = async ({ command, args }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Widen the window so concurrency (if reintroduced) would be detected.
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        const shell = Array.isArray(args) ? args.join(' ') : '';
        if (command === 'sh' && shell.includes('command -v')) {
            return { exitCode: 0, stdout: '/root/.local/bin/agent', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    };

    const project = { id: 'proj_serial', userId: 'usr_serial' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_serial',
        agentId: 'cursor',
        image: 'xensemble/agent-cursor:latest',
        storedImage: 'xensemble/agent-cursor:latest',
        storedMount: resultMountKey(project),
    });

    assert.equal(maxInFlight, 1, `expected serialized boxlite execs (maxInFlight=1), got ${maxInFlight}`);
});

test('ensureWorkspacePath retries on transient spawn failure', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    let spawnAttempts = 0;
    client.execHandler = async ({ command, args }) => {
        const shell = Array.isArray(args) ? args.join(' ') : '';
        if (command === 'sh' && shell.includes('mkdir -p')) {
            spawnAttempts += 1;
            if (spawnAttempts < 2) {
                throw new Error('spawn failed: 500 {"error":"failed to spawn command in sandbox"}');
            }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    };

    await provider.ensureWorkspacePath('rt_retry', '/workspace');
    assert.equal(spawnAttempts, 2, 'expected ensureWorkspacePath to retry after first spawn failure');
});

// ---------------------------------------------------------------------------
// 0030（.git 搭车）：技能载体 symlink 引导（零新增挂载设备）
// ---------------------------------------------------------------------------

test('buildSkillSymlinkScript covers ALL userSkillDirs via carrier root (0030 核心)', () => {
    const script = BoxLiteRuntimeProvider.buildSkillSymlinkScript('kimi-code', '/workspace.git/xe-skills');
    assert.ok(script, 'script generated');
    // kimi-code 声明 3 个目录，全部 symlink 到 .git 载体（worktree 会话路径）
    assert.ok(script.includes('ln -s "/workspace.git/xe-skills/.kimi/skills" "/root/.kimi/skills"'));
    assert.ok(script.includes('ln -s "/workspace.git/xe-skills/.claude/skills" "/root/.claude/skills"'));
    assert.ok(script.includes('ln -s "/workspace.git/xe-skills/.agents/skills" "/root/.agents/skills"'));
    // 镜像内置实体目录 → 种子合并（载体为空时）再替换为 symlink
    assert.ok(script.includes('cp -a'), 'seeds carrier from image-baked dirs when carrier empty');
    assert.ok(script.includes('rm -rf'), 'replaces real dirs with symlinks');
    // 陈旧 symlink 刷新
    assert.ok(script.includes('if [ -L'), 'refreshes stale symlinks');
});

test('buildSkillSymlinkScript defaults / worktree 与默认会话两种载体路径', () => {
    // 无载体（工程非 git / agent 无 userSkillDirs）→ null
    assert.equal(BoxLiteRuntimeProvider.buildSkillSymlinkScript('kimi-code', null), null);
    // glm-agent（@guizmo-ai/zai-cli 为工具型 CLI，无 SKILL.md 发现机制）→ 未声明 userSkillDirs
    assert.equal(BoxLiteRuntimeProvider.buildSkillSymlinkScript('glm-agent', '/workspace.git/xe-skills'), null);
    assert.equal(BoxLiteRuntimeProvider.buildSkillSymlinkScript(null, '/workspace.git/xe-skills'), null);
    // SKILL_CARRIER_ENABLED=false 停用
    const prev = process.env.SKILL_CARRIER_ENABLED;
    process.env.SKILL_CARRIER_ENABLED = 'false';
    try {
        assert.equal(BoxLiteRuntimeProvider.buildSkillSymlinkScript('kimi-code', '/workspace.git/xe-skills'), null);
    } finally {
        if (prev === undefined) delete process.env.SKILL_CARRIER_ENABLED;
        else process.env.SKILL_CARRIER_ENABLED = prev;
    }
    // 默认会话载体路径（.git 在 workspace 卷内）
    const wsScript = BoxLiteRuntimeProvider.buildSkillSymlinkScript('claude-code', '/workspace/.git/xe-skills');
    assert.ok(wsScript.includes('ln -s "/workspace/.git/xe-skills/.claude/skills" "/root/.claude/skills"'));
});

test('resolveSkillCarrierGuestRoot：worktree 走 .git 卷，默认会话要求工程是 git 仓库', () => {
    const gitVolume = { host_path: '/h/.git', guest_path: '/workspace.git', read_only: false };
    // worktree 会话（gitVolume 存在）→ .git 卷内
    assert.equal(
        BoxLiteRuntimeProvider.resolveSkillCarrierGuestRoot({ gitVolume }, '/h/wt', '/workspace'),
        '/workspace.git/xe-skills',
    );
    // 默认会话 + 宿主 .git 存在 → workspace 卷内
    const gitDir = path.join(WORKSPACE_ROOT_TMP, 'usr_carrier', 'proj_carrier', '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    assert.equal(
        BoxLiteRuntimeProvider.resolveSkillCarrierGuestRoot({ gitVolume: null }, path.dirname(gitDir), '/workspace'),
        '/workspace/.git/xe-skills',
    );
    // 默认会话 + 工程 非 git → null
    const plainDir = path.join(WORKSPACE_ROOT_TMP, 'usr_carrier', 'proj_plain');
    fs.mkdirSync(plainDir, { recursive: true });
    assert.equal(
        BoxLiteRuntimeProvider.resolveSkillCarrierGuestRoot({ gitVolume: null }, plainDir, '/workspace'),
        null,
    );
    // 载体停用 → null
    const prev = process.env.SKILL_CARRIER_ENABLED;
    process.env.SKILL_CARRIER_ENABLED = 'false';
    try {
        assert.equal(
            BoxLiteRuntimeProvider.resolveSkillCarrierGuestRoot({ gitVolume }, '/h/wt', '/workspace'),
            null,
        );
    } finally {
        if (prev === undefined) delete process.env.SKILL_CARRIER_ENABLED;
        else process.env.SKILL_CARRIER_ENABLED = prev;
    }
});

test('ensureReady 默认会话：git 工程执行载体 symlink 引导（.git 在 workspace 卷内）', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    // 预置 git 工程（宿主 projectDir/.git 存在）
    const project = { id: 'proj_carrier_ok', userId: 'usr_cok' };
    fs.mkdirSync(path.join(workspace.projectDir(project.userId, project.id), '.git'), { recursive: true });

    await provider.ensureReady(project, {
        runtimeId: 'rt_cok',
        agentId: 'kimi-code',
        image: 'xensemble/agent-kimi-code:latest',
        storedImage: null,
    });

    // 0030：仍只有 workspace 一个卷（零新增设备）
    assert.equal(client.opened[0].volumes.length, 1);
    const symlinkExec = (client.execCalls || []).find(
        (c) => c.command === 'sh' && Array.isArray(c.args) && c.args.join(' ').includes('ln -s'),
    );
    assert.ok(symlinkExec, 'carrier symlink bootstrap runs for git project');
    assert.ok(symlinkExec.args.join(' ').includes('"/workspace/.git/xe-skills/.kimi/skills"'),
        'carrier path inside workspace volume');
});

test('ensureReady worktree 会话：载体 symlink 指向 .git 卷内', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    // worktree 依赖 git 工程；stub _ensureWorktree 避免真实 git 操作
    const project = { id: 'proj_carrier_wt', userId: 'usr_cwt', defaultRuntimeId: 'rt_default' };
    const mainDir = workspace.projectDir(project.userId, project.id);
    fs.mkdirSync(path.join(mainDir, '.git'), { recursive: true });
    const wtDir = workspace.worktreeDir(project.userId, project.id, 'rt_cwt');
    fs.mkdirSync(wtDir, { recursive: true });
    provider._ensureWorktree = async () => wtDir;

    await provider.ensureReady(project, {
        runtimeId: 'rt_cwt',
        agentId: 'kimi-code',
        image: 'xensemble/agent-kimi-code:latest',
        storedImage: null,
    });

    // worktree 会话：workspace + .git 两卷（IRQ 预算内，技能零新增设备）
    assert.equal(client.opened[0].volumes.length, 2);
    const symlinkExec = (client.execCalls || []).find(
        (c) => c.command === 'sh' && Array.isArray(c.args) && c.args.join(' ').includes('ln -s'),
    );
    assert.ok(symlinkExec, 'carrier symlink bootstrap runs for worktree session');
    assert.ok(symlinkExec.args.join(' ').includes('"/workspace.git/xe-skills/.kimi/skills"'),
        'carrier path inside .git volume');
});

test('skill symlink exec failure does not block session (best-effort)', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;
    client.execHandler = ({ command, args }) => {
        const shell = Array.isArray(args) ? args.join(' ') : '';
        if (command === 'sh' && shell.includes('ln -s')) {
            throw new Error('symlink setup exploded');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    };

    const project = { id: 'proj_symfail', userId: 'usr_symfail' };
    fs.mkdirSync(path.join(workspace.projectDir(project.userId, project.id), '.git'), { recursive: true });
    const result = await provider.ensureReady(project, {
        runtimeId: 'rt_symfail',
        agentId: 'kimi-code',
        image: 'xensemble/agent-kimi-code:latest',
        storedImage: null,
    });

    assert.equal(result.runtimeRef, 'rt_symfail', 'session still ready despite symlink failure');
});

function resultMountKey(project) {
    const guestPath = '/workspace';
    const hostPath = workspace.projectDir(project.userId, project.id);
    return `${hostPath}=>${guestPath}`;
}
