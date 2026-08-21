const fs = require('fs');
const path = require('path');
const { getRuntime } = require('../runtime/registry');
const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const { stripCredentialFromUrl, buildCredentialEnv } = require('./gitCredentialHelper');
const workspace = require('../workspace');
const { assertRepoRelativePath, assertGitRef, assertGitBranch } = require('../git/gitValidation');
const { withProjectGitLock } = require('../git/gitMutationLock');
const { limitDiffText, limitFileSide } = require('../git/diffUtils');
const { hostGit, usesHostWorkspace } = require('../git/hostGit');

class GitError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'GitError';
        this.code = code;
    }
}

const REMOTE_GIT_COMMANDS = new Set(['fetch', 'push', 'pull', 'ls-remote', 'clone']);

const aheadBehindCache = new Map();
const AHEAD_BEHIND_TTL_MS = 60_000;
const CONFLICT_STATUSES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

async function defaultGetToken(project) {
    const provider = project.repoProvider;
    if (!provider || provider === 'none' || provider === 'local_git') {
        return undefined;
    }
    const { GitConnectionService } = require('../git/GitConnectionService');
    return new GitConnectionService().getDecryptedToken(project.userId, provider);
}

class GitOperationService {
    constructor(deps = {}) {
        this.exec = deps.exec ?? getRuntime().exec;
        this.fs = deps.fs ?? getRuntime().fs;
        this._runtimeId = deps.runtimeId || null;
        const origEnsure = deps.ensureProjectRuntime ?? ensureProjectRuntime;
        this.ensureProjectRuntime = async (project, opts = {}) => {
            return origEnsure(project, { ...(this._runtimeId ? { runtimeId: this._runtimeId } : {}), ...opts });
        };
        this.getToken = deps.getToken ?? defaultGetToken;
        // local/boxlite：workspace 在宿主机（BoxLite virtiofs），Changes 用 host git，
        // 避免依赖 VM 内是否安装 git / runtime 是否 ready。
        this.usesHostWorkspace = deps.usesHostWorkspace ?? usesHostWorkspace;
        this.hostGit = deps.hostGit ?? hostGit;
    }

    _execFn() {
        if (typeof this.exec === 'function') {
            return this.exec;
        }
        if (typeof this.exec?.exec === 'function') {
            return this.exec.exec.bind(this.exec);
        }
        throw new GitError('No usable exec adapter provided to GitOperationService');
    }

