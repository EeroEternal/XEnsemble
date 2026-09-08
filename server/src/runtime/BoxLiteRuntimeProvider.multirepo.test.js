const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 测试用临时 WORKSPACE_ROOT，避免触达真实目录
const WORKSPACE_ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-boxlite-mr-test-'));
process.env.WORKSPACE_ROOT = WORKSPACE_ROOT_TMP;

const BoxLiteRuntimeProvider = require('./BoxLiteRuntimeProvider');
const workspace = require('../workspace');
const agentBootstrap = require('../workspace/agentBootstrap');

let originalEnsureBootstrap;
before(() => {
    originalEnsureBootstrap = agentBootstrap.ensureAgentBootstrap;
    agentBootstrap.ensureAgentBootstrap = async () => ({ status: 'skipped' });
});
after(() => {
    agentBootstrap.ensureAgentBootstrap = originalEnsureBootstrap;
});

class MockBoxLiteClient {
    constructor() {
        this.deleted = [];
        this.opened = [];
        this.execResults = [{ exitCode: 0, stdout: '', stderr: '' }];
    }

    async deleteSession(name) { this.deleted.push(name); }

    async openSession(name, image, warm = false, options = {}) {
        this.opened.push({ name, image, warm, volumes: options.volumes || [] });
        return { event: 'session_opened' };
    }

    async execForResult(sessionName, command, args = [], env = {}, workingDir = null) {
        this.execCalls = this.execCalls || [];
        this.execCalls.push({ sessionName, command, args, env, workingDir });
        return this.execResults.shift() || { exitCode: 0, stdout: '', stderr: '' };
    }
}

const REPOS = [
    { id: 'pr_1', subPath: 'frontend', role: 'frontend', isPrimary: true, repoDefaultBranch: 'main' },
    { id: 'pr_2', subPath: 'backend', role: 'backend', isPrimary: false, repoDefaultBranch: 'main' },
];

test('buildMultiRepoVolume：host=worktree 根目录单卷，guest=/workspace，gitVolume 指向 primary repo 的 .git', () => {
    const provider = new BoxLiteRuntimeProvider();
    const project = { id: 'p1', userId: 'u1' };
    const mainDir = workspace.projectDir(project.userId, project.id);
    // primary repo .git 存在 → gitVolume
    fs.mkdirSync(path.join(mainDir, 'frontend', '.git'), { recursive: true });

    const wtBase = workspace.worktreeDir(project.userId, project.id, 'rt_x');
    const vol = provider.buildMultiRepoVolume(project, wtBase, REPOS);

    assert.equal(vol.host_path, wtBase);
    assert.equal(vol.guest_path, '/workspace');
    assert.ok(vol.gitVolume, 'primary gitVolume present');
    assert.match(vol.gitVolume.host_path, /frontend[\\/]\.git$/);
    assert.equal(vol.gitVolume.guest_path, '/workspace.git');
    assert.equal(vol.repos.length, 2);
});

test('buildMultiRepoVolume：primary 无 .git → gitVolume null', () => {
    const provider = new BoxLiteRuntimeProvider();
    const project = { id: 'p_nogit', userId: 'u1' };
    const vol = provider.buildMultiRepoVolume(
        project,
        workspace.worktreeDir(project.userId, project.id, 'rt_y'),
        REPOS,
    );
    assert.equal(vol.gitVolume, null);
});

test('ensureReady 多 repo worktree 会话：host 挂载 worktree 根，_ensureRepoWorktree 每 repo 一次', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const project = { id: 'proj_mr_ready', userId: 'usr_mr', defaultRuntimeId: 'rt_default' };
    const ensured = [];
    provider._ensureRepoWorktree = async (_p, runtimeId, repo) => {
        ensured.push(repo.subPath);
        return workspace.repoWorktreePath(project.userId, project.id, runtimeId, repo.subPath);
    };

    await provider.ensureReady(project, {
        runtimeId: 'rt_mr1',
        agentId: 'kimi-code',
        image: 'xensemble/agent-kimi-code:latest',
        storedImage: null,
        repos: REPOS,
    });

    assert.deepEqual(ensured.sort(), ['backend', 'frontend']);
    const vol = client.opened[0].volumes[0];
    assert.equal(vol.guest_path, '/workspace');
    assert.match(vol.host_path, /proj_mr_ready\.wt[\\/]rt_mr1$/);
});

test('ensureReady 单 repo：保持原 buildWorkspaceVolume 语义（host=projectDir）', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const project = { id: 'proj_single', userId: 'usr_single' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_s1',
        agentId: 'kimi-code',
        image: 'xensemble/agent-kimi-code:latest',
        storedImage: null,
        repos: REPOS.slice(0, 1),
    });

    const vol = client.opened[0].volumes[0];
    assert.equal(vol.guest_path, '/workspace');
    assert.match(vol.host_path, /usr_single[\\/]proj_single$/);
    // 默认会话（非 worktree）只有 workspace 一个卷（无 .git 卷）
    assert.equal(client.opened[0].volumes.length, 1);
});

test('ensureRepoWorktree 逻辑：mainDir 无 .git 返回 null；有 .git 走 git worktree add', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const project = { id: 'proj_wt_real', userId: 'usr_wt' };
    const mainDir = path.join(workspace.projectDir(project.userId, project.id), 'frontend');

    // 无 .git → null
    assert.equal(await provider._ensureRepoWorktree(project, 'rt_w1', REPOS[0]), null);

    // 有 .git（裸 init 主仓 + 提交对象）→ worktree 成功
    fs.mkdirSync(mainDir, { recursive: true });
    const { execFileSync } = require('child_process');
    const run = (args) => execFileSync('git', ['-C', mainDir, ...args], { stdio: 'pipe' });
    run(['init', '-q']);
    run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(mainDir, 'f.txt'), 'x');
    run(['add', '.']); run(['commit', '-qm', 'init']);

    const wt = await provider._ensureRepoWorktree(project, 'rt_w2', REPOS[0]);
    assert.ok(wt, 'worktree created');
    assert.match(wt, /proj_wt_real\.wt[\\/]rt_w2[\\/]frontend$/);
    assert.ok(fs.existsSync(path.join(wt, '.git')));
    // 分支名包含完整 runtimeId（防碰撞）与 subPath
    const { execFileSync: efs } = require('child_process');
    const branch = efs('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' }).toString().trim();
    assert.equal(branch, 'agentharness/session-rt_w2-frontend');
});

after(() => {
    fs.rmSync(WORKSPACE_ROOT_TMP, { recursive: true, force: true });
});
