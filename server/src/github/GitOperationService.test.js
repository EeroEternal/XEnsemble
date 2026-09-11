const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { GitOperationService, GitError } = require('./GitOperationService');
const {
    stripCredentialFromUrl,
    createAskpassScript,
    removeAskpassScript,
    buildCredentialEnv,
} = require('./gitCredentialHelper');
const LocalFsAdapter = require('../runtime/LocalFsAdapter');

function hasGit() {
    return spawnSync('git', ['--version']).status === 0;
}

function makeMockExec(handler = () => '') {
    const calls = [];
    const fn = async (cmd, args, env, options) => {
        calls.push({ cmd, args, env, options });
        const out = typeof handler === 'function' ? handler(args) : '';
        return { exitCode: 0, stdout: out ?? '', stderr: '' };
    };
    fn.calls = calls;
    return fn;
}

function makeLocalExec() {
    return async (cmd, args, env, options = {}) => {
        const result = spawnSync(cmd, args, {
            cwd: options.cwd,
            env: { ...process.env, ...(env || {}) },
            encoding: 'utf8',
        });
        return {
            exitCode: result.status ?? 1,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
        };
    };
}

function findCall(calls, ...prefix) {
    return calls.find((c) => prefix.every((arg, i) => c.args[i] === arg));
}

describe('gitCredentialHelper', () => {
    it('stripCredentialFromUrl removes embedded credentials', () => {
        assert.strictEqual(
            stripCredentialFromUrl('https://user:pass@github.com/owner/repo.git'),
            'https://github.com/owner/repo.git',
        );
    });

    it('stripCredentialFromUrl leaves plain https URLs untouched', () => {
        assert.strictEqual(
            stripCredentialFromUrl('https://github.com/owner/repo.git'),
            'https://github.com/owner/repo.git',
        );
    });

    it('stripCredentialFromUrl leaves SSH-style URLs untouched', () => {
        assert.strictEqual(
            stripCredentialFromUrl('git@github.com:owner/repo.git'),
            'git@github.com:owner/repo.git',
        );
    });

    it('createAskpassScript writes an executable helper that echoes the token', () => {
        const token = 'gho_super_secret';
        const scriptPath = createAskpassScript(token);
        try {
            assert.ok(fs.existsSync(scriptPath));
            const stats = fs.statSync(scriptPath);
            assert.ok(stats.mode & 0o100, 'script should be executable');

            const result = spawnSync('/bin/sh', [scriptPath], {
                env: { ...process.env, GIT_ASKPASS_TOKEN: token },
                encoding: 'utf8',
            });
            assert.strictEqual(result.status, 0);
            assert.strictEqual(result.stdout.trim(), token);
        } finally {
            removeAskpassScript(scriptPath);
        }
        assert.ok(!fs.existsSync(scriptPath));
    });

    it('buildCredentialEnv returns GIT_ASKPASS env and a reusable cleanup function', () => {
        const token = 'token_123';
        const { env, cleanup } = buildCredentialEnv(token);
        try {
            assert.ok(env.GIT_ASKPASS);
            assert.ok(env.GIT_ASKPASS.endsWith('.sh'));
            assert.strictEqual(env.GIT_ASKPASS_TOKEN, token);
            assert.ok(fs.existsSync(env.GIT_ASKPASS));
        } finally {
            // cleanup is a no-op for cached scripts; the script persists
            // for reuse across calls and is cleaned up on process exit.
            cleanup();
        }
        // Cached script should still exist after cleanup (no-op).
        assert.ok(fs.existsSync(env.GIT_ASKPASS));
    });
});