    async _execGit(project, args, options = {}) {
        const needsToken = options.needsToken ?? REMOTE_GIT_COMMANDS.has(args[0]);
        const token = needsToken ? await this._resolveToken(project) : undefined;
        let hostPath = workspace.projectDir(project.userId, project.id);

        // If a runtimeId is set (session-scoped), prefer the worktree path.
        if (this._runtimeId) {
            const wtPath = workspace.worktreeDir(project.userId, project.id, this._runtimeId);
            if (fs.existsSync(path.join(wtPath, '.git'))) {
                hostPath = wtPath;
            }
        }

        if (this.usesHostWorkspace()) {
            fs.mkdirSync(hostPath, { recursive: true });
            const credentials = token ? buildCredentialEnv(token, hostPath, hostPath) : null;
            try {
                const result = await this.hostGit(hostPath, args, {
                    timeoutMs: options.timeoutMs || 120_000,
                    env: credentials ? credentials.env : {},
                });
                return { ...result, workspacePath: hostPath };
            } catch (err) {
                const code = err.exitCode ?? 1;
                throw new GitError(
                    `git ${args.join(' ')} failed (${code}): ${err.message}`,
                    code,
                );
            } finally {
                if (credentials) credentials.cleanup();
            }
        }

        const ready = await this.ensureProjectRuntime(project);
        const workspacePath = ready.workspacePath;
        const runtimeRef = ready.runtime ? ready.runtime.runtimeRef : undefined;
        const credentials = token ? buildCredentialEnv(token, hostPath, workspacePath) : null;

        try {
            const exec = this._execFn();
            const result = await exec(
                'git',
                args,
                credentials ? credentials.env : {},
                { cwd: workspacePath, runtimeRef, timeoutMs: 120_000, ...options },
            );

            if (result.exitCode !== 0) {
                throw new GitError(
                    `git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
                    result.exitCode,
                );
            }

            return { ...result, workspacePath };
        } finally {
            if (credentials) {
                credentials.cleanup();
            }
        }
    }

    async _resolveToken(project) {
        if (!this.getToken) {
            return undefined;
        }
        return this.getToken(project);
    }

    _mutate(project, fn) {
        return withProjectGitLock(project?.id, fn);
    }

    _invalidateAheadBehind(projectId) {
        aheadBehindCache.delete(this._cacheKey(projectId));
    }

    _cacheKey(projectId) {
        return this._runtimeId ? `${projectId}:${this._runtimeId}` : projectId;
    }

    async _revParse(project, ref) {
        const { stdout } = await this._execGit(project, ['rev-parse', ref]);
        return stdout.trim();
    }

    async cloneRepo(project, { repoUrl, branch, depth } = {}) {
        if (!repoUrl) {
            throw new GitError('repoUrl is required');
        }

        const cleanUrl = stripCredentialFromUrl(repoUrl);

        await this._execGit(project, ['init']);

        try {
            await this._execGit(project, ['remote', 'add', 'origin', cleanUrl]);
        } catch (err) {
            if (err.message.includes('remote origin already exists')) {
                await this._execGit(project, ['remote', 'set-url', 'origin', cleanUrl]);
            } else {
                throw err;
            }
        }

        const fetchArgs = ['fetch', 'origin'];
        if (branch) {
            fetchArgs.push(branch);
        }
        if (depth) {
            fetchArgs.push('--depth', String(depth));
        }
        await this._execGit(project, fetchArgs);

        let localBranch = branch;
        if (!localBranch) {
            const { stdout } = await this._execGit(project, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
            const remoteRef = stdout.trim();
            localBranch = remoteRef.replace(/^origin\//, '');
            await this._execGit(project, ['checkout', '-b', localBranch, remoteRef]);
        } else {
            await this._execGit(project, ['checkout', '-b', localBranch, `origin/${localBranch}`]);
        }

        // Set local git config so agent-side `git commit` inside the VM works
        // without requiring global config. ensureGitInit skips repos that
        // already have .git, so cloned repos never get the config otherwise.
        await this._execGit(project, ['config', 'user.email', 'xensemble@local']);
        await this._execGit(project, ['config', 'user.name', 'XEnsemble']);

        const sha = await this._revParse(project, 'HEAD');
        return { sha, branch: localBranch };
    }

    async createBranch(project, branchName, baseBranch) {
        return this._mutate(project, async () => {
            const args = ['checkout', '-b', assertGitBranch(branchName)];
            if (baseBranch) {
                args.push(assertGitRef(baseBranch));
            }
            await this._execGit(project, args);
            const sha = await this._revParse(project, 'HEAD');
            return { branch: branchName, sha };
        });
    }

    async switchBranch(project, branchName) {
        return this._mutate(project, async () => {
            const safeBranch = assertGitBranch(branchName);
            try {
                await this._execGit(project, ['checkout', safeBranch]);
            } catch (err) {
                const remoteRef = `origin/${safeBranch}`;
                try {
                    await this._execGit(project, ['rev-parse', '--verify', '--quiet', remoteRef]);
                    await this._execGit(project, ['checkout', '-b', safeBranch, remoteRef]);
                } catch {
                    throw err;
                }
            }

            const sha = await this._revParse(project, 'HEAD');
            return { branch: branchName, sha };
        });
    }

    async deleteBranch(project, branchName) {
        return this._mutate(project, async () => {
            await this._execGit(project, ['branch', '-D', assertGitBranch(branchName)]);
        });
    }

    async listBranches(project) {
        const { stdout } = await this._execGit(project, [
            'for-each-ref',
            'refs/heads/',
            '--format=%(refname:short)|%(objectname:short)|%(HEAD)',
        ]);

        return stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [name, sha, head] = line.split('|');
                if (!name || !sha) {
                    return null;
                }
                return {
                    name,
                    sha,
                    current: head === '*',
                };
            })
            .filter(Boolean);
    }

    async _expandDirEntries(project, lines) {
        const expanded = [];
        for (const line of lines) {
            if (line.length < 3) { expanded.push(line); continue; }
            const filePath = line.slice(3).trim();
            if (!filePath.endsWith('/')) { expanded.push(line); continue; }
            const dir = filePath.replace(/\/$/, '');
            try {
                const ready = await this.ensureProjectRuntime(project);
                const runtimeRef = ready.runtime ? ready.runtime.runtimeRef : undefined;
                const exec = this._execFn();
                const result = await exec('find', [dir, '-type', 'f', '-not', '-path', '*/.git/*'], {}, {
                    cwd: ready.workspacePath, runtimeRef, timeoutMs: 10_000,
                });
                if (result.exitCode === 0 && result.stdout.trim()) {
                    for (const f of result.stdout.split('\n').filter(Boolean)) {
                        expanded.push(`?? ${f}`);
                    }
                } else {
                    expanded.push(line.replace(/\/$/, ''));
                }
            } catch {
                expanded.push(line.replace(/\/$/, ''));
            }
        }
        return expanded;
    }

    async getStatusLight(project) {
        const statusOut = await this._execGit(project, ['status', '--porcelain=v1', '-uall']).catch(() => ({ stdout: '' }));
        let lines = statusOut.stdout.split('\n').filter(Boolean);
        lines = await this._expandDirEntries(project, lines);
        const files = [];
        let dirty = false;
        const stagedFiles = [];
        const unstagedFiles = [];
        for (const line of lines) {
            if (line.length < 2) continue;
            const x = line[0];
            const y = line[1];
            const filePath = line.slice(3).trim();
            const entry = { path: filePath, status: x + y };
            if (x === '?' && y === '?') {
                dirty = true;
                entry.type = 'untracked';
            } else {
                if (x !== ' ') dirty = true;
                if (y !== ' ') dirty = true;
                if (x !== ' ' && y !== ' ') {
                    entry.type = 'both';
                } else if (x !== ' ') {
                    entry.type = 'staged';
                } else {
                    entry.type = 'modified';
                }
            }
            files.push(entry);
            if (x !== ' ' && x !== '?') stagedFiles.push(entry);
            if (y !== ' ') unstagedFiles.push(entry);
        }
        return { files, stagedFiles, unstagedFiles, dirty };
    }

    async getStatus(project) {
        const [branchOut, shaOut, statusOut] = await Promise.all([
            this._execGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']).catch((err) => {
                console.warn('[GitOperationService] getStatus rev-parse branch failed:', err.message);
                return { stdout: 'HEAD' };
            }),
            this._execGit(project, ['rev-parse', 'HEAD']).catch((err) => {
                console.warn('[GitOperationService] getStatus rev-parse HEAD failed:', err.message);
                return { stdout: '' };
            }),
            this._execGit(project, ['status', '--porcelain=v1', '-uall']).catch((err) => {
                console.warn('[GitOperationService] getStatus status failed:', err.message);
                return { stdout: '' };
            }),
        ]);

        let branch = branchOut.stdout.trim();
        if (branch === 'HEAD') {
            branch = null;
        }
        const sha = shaOut.stdout.trim() || null;

        let lines = statusOut.stdout.split('\n').filter(Boolean);
        lines = await this._expandDirEntries(project, lines);

        // check-ignore 只对 untracked 文件有意义（已跟踪文件不受 .gitignore 影响）
        const untrackedPaths = lines
            .filter((line) => line.length >= 3 && line[0] === '?' && line[1] === '?')
            .map((line) => line.slice(3).trim());

        // ahead/behind 只在 commit/push/pull 后变化，缓存 60s 避免每次 status 都跑 rev-list
        const cacheKey = this._cacheKey(project.id);
        const cachedAheadBehind = aheadBehindCache.get(cacheKey);
        const aheadBehindFresh = cachedAheadBehind && cachedAheadBehind.expiresAt > Date.now();

        const [ignoredResult, aheadBehindResult] = await Promise.all([
            // check-ignore：检查哪些 untracked 文件被 .gitignore 匹配
            untrackedPaths.length > 0
                ? this._execGit(project, ['check-ignore', ...untrackedPaths])
                    .then((r) => new Set(r.stdout.split('\n').filter(Boolean)))
                    .catch(() => new Set())
                : Promise.resolve(new Set()),
            // ahead/behind：有缓存时直接用，否则并行尝试 @{upstream} 和 origin/<branch>
            // Worktrees use detached HEAD, so branch may be null. Fall back to
            // project.currentBranch for the origin comparison.
            aheadBehindFresh
                ? Promise.resolve(cachedAheadBehind)
                : (async () => {
                    const remoteBranch = branch || project.currentBranch;
                    const candidates = [
                        this._execGit(project, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
                    ];
                    if (remoteBranch) {
                        candidates.push(
                            this._execGit(project, ['rev-list', '--left-right', '--count', `HEAD...origin/${remoteBranch}`]),
                        );
                    }
                    try {
                        const r = await Promise.any(candidates);
                        const [a, b] = r.stdout.trim().split('\t').map((n) => Number(n) || 0);
                        const result = { ahead: a, behind: b, expiresAt: Date.now() + AHEAD_BEHIND_TTL_MS };
                        aheadBehindCache.set(cacheKey, result);
                        return result;
                    } catch {
                        try {
                            const r2 = await this._execGit(project, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
                            const ahead = Number(r2.stdout.trim()) || 0;
                            const result = { ahead, behind: 0, expiresAt: Date.now() + AHEAD_BEHIND_TTL_MS };
                            aheadBehindCache.set(cacheKey, result);
                            return result;
                        } catch {
                            return { ahead: 0, behind: 0 };
                        }
                    }
                })(),
        ]);

        const ignoredSet = ignoredResult;
        const ahead = aheadBehindResult.ahead;
        const behind = aheadBehindResult.behind;

        let dirty = false;
        let staged = false;
        let unstaged = false;
        let untracked = false;
        let merging = false;
        const files = [];
        const stagedFiles = [];
        const unstagedFiles = [];
        const conflicts = [];

        for (const line of lines) {
            if (line.length < 2) {
                continue;
            }
            const x = line[0];
            const y = line[1];
            const filePath = line.slice(3).trim();
            if (ignoredSet.has(filePath)) continue;
            const xy = x + y;
            const isConflict = CONFLICT_STATUSES.has(xy);
            const entry = { path: filePath, status: xy };
            if (isConflict) {
                merging = true;
                dirty = true;
                entry.type = 'conflict';
                entry.conflict = true;
                conflicts.push(entry);
            } else if (x === '?' && y === '?') {
                untracked = true;
                dirty = true;
                entry.type = 'untracked';
            } else {
                if (x !== ' ') {
                    staged = true;
                    dirty = true;
                }
                if (y !== ' ') {
                    unstaged = true;
                    dirty = true;
                }
                if (x !== ' ' && y !== ' ') {
                    entry.type = 'both';
                } else if (x !== ' ') {
                    entry.type = 'staged';
                } else {
                    entry.type = 'modified';
                }
            }
            files.push(entry);
            if (isConflict) {
                stagedFiles.push(entry);
                unstagedFiles.push(entry);
            } else {
                if (x !== ' ' && x !== '?') stagedFiles.push(entry);
                if (y !== ' ') unstagedFiles.push(entry);
            }
        }

        return { branch, sha, dirty, staged, unstaged, untracked, merging, ahead, behind, files, stagedFiles, unstagedFiles, conflicts };
    }

    async commitAll(project, message) {
        return this._mutate(project, async () => {
            await this._execGit(project, ['add', '-A']);

            // Skip the commit when there is nothing staged — avoids a noisy
            // "nothing to commit" GitError that callers would have to swallow.
            const statusOut = await this._execGit(project, ['status', '--porcelain']);
            if (!statusOut.stdout || !statusOut.stdout.trim()) {
                const sha = await this._revParse(project, 'HEAD');
                return { sha, committed: false };
            }

            await this._execGit(project, ['commit', '-m', message]);
            this._invalidateAheadBehind(project.id);
            const sha = await this._revParse(project, 'HEAD');
            return { sha, committed: true };
        });
    }

    async commitStaged(project, message, author = {}) {
        return this._mutate(project, async () => {
            const args = ['commit', '-m', message];
            if (author.name) {
                args.unshift('-c', `user.name=${author.name}`);
            }
            if (author.email) {
                args.unshift('-c', `user.email=${author.email}`);
            }
            await this._execGit(project, args);
            this._invalidateAheadBehind(project.id);
            const sha = await this._revParse(project, 'HEAD');
            return { sha };
        });
    }

    async stageFiles(project, filePaths) {
        return this._mutate(project, async () => {
            await this._execGit(project, ['add', '--', ...filePaths.map(assertRepoRelativePath)]);
        });
    }

    async unstageFiles(project, filePaths) {
        return this._mutate(project, async () => {
            await this._execGit(project, ['reset', 'HEAD', '--', ...filePaths.map(assertRepoRelativePath)]);
        });
    }

    async discardChanges(project, filePaths) {
        return this._mutate(project, async () => {
            const safePaths = filePaths.map(assertRepoRelativePath);
            const statusOut = await this._execGit(project, ['status', '--porcelain=v1', '--', ...safePaths]);
            const lines = statusOut.stdout.split('\n').filter(Boolean);

            const trackedPaths = [];
            const untrackedPaths = [];
            for (const line of lines) {
                const status = line.slice(0, 2);
                const path = line.slice(3).trim();
                if (status[0] === '?' && status[1] === '?') {
                    untrackedPaths.push(path);
                } else {
                    trackedPaths.push(path);
                }
            }

            if (trackedPaths.length > 0) {
                await this._execGit(project, ['checkout', '--', ...trackedPaths]);
            }
            if (untrackedPaths.length > 0) {
                await this._execGit(project, ['clean', '-fd', '--', ...untrackedPaths]);
            }
        });
    }

    async pushBranch(project, branchName, { force = false } = {}) {
        return this._mutate(project, async () => {
            const safeBranch = assertGitBranch(branchName);
            // Worktrees are created with --detach, so HEAD may not be on the
            // named branch. Push HEAD explicitly to avoid pushing a stale local
            // branch tip that doesn't include the worktree's latest commits.
            const args = ['push', '-u', 'origin', `HEAD:${safeBranch}`];
            if (force) {
                args.push('--force');
            }
            await this._execGit(project, args);
            this._invalidateAheadBehind(project.id);
            const sha = await this._revParse(project, 'HEAD');
            return { sha };
        });
    }

    async getDiff(project, { base, head } = {}) {
        const args = ['diff'];
        if (base && head) {
            args.push(assertGitRef(base), assertGitRef(head));
        } else if (base) {
            args.push(assertGitRef(base));
        }
        const { stdout } = await this._execGit(project, args);
        return limitDiffText(stdout);
    }

    async getFileDiff(project, filePath) {
        const safePath = assertRepoRelativePath(filePath);
        const { stdout } = await this._execGit(project, ['diff', 'HEAD', '--', safePath]).catch(() => ({ stdout: '' }));
        if (stdout.trim()) {
            return limitDiffText(stdout);
        }

        const tracked = await this._execGit(project, ['ls-files', '--error-unmatch', '--', safePath]).then(() => true).catch(() => false);
        if (tracked) {
            return { diff: '', truncated: false, binary: false, omittedBytes: 0 };
        }

        const ready = await this.ensureProjectRuntime(project);
        const runtimeRef = ready.runtime ? ready.runtime.runtimeRef : undefined;

        const isDir = await this.fs.fsStat(ready.workspacePath, safePath, { runtimeRef })
            .then((s) => s && s.type === 'directory')
            .catch(() => false);
        if (isDir) {
            return {
                diff: '(Contains a nested git repository)',
                truncated: false,
                binary: false,
                omittedBytes: 0,
            };
        }

        const content = await this.fs.fsRead(ready.workspacePath, safePath, {
            runtimeRef,
            encoding: 'utf8',
        }).catch(() => '');
        const side = limitFileSide(content);
        if (side.binary) {
            return {
                diff: '[binary file omitted]',
                truncated: true,
                binary: true,
                omittedBytes: side.omittedBytes,
            };
        }
        const expanded = side.content.split('\n').map((l) => '+' + l).join('\n');
        return {
            diff: side.truncated
                ? `${expanded}\n\n[diff truncated: omitted ${side.omittedBytes} bytes]\n`
                : expanded,
            truncated: side.truncated,
            binary: false,
            omittedBytes: side.omittedBytes,
        };
    }

    async getFileContentAtRef(project, filePath, ref = 'HEAD') {
        const safePath = assertRepoRelativePath(filePath);
        const { stdout } = await this._execGit(project, ['show', `${assertGitRef(ref)}:${safePath}`]);
        return stdout;
    }

    /**
     * 单次调用返回 HEAD 版本和工作区当前内容，供 DiffEditor 直接渲染。
     * 服务端 Promise.all 并行执行 git show 与 fsRead，省去 /workspace/file 的 fsStat
     * 串行 VM exec（~500ms-1s），并减少一次 HTTP 往返。
     * 新增文件（HEAD 无记录）或已删除文件（工作区无文件）时对应一侧返回空串。
     */
    async getFileDiffView(project, filePath, ref = 'HEAD') {
        const safePath = assertRepoRelativePath(filePath);
        const safeRef = assertGitRef(ref);
        const ready = await this.ensureProjectRuntime(project);
        const workspacePath = ready.workspacePath;
        const runtimeRef = ready.runtime ? ready.runtime.runtimeRef : undefined;
        const fsAdapter = this.fs;

        const [headResult, currentResult] = await Promise.allSettled([
            this._execGit(project, ['show', `${safeRef}:${safePath}`]),
            fsAdapter.fsRead(workspacePath, safePath, { runtimeRef, encoding: 'utf8' }),
        ]);

        const originalRaw = headResult.status === 'fulfilled' ? headResult.value.stdout : '';
        const modifiedRaw = currentResult.status === 'fulfilled' ? currentResult.value : '';
        const originalSide = limitFileSide(originalRaw);
        const modifiedSide = limitFileSide(modifiedRaw);

        return {
            original: originalSide.binary ? '' : originalSide.content,
            modified: modifiedSide.binary ? '' : modifiedSide.content,
            truncated: originalSide.truncated || modifiedSide.truncated,
            binary: originalSide.binary || modifiedSide.binary,
        };
    }

    async mergeBranch(project, fromBranch, toBranch) {
        return this._mutate(project, async () => {
            // switchBranch also locks; nested same-key lock would deadlock, so call inner git ops directly.
            const safeTo = assertGitBranch(toBranch);
            const safeFrom = assertGitBranch(fromBranch);
            try {
                await this._execGit(project, ['checkout', safeTo]);
            } catch (err) {
                const remoteRef = `origin/${safeTo}`;
                try {
                    await this._execGit(project, ['rev-parse', '--verify', '--quiet', remoteRef]);
                    await this._execGit(project, ['checkout', '-b', safeTo, remoteRef]);
                } catch {
                    throw err;
                }
            }
            await this._execGit(project, ['merge', safeFrom, '-m', `Merge ${safeFrom} into ${safeTo}`]);
            this._invalidateAheadBehind(project.id);
            const sha = await this._revParse(project, 'HEAD');
            return { sha };
        });
    }

    async getLog(project, { branch, limit = 20 } = {}) {
        const args = ['log'];
        if (branch) {
            args.push(branch);
        }
        args.push('--format=%H%x1F%s%x1F%an <%ae>%x1F%aI%x1E', '-n', String(limit));

        const { stdout } = await this._execGit(project, args);

        return stdout
            .split('\x1E')
            .filter(Boolean)
            .map((record) => {
                const [sha, message, author, date] = record.split('\x1F');
                return { sha, message, author, date };
            });
    }
}

module.exports = { GitOperationService, GitError };
