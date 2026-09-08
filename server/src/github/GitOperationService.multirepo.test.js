const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 临时 WORKSPACE_ROOT（GitOperationService 经 workspace.projectDir 计算宿主路径）
const WORKSPACE_ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-gops-mr-'));
process.env.WORKSPACE_ROOT = WORKSPACE_ROOT_TMP;

const { GitOperationService } = require('./GitOperationService');
const workspace = require('../workspace');

const PROJECT = { id: 'p1', userId: 'u1', repoDefaultBranch: 'main' };

function makeSvc(deps = {}) {
    return new GitOperationService({
        usesHostWorkspace: () => true,
        getToken: async () => undefined,
        ...deps,
    });
}

test('无 repoSubPath：路由到 projectDir（原行为不变）', async () => {
    const calls = [];
    const svc = makeSvc({
        hostGit: async (hostPath, args, opts) => {
            calls.push({ hostPath, opts });
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    });
    await svc.getStatus(PROJECT);
    assert.match(calls[0].hostPath, /u1[\\/]p1$/);
    assert.equal(calls[0].opts.gitDir, null);
});

test('repoSubPath 无 runtimeId：路由到 projectDir/<subPath>', async () => {
    const calls = [];
    const svcRepo = makeSvc({
        hostGit: async (hostPath, args, opts) => {
            calls.push({ hostPath, opts });
            return { exitCode: 0, stdout: '', stderr: '' };
        },
        repoSubPath: 'frontend',
    });
    await svcRepo.getStatus(PROJECT);
    assert.ok(calls.length > 0);
    for (const c of calls) {
        assert.match(c.hostPath, /u1[\\/]p1[\\/]frontend$/);
    }
});

test('repoSubPath + runtimeId：路由到 repo worktree，gitDir 指向 <subPath>/.git/worktrees/<subPath>', async () => {
    // 构造 worktree 结构：wt/<runtimeId>/<subPath>/.git（文件即可，只验证存在性）
    const wtDir = workspace.repoWorktreePath('u1', 'p1', 'rt_1', 'frontend');
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: fake');
    // 主仓 .git/worktrees/frontend admin 目录
    const mainGitDir = path.join(workspace.projectDir('u1', 'p1'), 'frontend', '.git', 'worktrees', 'frontend');
    fs.mkdirSync(mainGitDir, { recursive: true });

    const calls = [];
    const svc = makeSvc({
        hostGit: async (hostPath, args, opts) => {
            calls.push({ hostPath, opts });
            return { exitCode: 0, stdout: '', stderr: '' };
        },
        repoSubPath: 'frontend',
        runtimeId: 'rt_1',
    });
    await svc.getStatus(PROJECT);

    assert.match(calls[0].hostPath, /p1\.wt[\\/]rt_1[\\/]frontend$/);
    assert.match(calls[0].opts.gitDir, /p1[\\/]frontend[\\/]\.git[\\/]worktrees[\\/]frontend$/);
    assert.equal(calls[0].opts.workTree, wtDir);
});

test('无 repoSubPath + runtimeId：原 worktree 路由不变', async () => {
    const wtDir = workspace.worktreeDir('u1', 'p1', 'rt_legacy');
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: fake');
    const mainWorktrees = path.join(workspace.projectDir('u1', 'p1'), '.git', 'worktrees', 'rt_legacy');
    fs.mkdirSync(mainWorktrees, { recursive: true });

    const calls = [];
    const svc = makeSvc({
        hostGit: async (hostPath, args, opts) => {
            calls.push({ hostPath, opts });
            return { exitCode: 0, stdout: '', stderr: '' };
        },
        runtimeId: 'rt_legacy',
    });
    await svc.getStatus(PROJECT);
    assert.equal(calls[0].hostPath, wtDir);
    assert.match(calls[0].opts.gitDir, /\.git[\\/]worktrees[\\/]rt_legacy$/);
});

test.after(() => {
    fs.rmSync(WORKSPACE_ROOT_TMP, { recursive: true, force: true });
});