describe('GitOperationService (mock exec)', () => {
    function createService(exec) {
        return new GitOperationService({
            exec,
            ensureProjectRuntime: async () => ({ workspacePath: '/workspace' }),
            getToken: async () => 'mock_token',
            // 单测走 mock exec，避免默认 boxlite 走 host git
            usesHostWorkspace: () => false,
        });
    }

    it('cloneRepo initializes, adds remote, fetches and checks out a branch', async () => {
        const exec = makeMockExec((args) => {
            if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return 'clone-sha\n';
            }
            return '';
        });
        const service = createService(exec);

        const result = await service.cloneRepo(
            { id: 'p1', userId: 'u1' },
            {
                repoUrl: 'https://TOKEN:x-oauth-basic@github.com/owner/repo.git',
                branch: 'main',
                depth: 1,
            },
        );

        assert.deepStrictEqual(result, { sha: 'clone-sha', branch: 'main' });

        assert.ok(findCall(exec.calls, 'init'));

        const remoteCall = findCall(exec.calls, 'remote', 'add', 'origin');
        assert.ok(remoteCall, 'remote add origin should be called');
        assert.strictEqual(
            remoteCall.args[3],
            'https://github.com/owner/repo.git',
            'remote URL should not contain the token',
        );

        const fetchCall = findCall(exec.calls, 'fetch', 'origin');
        assert.ok(fetchCall);
        assert.deepStrictEqual(fetchCall.args.slice(2), ['main', '--depth', '1']);
        assert.ok(fetchCall.env.GIT_ASKPASS, 'fetch should receive credential env');
        assert.strictEqual(fetchCall.env.GIT_ASKPASS_TOKEN, 'mock_token');

        const checkoutCall = findCall(exec.calls, 'checkout', '-f', '-b', 'main');
        assert.ok(checkoutCall);
        assert.strictEqual(checkoutCall.args[4], 'origin/main');
    });

    it('cloneRepo without branch fetches all refs and resolves the remote default branch', async () => {
        const exec = makeMockExec((args) => {
            if (args[0] === 'symbolic-ref' && args[1] === 'refs/remotes/origin/HEAD') {
                return 'refs/remotes/origin/master\n';
            }
            if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return 'clone-sha\n';
            }
            return '';
        });
        const service = createService(exec);

        const result = await service.cloneRepo(
            { id: 'p1', userId: 'u1', repoProvider: 'url' },
            { repoUrl: 'https://github.com/owner/repo.git' },
        );

        assert.deepStrictEqual(result, { sha: 'clone-sha', branch: 'master' });

        const fetchCall = findCall(exec.calls, 'fetch', 'origin');
        assert.ok(fetchCall);
        // 未指定分支：fetch 全量 refs，而不是 fetch origin <猜的分支>
        assert.deepStrictEqual(fetchCall.args.slice(2), []);

        const setHeadCall = findCall(exec.calls, 'remote', 'set-head', 'origin', '-a');
        assert.ok(setHeadCall, 'should query the remote HEAD symref');

        const checkoutCall = findCall(exec.calls, 'checkout', '-f', '-b', 'master');
        assert.ok(checkoutCall);
        assert.strictEqual(checkoutCall.args[4], 'origin/master');
    });

    it('cloneRepo updates existing remote origin', async () => {
        let remoteAddFailed = false;
        const exec = makeMockExec((args) => {
            if (args[0] === 'remote' && args[1] === 'add') {
                if (!remoteAddFailed) {
                    remoteAddFailed = true;
                    return { exitCode: 3, stdout: '', stderr: 'fatal: remote origin already exists' };
                }
            }
            if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return 'abc123\n';
            }
            return '';
        });
        // makeMockExec always returns exitCode 0; simulate a non-zero response manually.
        const failingExec = async (cmd, args, env, options) => {
            if (args[0] === 'remote' && args[1] === 'add' && !remoteAddFailed) {
                remoteAddFailed = true;
                return { exitCode: 3, stdout: '', stderr: 'fatal: remote origin already exists' };
            }
            return exec(cmd, args, env, options);
        };
        failingExec.calls = exec.calls;

        const service = createService(failingExec);
        await service.cloneRepo({ id: 'p2', userId: 'u1' }, { repoUrl: 'https://github.com/owner/repo.git', branch: 'dev' });

        const setUrlCall = findCall(exec.calls, 'remote', 'set-url', 'origin');
        assert.ok(setUrlCall);
        assert.strictEqual(setUrlCall.args[3], 'https://github.com/owner/repo.git');
    });

    it('cloneRepo falls back to the next credential on auth failure and tries anonymous last', async () => {
        const fetchAttempts = [];
        const exec = async (cmd, args, env, options) => {
            if (args[0] === 'fetch' && args[1] === 'origin') {
                fetchAttempts.push({ env });
                if (fetchAttempts.length === 1) {
                    return { exitCode: 128, stdout: '', stderr: "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://git.schkzy.com/x/y.git/'" };
                }
                if (fetchAttempts.length === 2) {
                    return { exitCode: 128, stdout: '', stderr: "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://git.schkzy.com/x/y.git/'" };
                }
                return { exitCode: 0, stdout: '', stderr: '' };
            }
            if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return { exitCode: 0, stdout: 'sha2\n', stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        };
        exec.calls = [];
        const service = new GitOperationService({
            exec,
            ensureProjectRuntime: async () => ({ workspacePath: '/workspace' }),
            resolveTokenCandidates: async () => [
                { provider: 'gitlab', token: 'token_bad', username: 'oauth2' },
                { provider: 'github', token: 'token_github', username: 'octocat' },
            ],
            usesHostWorkspace: () => false,
        });

        const result = await service.cloneRepo(
            { id: 'p1', userId: 'u1', repoProvider: 'url', repoUrl: 'https://git.schkzy.com/x/y.git' },
            { repoUrl: 'https://git.schkzy.com/x/y.git', branch: 'master' },
        );

        assert.strictEqual(result.sha, 'sha2');
        assert.strictEqual(fetchAttempts.length, 3, 'should try 2 credentials then anonymous');
        assert.strictEqual(fetchAttempts[0].env.GIT_ASKPASS_TOKEN, 'token_bad');
        assert.strictEqual(fetchAttempts[0].env.GIT_CONFIG_VALUE_0, 'oauth2');
        assert.strictEqual(fetchAttempts[1].env.GIT_ASKPASS_TOKEN, 'token_github');
        assert.strictEqual(fetchAttempts[2].env.GIT_ASKPASS_TOKEN, undefined, 'anonymous attempt has no askpass');
    });

    it('cloneRepo does not retry with other credentials on non-auth failures', async () => {
        const fetchAttempts = [];
        const exec = async (cmd, args, env, options) => {
            if (args[0] === 'fetch' && args[1] === 'origin') {
                fetchAttempts.push({ env });
                return { exitCode: 128, stdout: '', stderr: "fatal: repository 'https://git.schkzy.com/x/y.git/' not found" };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        };
        const service = new GitOperationService({
            exec,
            ensureProjectRuntime: async () => ({ workspacePath: '/workspace' }),
            resolveTokenCandidates: async () => [
                { provider: 'gitlab', token: 'token_bad', username: 'oauth2' },
                { provider: 'github', token: 'token_github', username: 'octocat' },
            ],
            usesHostWorkspace: () => false,
        });

        await assert.rejects(
            () => service.cloneRepo(
                { id: 'p1', userId: 'u1', repoProvider: 'url' },
                { repoUrl: 'https://git.schkzy.com/x/y.git', branch: 'master' },
            ),
            (err) => /not found/.test(err.message),
        );
        assert.strictEqual(fetchAttempts.length, 1, 'non-auth failure should not retry');
    });

    it('createBranch checks out a new branch and returns its sha', async () => {
        const exec = makeMockExec((args) => {
            if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return 'branch-sha\n';
            }
            return '';
        });
        const service = createService(exec);

        const result = await service.createBranch({ id: 'p1', userId: 'u1' }, 'feature', 'main');
        assert.deepStrictEqual(result, { branch: 'feature', sha: 'branch-sha' });

        const call = findCall(exec.calls, 'checkout', '-b', 'feature');
        assert.ok(call);
        assert.strictEqual(call.args[3], 'main');
    });

    it('switchBranch checks out an existing branch', async () => {
        const exec = makeMockExec((args) => {
            if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return 'switch-sha\n';
            }
            return '';
        });
        const service = createService(exec);

        const result = await service.switchBranch({ id: 'p1', userId: 'u1' }, 'main');
        assert.deepStrictEqual(result, { branch: 'main', sha: 'switch-sha' });
        assert.ok(findCall(exec.calls, 'checkout', 'main'));
    });

    it('deleteBranch deletes a branch', async () => {
        const exec = makeMockExec();
        const service = createService(exec);
        await service.deleteBranch({ id: 'p1', userId: 'u1' }, 'old-feature');
        assert.ok(findCall(exec.calls, 'branch', '-D', 'old-feature'));
    });

    it('listBranches parses local branches', async () => {
        const exec = makeMockExec(() => 'main|abc111|*\nfeature|def222|\n');
        const service = createService(exec);
        const branches = await service.listBranches({ id: 'p1', userId: 'u1' });
        assert.deepStrictEqual(branches, [
            { name: 'main', sha: 'abc111', current: true },
            { name: 'feature', sha: 'def222', current: false },
        ]);
    });

    it('getStatus reports working tree state and upstream divergence', async () => {
        const responses = new Map([
            [JSON.stringify(['rev-parse', '--abbrev-ref', 'HEAD']), 'dev\n'],
            [JSON.stringify(['rev-parse', 'HEAD']), 'status-sha\n'],
            [JSON.stringify(['--no-optional-locks', 'status', '--porcelain=v1', '-unormal']), 'M  staged.txt\n?? untracked.txt\n'],
            [JSON.stringify(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']), '2\t3\n'],
        ]);
        const exec = makeMockExec((args) => responses.get(JSON.stringify(args)) ?? '');
        const service = createService(exec);

        const status = await service.getStatus({ id: 'p1', userId: 'u1' });
        assert.deepStrictEqual(status, {
            branch: 'dev',
            sha: 'status-sha',
            dirty: true,
            staged: true,
            unstaged: false,
            untracked: true,
            merging: false,
            ahead: 2,
            behind: 3,
            truncated: false,
            files: [
                { path: 'staged.txt', status: 'M ', type: 'staged' },
                { path: 'untracked.txt', status: '??', type: 'untracked' },
            ],
            stagedFiles: [
                { path: 'staged.txt', status: 'M ', type: 'staged' },
            ],
            unstagedFiles: [
                { path: 'untracked.txt', status: '??', type: 'untracked' },
            ],
            conflicts: [],
        });
    });

    it('getStatus strips trailing slash from nested git directory entries', async () => {
        const responses = new Map([
            [JSON.stringify(['rev-parse', '--abbrev-ref', 'HEAD']), 'main\n'],
            [JSON.stringify(['rev-parse', 'HEAD']), 'sha\n'],
            [JSON.stringify(['--no-optional-locks', 'status', '--porcelain=v1', '-unormal']), '?? nested-repo/\n'],
            [JSON.stringify(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']), '0\t0\n'],
        ]);
        const exec = makeMockExec((args) => responses.get(JSON.stringify(args)) ?? '');
        const service = createService(exec);

        const status = await service.getStatus({ id: 'p-nested', userId: 'u1' });
        const untrackedEntry = status.files.find((f) => f.type === 'untracked');
        assert.ok(untrackedEntry, 'should have an untracked entry');
        assert.strictEqual(untrackedEntry.path, 'nested-repo', 'trailing slash should be stripped');
    });

    it('getStatus returns null divergence for detached HEAD instead of falling back to currentBranch', async () => {
        // Detached HEAD → rev-parse --abbrev-ref HEAD returns "HEAD" → branch=null.
        // Must NOT fall back to project.currentBranch (which could be 'main'
        // while the worktree is on its own session branch) — that would compare
        // against the wrong remote ref and show a bogus unpushed count.
        const responses = new Map([
            [JSON.stringify(['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD\n'],
            [JSON.stringify(['rev-parse', 'HEAD']), 'detached-sha\n'],
            [JSON.stringify(['--no-optional-locks', 'status', '--porcelain=v1', '-unormal']), ''],
            [JSON.stringify(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']), '7\t0\n'],
            [JSON.stringify(['rev-list', '--left-right', '--count', 'HEAD...origin/main']), '0\t0\n'],
        ]);
        const exec = makeMockExec((args) => responses.get(JSON.stringify(args)) ?? '');
        const service = createService(exec);

        const status = await service.getStatus({ id: 'p1', userId: 'u1', currentBranch: 'main' });
        assert.strictEqual(status.branch, null);
        assert.strictEqual(status.ahead, null, 'detached HEAD must not report a fabricated ahead');
        assert.strictEqual(status.behind, null);
    });

    it('getStatusLight computes divergence against origin/<branch> (same basis as full status)', async () => {
        // Light mode must use the same comparison basis as getStatus, so a
        // 15s light poll can never flip the UI between "N unpushed" (full)
        // and "0 unpushed" (the old --not --remotes behavior).
        const responses = new Map([
            [JSON.stringify(['rev-parse', '--abbrev-ref', 'HEAD']), 'agentharness/session-abc1\n'],
            [JSON.stringify(['--no-optional-locks', 'status', '--porcelain=v1', '-unormal']), ''],
            [JSON.stringify(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']), '17\t0\n'],
            [JSON.stringify(['rev-list', '--left-right', '--count', 'HEAD...origin/agentharness/session-abc1']), '17\t0\n'],
            [JSON.stringify(['rev-list', '--count', 'HEAD', '--not', '--remotes']), '0\n'],
        ]);
        const exec = makeMockExec((args) => responses.get(JSON.stringify(args)) ?? '');
        const service = createService(exec);

        const status = await service.getStatusLight({ id: 'p1', userId: 'u1', currentBranch: 'main' });
        assert.strictEqual(status.branch, 'agentharness/session-abc1');
        assert.strictEqual(status.ahead, 17, 'light must agree with full status basis');
        assert.strictEqual(status.behind, 0);
    });

    it('getStatusLight collapses large untracked directories with a file count', async () => {
        // node_modules 这类上万文件的 untracked 目录必须保持折叠（一行）并
        // 统计文件数下发，否则 status 响应和前端渲染都会被拖垮。
        const responses = new Map([
            [JSON.stringify(['rev-parse', '--abbrev-ref', 'HEAD']), 'main\n'],
            [JSON.stringify(['--no-optional-locks', 'status', '--porcelain=v1', '-unormal']), '?? node_modules/\n?? src/app.js\n'],
            [JSON.stringify(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']), '0\t0\n'],
        ]);
        const exec = makeMockExec((args) => {
            // sh -c 调用：args = ['-c', script, 'sh', dir]
            if (args[0] === '-c') {
                if (args[3] === 'node_modules' && args[1].includes('head -n 51')) {
                    return Array.from({ length: 51 }, (_, i) => `node_modules/pkg_${i}/index.js`).join('\n') + '\n';
                }
                if (args[3] === 'node_modules' && args[1].includes('wc -l')) {
                    return '30000\n';
                }
                return '';
            }
            return responses.get(JSON.stringify(args)) ?? '';
        });
        const service = createService(exec);

        const status = await service.getStatusLight({ id: 'p1', userId: 'u1' });
        const dirEntry = status.files.find((f) => f.path === 'node_modules/');
        assert.ok(dirEntry, 'large untracked dir should stay collapsed');
        assert.strictEqual(dirEntry.type, 'untracked-dir');
        assert.strictEqual(dirEntry.count, 30000);
        assert.strictEqual(dirEntry.status, '??');
        assert.strictEqual(status.files.find((f) => f.path === 'src/app.js').type, 'untracked');
        assert.strictEqual(status.dirty, true);
        assert.strictEqual(status.truncated, false);
    });

    it('getStatusLight marks truncated and stops expanding beyond the entry cap', async () => {
        // 11 个 50 文件的目录：前 10 个展开（10×50=500 达到上限），第 11 个保持折叠
        const dirNames = Array.from({ length: 11 }, (_, i) => `gen_${i}`);
        const statusLines = dirNames.map((d) => `?? ${d}/`).join('\n');
        const exec = makeMockExec((args) => {
            if (args[0] === '-c') {
                if (args[3] && args[3].startsWith('gen_') && args[1].includes('head -n 51')) {
                    return Array.from({ length: 50 }, (_, i) => `${args[3]}/f${i}.txt`).join('\n') + '\n';
                }
                return '';
            }
            if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n';
            if (args[0] === '--no-optional-locks' && args[1] === 'status') return statusLines;
            return '';
        });
        const service = createService(exec);

        const status = await service.getStatusLight({ id: 'p1', userId: 'u1' });
        assert.strictEqual(status.truncated, true);
        assert.strictEqual(status.files.filter((f) => f.type === 'untracked').length, 500);
        const collapsed = status.files.find((f) => f.path === 'gen_10/');
        assert.ok(collapsed, 'the 11th directory must stay collapsed');
        assert.strictEqual(collapsed.type, 'untracked-dir');
    });

    it('commitAll stages and commits', async () => {
        const exec = makeMockExec((args) => {
            if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return 'commit-sha\n';
            }
            // Return non-empty for status --porcelain so commit path is taken.
            if (args[0] === 'status' && args[1] === '--porcelain') {
                return ' M file.txt\n';
            }
            return '';
        });
        const service = createService(exec);
        const result = await service.commitAll({ id: 'p1', userId: 'u1' }, 'WIP');
        assert.deepStrictEqual(result, { sha: 'commit-sha', committed: true });
        assert.ok(findCall(exec.calls, 'add', '-A'));
        const commitCall = findCall(exec.calls, 'commit', '-m');
        assert.ok(commitCall);
        assert.strictEqual(commitCall.args[2], 'WIP');
    });

    it('commitAll skips commit when nothing to commit', async () => {
        const exec = makeMockExec((args) => {
            if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return 'head-sha\n';
            }
            return ''; // empty status --porcelain => clean workspace
        });
        const service = createService(exec);
        const result = await service.commitAll({ id: 'p1', userId: 'u1' }, 'WIP');
        assert.deepStrictEqual(result, { sha: 'head-sha', committed: false });
        // Should NOT have attempted a commit.
        assert.strictEqual(findCall(exec.calls, 'commit', '-m'), undefined);
    });

    it('pushBranch pushes and uses credentials', async () => {
        const exec = makeMockExec((args) => {
            if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return 'push-sha\n';
            }
            return '';
        });
        const service = createService(exec);
        const result = await service.pushBranch({ id: 'p1', userId: 'u1' }, 'feature', { force: true });
        assert.deepStrictEqual(result, { sha: 'push-sha' });
        const pushCall = findCall(exec.calls, 'push', '-u', 'origin', 'feature');
        assert.ok(pushCall);
        assert.strictEqual(pushCall.args[4], '--force');
        assert.ok(pushCall.env.GIT_ASKPASS);
    });

    it('getDiff returns diff output', async () => {
        const exec = makeMockExec(() => 'diff-output');
        const service = createService(exec);
        const diff = await service.getDiff({ id: 'p1', userId: 'u1' }, { base: 'HEAD~1' });
        assert.strictEqual(diff.diff, 'diff-output');
        assert.strictEqual(diff.truncated, false);
        assert.deepStrictEqual(findCall(exec.calls, 'diff').args, ['diff', 'HEAD~1']);

        await service.getDiff({ id: 'p1', userId: 'u1' }, { base: 'main', head: 'feature' });
        assert.deepStrictEqual(findCall(exec.calls, 'diff', 'main', 'feature').args, [
            'diff',
            'main',
            'feature',
        ]);
    });

    it('getLog parses commits', async () => {
        const record1 = 'sha1\x1Ffirst\x1FAlice <alice@example.com>\x1F2024-01-01T00:00:00Z';
        const record2 = 'sha2\x1Fsecond\x1FBob <bob@example.com>\x1F2024-01-02T00:00:00Z';
        const exec = makeMockExec(() => `${record1}\x1E${record2}\x1E`);
        const service = createService(exec);
        const log = await service.getLog({ id: 'p1', userId: 'u1' }, { branch: 'main', limit: 5 });
        assert.strictEqual(log.length, 2);
        assert.deepStrictEqual(log[0], {
            sha: 'sha1',
            message: 'first',
            author: 'Alice <alice@example.com>',
            date: '2024-01-01T00:00:00Z',
        });
        const call = findCall(exec.calls, 'log', 'main');
        assert.ok(call);
        assert.strictEqual(call.args.includes('-n'), true);
        assert.strictEqual(call.args.includes('5'), true);
    });

    it('getFileDiffView returns HEAD and working tree content in parallel', async () => {
        const exec = makeMockExec((args) => {
            if (args[0] === 'show' && args[1] === 'HEAD:src/app.js') return 'HEAD content\n';
            return '';
        });
        const fsCalls = [];
        const mockFs = {
            fsRead: async (root, rel, opts) => {
                fsCalls.push({ root, rel, opts });
                return 'working tree content\n';
            },
        };
        const service = new GitOperationService({
            exec,
            fs: mockFs,
            ensureProjectRuntime: async () => ({ workspacePath: '/workspace' }),
            getToken: async () => undefined,
            usesHostWorkspace: () => false,
        });

        const result = await service.getFileDiffView({ id: 'p1', userId: 'u1' }, 'src/app.js');
        assert.strictEqual(result.original, 'HEAD content\n');
        assert.strictEqual(result.modified, 'working tree content\n');
        assert.ok(findCall(exec.calls, 'show', 'HEAD:src/app.js'), 'should call git show HEAD:path');
        assert.strictEqual(fsCalls.length, 1, 'should call fsRead once');
        assert.strictEqual(fsCalls[0].rel, 'src/app.js');
    });

    it('getFileDiffView returns empty original for new (untracked) file', async () => {
        const exec = async () => ({ exitCode: 1, stdout: '', stderr: 'fatal: path does not exist' });
        const mockFs = { fsRead: async () => 'new file content' };
        const service = new GitOperationService({
            exec,
            fs: mockFs,
            ensureProjectRuntime: async () => ({ workspacePath: '/workspace' }),
            getToken: async () => undefined,
            usesHostWorkspace: () => false,
        });

        const result = await service.getFileDiffView({ id: 'p1', userId: 'u1' }, 'new.txt');
        assert.strictEqual(result.original, '');
        assert.strictEqual(result.modified, 'new file content');
    });

    it('getFileDiffView returns empty modified for deleted file', async () => {
        const exec = makeMockExec(() => 'HEAD content\n');
        const mockFs = { fsRead: async () => { throw new Error('File not found'); } };
        const service = new GitOperationService({
            exec,
            fs: mockFs,
            ensureProjectRuntime: async () => ({ workspacePath: '/workspace' }),
            getToken: async () => undefined,
            usesHostWorkspace: () => false,
        });

        const result = await service.getFileDiffView({ id: 'p1', userId: 'u1' }, 'deleted.txt');
        assert.strictEqual(result.original, 'HEAD content\n');
        assert.strictEqual(result.modified, '');
    });

    it('local operations work even when token resolution throws', async () => {
        const tokenErr = new Error('gitlab token 已过期且自动刷新失败，请重新认证');
        const responses = new Map([
            [JSON.stringify(['rev-parse', '--abbrev-ref', 'HEAD']), 'main\n'],
            [JSON.stringify(['rev-parse', 'HEAD']), 'sha\n'],
            [JSON.stringify(['--no-optional-locks', 'status', '--porcelain=v1', '-unormal']), ' M modified.txt\n'],
            [JSON.stringify(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']), '0\t0\n'],
        ]);
        const exec = makeMockExec((args) => responses.get(JSON.stringify(args)) ?? '');
        const service = new GitOperationService({
            exec,
            ensureProjectRuntime: async () => ({ workspacePath: '/workspace' }),
            getToken: async () => { throw tokenErr; },
            usesHostWorkspace: () => false,
        });

        const status = await service.getStatus({ id: 'p1', userId: 'u1', repoProvider: 'gitlab' });
        assert.ok(status.dirty, 'dirty should be true');
        assert.strictEqual(status.unstagedFiles.length, 1);
        assert.strictEqual(status.unstagedFiles[0].path, 'modified.txt');
    });

    it('push still surfaces token errors for remote operations', async () => {
        const tokenErr = new Error('gitlab token 已过期且自动刷新失败，请重新认证');
        const exec = makeMockExec(() => '');
        const service = new GitOperationService({
            exec,
            ensureProjectRuntime: async () => ({ workspacePath: '/workspace' }),
            getToken: async () => { throw tokenErr; },
            usesHostWorkspace: () => false,
        });

        await assert.rejects(
            () => service.pushBranch({ id: 'p1', userId: 'u1', repoProvider: 'gitlab' }, 'main'),
            (err) => err.message.includes('token 已过期'),
        );
    });
});

describe('GitOperationService (real git)', { skip: !hasGit() }, () => {
    let tmpRoot;
    let origin;
    let workspacePath;
    let service;

    function git(args, cwd) {
        const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
        if (result.status !== 0) {
            throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
        }
        return result;
    }

    before(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ops-'));
        origin = path.join(tmpRoot, 'origin.git');
        workspacePath = path.join(tmpRoot, 'workspace');
        fs.mkdirSync(workspacePath, { recursive: true });

        git(['init', '--bare', 'origin.git'], tmpRoot);

        const seed = path.join(tmpRoot, 'seed');
        fs.mkdirSync(seed, { recursive: true });
        git(['init', '-b', 'main'], seed);
        git(['config', 'user.email', 'seed@example.com'], seed);
        git(['config', 'user.name', 'Seed'], seed);
        fs.writeFileSync(path.join(seed, 'README.md'), 'hello');
        git(['add', '.'], seed);
        git(['commit', '-m', 'initial'], seed);
        git(['remote', 'add', 'origin', origin], seed);
        git(['push', 'origin', 'main'], seed);

        service = new GitOperationService({
            ensureProjectRuntime: async () => ({ workspacePath }),
            getToken: async () => undefined,
            exec: makeLocalExec(),
            fs: new LocalFsAdapter(),
            usesHostWorkspace: () => false,
        });

        await service.cloneRepo({ id: 'p1', userId: 'u1' }, { repoUrl: origin, branch: 'main' });
        git(['config', 'user.email', 'test@example.com'], workspacePath);
        git(['config', 'user.name', 'Tester'], workspacePath);
    });

    after(() => {
        if (tmpRoot) {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('cloneRepo resolves a non-main remote default branch when branch is omitted', async () => {
        const originMaster = path.join(tmpRoot, 'origin-master.git');
        git(['init', '--bare', 'origin-master.git'], tmpRoot);

        const seed = path.join(tmpRoot, 'seed-master');
        fs.mkdirSync(seed, { recursive: true });
        git(['init', '-b', 'master'], seed);
        git(['config', 'user.email', 'seed@example.com'], seed);
        git(['config', 'user.name', 'Seed'], seed);
        fs.writeFileSync(path.join(seed, 'README.md'), 'hello-master');
        git(['add', '.'], seed);
        git(['commit', '-m', 'initial'], seed);
        git(['remote', 'add', 'origin', originMaster], seed);
        git(['push', 'origin', 'master'], seed);

        const ws = path.join(tmpRoot, 'workspace-master');
        fs.mkdirSync(ws, { recursive: true });
        const svc = new GitOperationService({
            ensureProjectRuntime: async () => ({ workspacePath: ws }),
            getToken: async () => undefined,
            exec: makeLocalExec(),
            fs: new LocalFsAdapter(),
            usesHostWorkspace: () => false,
        });

        // 模拟用户 URL 导入时未指定分支：必须解析出 master 而非报 "couldn't find remote ref main"
        const result = await svc.cloneRepo(
            { id: 'p2', userId: 'u1', repoProvider: 'url' },
            { repoUrl: originMaster },
        );
        assert.strictEqual(result.branch, 'master');

        const status = await svc.getStatus({ id: 'p2', userId: 'u1' });
        assert.strictEqual(status.branch, 'master');
    });

    it('clones a real repo into an existing workspace directory', async () => {
        const status = await service.getStatus({ id: 'p1', userId: 'u1' });
        assert.strictEqual(status.branch, 'main');
        assert.ok(status.sha);
        assert.strictEqual(status.dirty, false);
    });

    it('creates, switches and lists branches', async () => {
        await service.createBranch({ id: 'p1', userId: 'u1' }, 'feature', 'main');
        let branches = await service.listBranches({ id: 'p1', userId: 'u1' });
        let feature = branches.find((b) => b.name === 'feature');
        assert.ok(feature);
        assert.strictEqual(feature.current, true);

        await service.switchBranch({ id: 'p1', userId: 'u1' }, 'main');
        branches = await service.listBranches({ id: 'p1', userId: 'u1' });
        assert.strictEqual(branches.find((b) => b.name === 'main').current, true);
    });

    it('commits and pushes changes', async () => {
        await service.switchBranch({ id: 'p1', userId: 'u1' }, 'feature');
        fs.writeFileSync(path.join(workspacePath, 'feature.txt'), 'new work');

        let status = await service.getStatus({ id: 'p1', userId: 'u1' });
        assert.strictEqual(status.dirty, true);
        assert.strictEqual(status.untracked, true);

        const commit = await service.commitAll({ id: 'p1', userId: 'u1' }, 'add feature file');
        assert.ok(commit.sha);

        status = await service.getStatus({ id: 'p1', userId: 'u1' });
        assert.strictEqual(status.dirty, false);

        const push = await service.pushBranch({ id: 'p1', userId: 'u1' }, 'feature');
        assert.ok(push.sha);
    });

    it('returns log entries and diffs', async () => {
        const log = await service.getLog({ id: 'p1', userId: 'u1' }, { branch: 'feature', limit: 10 });
        assert.ok(log.length >= 2);
        assert.ok(log[0].sha);
        assert.ok(log[0].message);
        assert.ok(log[0].author);
        assert.ok(log[0].date);

        fs.writeFileSync(path.join(workspacePath, 'README.md'), 'changed');
        const diff = await service.getDiff({ id: 'p1', userId: 'u1' });
        assert.ok(diff.diff.includes('README.md'));
    });

    it('getFileDiffView returns HEAD and working tree content for modified file', async () => {
        await service.switchBranch({ id: 'p1', userId: 'u1' }, 'main');
        fs.writeFileSync(path.join(workspacePath, 'README.md'), 'modified content');

        const view = await service.getFileDiffView({ id: 'p1', userId: 'u1' }, 'README.md');
        assert.strictEqual(view.original, 'hello');
        assert.strictEqual(view.modified, 'modified content');
    });

    it('getFileDiffView returns empty original for new (untracked) file', async () => {
        fs.writeFileSync(path.join(workspacePath, 'brand_new.txt'), 'fresh');

        const view = await service.getFileDiffView({ id: 'p1', userId: 'u1' }, 'brand_new.txt');
        assert.strictEqual(view.original, '');
        assert.strictEqual(view.modified, 'fresh');
    });

    it('getFileDiffView returns empty modified for deleted file', async () => {
        fs.writeFileSync(path.join(workspacePath, 'doomed.txt'), 'will be deleted');
        git(['add', 'doomed.txt'], workspacePath);
        git(['commit', '-m', 'add doomed'], workspacePath);
        fs.unlinkSync(path.join(workspacePath, 'doomed.txt'));

        const view = await service.getFileDiffView({ id: 'p1', userId: 'u1' }, 'doomed.txt');
        assert.strictEqual(view.original, 'will be deleted');
        assert.strictEqual(view.modified, '');
    });
});
