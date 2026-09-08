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
const { DEPENDENCY_EXCLUDE_SCRIPT } = require('../git/dependencyExclude');

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

// untracked 目录展开策略：文件数 ≤ 此值才展开为逐文件条目；超过则保持折叠
// （`?? dir/` 一行）并统计文件数随条目下发，避免 node_modules 这类上万文件
// 的目录把 status 响应和前端渲染拖垮。
const DIR_EXPAND_FILE_LIMIT = 50;
// 展开后条目总量软上限：达到后剩余 untracked 目录一律保持折叠并标记 truncated。
const MAX_EXPANDED_ENTRIES = 500;

async function defaultGetToken(project) {
    const provider = project.repoProvider;
    if (!provider || provider === 'none' || provider === 'local_git' || provider === 'url') {
        return undefined;
    }
    const { GitConnectionService } = require('../git/GitConnectionService');
    try {
        return await new GitConnectionService().getDecryptedToken(project.userId, provider);
    } catch (err) {
        // No connected account for this provider (e.g. URL import without
        // connecting). Fall back to unauthenticated access so public repos
        // can still be cloned; private repos will fail at clone time.
        if (err?.message?.includes('not_connected')) return undefined;
        throw err;
    }
}

class GitOperationService {
    constructor(deps = {}) {
        this.exec = deps.exec ?? getRuntime().exec;
        this.fs = deps.fs ?? getRuntime().fs;
        this._runtimeId = deps.runtimeId || null;
        // 多仓库：指定 repo 后 git 操作路由到 projectDir/<subPath>（或其 worktree）
        this._repoSubPath = deps.repoSubPath || null;
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
        const maxRetries = 3;
        for (let attempt = 0; ; attempt++) {
            try {
                return await this._execGitOnce(project, args, options);
            } catch (err) {
                const msg = err.message || '';
                // Retry on transient index lock conflicts:
                //  - "index.lock...File exists" — concurrent git processes
                //  - "unable to write new_index file" — lock was stale/removed
                //    mid-write (e.g. after VM agent crash leaves stale lock)
                const isTransient = (msg.includes('index.lock') && msg.includes('File exists'))
                    || msg.includes('unable to write new_index file');
                if (!isTransient || attempt >= maxRetries) throw err;
                await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
            }
        }
    }

    async _execGitOnce(project, args, options = {}) {
        const needsToken = options.needsToken ?? REMOTE_GIT_COMMANDS.has(args[0]);
        const token = needsToken ? await this._resolveToken(project) : undefined;
        let hostPath = workspace.projectDir(project.userId, project.id);
        let gitDir = null;
        let workTree = null;

        // 多仓库：默认路由到 projectDir/<subPath>
        if (this._repoSubPath) {
            hostPath = path.join(hostPath, this._repoSubPath);
        }

        // If a runtimeId is set (session-scoped), prefer the worktree path.
        // Compute explicit --git-dir / --work-tree so host git bypasses the
        // worktree's .git pointer (which may be rewritten to a VM path).
        if (this._runtimeId) {
            const mainDir = workspace.projectDir(project.userId, project.id);
            const wtPath = this._repoSubPath
                ? workspace.repoWorktreePath(project.userId, project.id, this._runtimeId, this._repoSubPath)
                : workspace.worktreeDir(project.userId, project.id, this._runtimeId);
            if (fs.existsSync(path.join(wtPath, '.git'))) {
                hostPath = wtPath;
                // 多 repo worktree 的主 .git 位于 projectDir/<subPath>/.git，
                // admin 目录名为 worktree 路径 basename（= subPath）
                const mainGitDir = this._repoSubPath
                    ? path.join(mainDir, this._repoSubPath, '.git')
                    : path.join(mainDir, '.git');
                const wtAdminName = this._repoSubPath || this._runtimeId;
                gitDir = path.join(mainGitDir, 'worktrees', wtAdminName);
                workTree = wtPath;
            }
        }

        if (this.usesHostWorkspace()) {
            fs.mkdirSync(hostPath, { recursive: true });
            const credentials = token ? buildCredentialEnv(token, hostPath, hostPath) : null;
            try {
                const result = await this.hostGit(hostPath, args, {
                    timeoutMs: options.timeoutMs || 120_000,
                    env: credentials ? credentials.env : {},
                    gitDir,
                    workTree,
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
            const env = { ...(credentials ? credentials.env : {}) };
            // 沙箱内 git：worktree 的 .git 指针指向宿主绝对路径（沙箱内不可达），
            // 但 /workspace.git 已挂载进沙箱（= 宿主 .git）、/workspace = worktree。
            // 用 GIT_DIR/GIT_WORK_TREE 显式指到沙箱路径，让沙箱内 git 不依赖 .git 指针；
            // 宿主侧指针保持宿主路径，宿主 git（--git-dir/--work-tree）不受影响。
            // 多仓库：gitVolume 挂 primary repo 的 .git，worktree admin 目录为 <subPath>；
            // 非 primary repo 的 .git 未挂入沙箱，沙箱内 git 仅对 primary 可用（宿主侧不受限）。
            if (this._runtimeId) {
                env.GIT_DIR = this._repoSubPath
                    ? `/workspace.git/worktrees/${this._repoSubPath}`
                    : `/workspace.git/worktrees/${this._runtimeId}`;
                env.GIT_WORK_TREE = this._repoSubPath
                    ? `${ready.workspacePath}/${this._repoSubPath}`
                    : '/workspace';
            }
            const result = await exec(
                'git',
                args,
                env,
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
            // -f：clone 前 ensureAgentBootstrap 可能预置了 untracked 的 .gitignore / AGENTS.md
            // （含 .agents/、.xensemble/ 平台元数据条目），checkout 会因"untracked 文件将被覆盖"失败。
            // 克隆阶段工作树无本地修改，强制覆盖预置文件即可让远程版本落地。
            await this._execGit(project, ['checkout', '-f', '-b', localBranch, remoteRef]);
        } else {
            await this._execGit(project, ['checkout', '-f', '-b', localBranch, `origin/${localBranch}`]);
        }

        // Set local git config so agent-side `git commit` inside the VM works
        // without requiring global config. ensureGitInit skips repos that
        // already have .git, so cloned repos never get the config otherwise.
        await this._execGit(project, ['config', 'user.email', 'xensemble@local']);
        await this._execGit(project, ['config', 'user.name', 'XEnsemble']);

        // 依赖/构建产物写入 .git/info/exclude（幂等，非致命）：node_modules 等
        // 装进项目目录后不再污染 git 变更面板。best-effort，失败不影响 clone。
        await this.ensureDependencyExclude(project);

        const sha = await this._revParse(project, 'HEAD');
        return { sha, branch: localBranch };
    }

    /**
     * 幂等确保 workspace 的 `.git/info/exclude` 覆盖依赖/构建产物目录
     * （node_modules、dist、__pycache__ 等，见 dependencyExclude.js）。
     * 写在 .git/ 内部：不碰用户工作区文件、不产生 git 变更、不会被提交。
     * 任何失败都只告警，不影响调用方主流程。
     */
    async ensureDependencyExclude(project) {
        try {
            const ready = await this.ensureProjectRuntime(project);
            const runtimeRef = ready.runtime ? ready.runtime.runtimeRef : undefined;
            const exec = this._execFn();
            const result = await exec('sh', ['-c', DEPENDENCY_EXCLUDE_SCRIPT], {}, {
                cwd: ready.workspacePath, runtimeRef, timeoutMs: 15_000,
            });
            return String(result?.stdout || '').includes('EXCLUDE_OK');
        } catch (err) {
            console.warn('[GitOperationService] ensureDependencyExclude failed (non-fatal):', err.message);
            return false;
        }
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

    /**
     * 展开 status 输出中的 untracked 目录条目（`?? dir/`）。
     *
     * 策略（配合 status -unormal 使用）：
     * - 文件数 ≤ DIR_EXPAND_FILE_LIMIT 的小目录 → 展开为逐文件 `?? path`；
     * - 大目录（如 node_modules）→ 保持折叠一行，统计文件数放入 dirCounts，
     *   由调用方作为 entry.count 下发，前端显示"目录（N 个文件）"；
     * - 展开条目达到 MAX_EXPANDED_ENTRIES 后停止继续展开，置 truncated=true；
     * - find 失败/为空（嵌套 git 仓库等）→ 保留原条目并去掉尾斜杠（旧行为）。
     *
     * 返回 { lines, dirCounts, truncated }。
     */
    async _expandDirEntries(project, lines) {
        const expanded = [];
        const dirCounts = new Map();
        let truncated = false;
        for (const line of lines) {
            if (line.length < 3) { expanded.push(line); continue; }
            const filePath = line.slice(3).trim();
            if (!filePath.endsWith('/') || line[0] !== '?' || line[1] !== '?') {
                expanded.push(line);
                continue;
            }
            if (truncated || expanded.length >= MAX_EXPANDED_ENTRIES) {
                truncated = true;
                expanded.push(line);
                continue;
            }
            const dir = filePath.replace(/\/$/, '');
            try {
                const ready = await this.ensureProjectRuntime(project);
                const runtimeRef = ready.runtime ? ready.runtime.runtimeRef : undefined;
                const exec = this._execFn();
                // head -n (LIMIT+1)：输出有界，51 行即代表 >50 个文件
                const result = await exec('sh', ['-c',
                    'find "$1" -type f -not -path "*/.git/*" 2>/dev/null | head -n 51',
                    'sh', dir], {}, { cwd: ready.workspacePath, runtimeRef, timeoutMs: 10_000 });
                const fileList = String(result.stdout || '').split('\n').filter(Boolean);
                if (result.exitCode === 0 && fileList.length > 0 && fileList.length <= DIR_EXPAND_FILE_LIMIT) {
                    for (const f of fileList) {
                        expanded.push(`?? ${f}`);
                    }
                } else if (fileList.length > DIR_EXPAND_FILE_LIMIT) {
                    let count = null;
                    try {
                        const c = await exec('sh', ['-c',
                            'find "$1" -type f -not -path "*/.git/*" 2>/dev/null | wc -l',
                            'sh', dir], {}, { cwd: ready.workspacePath, runtimeRef, timeoutMs: 10_000 });
                        const n = parseInt(String(c.stdout || '').trim(), 10);
                        if (Number.isFinite(n)) count = n;
                    } catch { /* count unavailable */ }
                    dirCounts.set(filePath, count);
                    expanded.push(line);
                } else {
                    expanded.push(line.replace(/\/$/, ''));
                }
            } catch {
                expanded.push(line.replace(/\/$/, ''));
            }
        }
        return { lines: expanded, dirCounts, truncated };
    }

    async getStatusLight(project) {
        return withProjectGitLock(project?.id, async () => this._getStatusLight(project));
    }

    async _getStatusLight(project) {
        // -unormal：untracked 目录折叠为 `?? dir/` 一行，由 _expandDirEntries
        // 按小目录展开 / 大目录折叠带计数处理。原 -uall 会把 node_modules 等
        // 目录里上万个文件逐行列出，是变更面板卡死的根源。
        const statusOut = await this._execGit(project, ['--no-optional-locks', 'status', '--porcelain=v1', '-unormal']).catch(() => ({ stdout: '' }));
        let lines = statusOut.stdout.split('\n').filter(Boolean);
        const expanded = await this._expandDirEntries(project, lines);
        lines = expanded.lines;
        const dirCounts = expanded.dirCounts;
        const truncated = expanded.truncated;
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
                if (filePath.endsWith('/')) {
                    // 保持折叠的大目录：带文件数下发，前端渲染为目录行
                    entry.type = 'untracked-dir';
                    entry.count = dirCounts.get(filePath) ?? null;
                } else {
                    entry.type = 'untracked';
                }
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

        const branchOut = await this._execGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: 'HEAD' }));
        let branch = branchOut.stdout.trim();
        if (branch === 'HEAD') branch = null;

        const divergence = await this._resolveAheadBehind(project, branch);

        return { files, stagedFiles, unstagedFiles, dirty, branch, truncated, ...divergence };
    }

    /**
     * Resolve ahead/behind for the worktree's current branch, using the same
     * basis as getStatus so light polling and full refresh never disagree
     * (a stale divergence between the two previously made the UI flip
     * between "17 unpushed" and "0 unpushed" on every 15s light poll).
     *
     * - branch known → compare HEAD against origin/<branch> (or @{upstream}).
     * - branch unknown (detached HEAD, e.g. mid-rebase) → return nulls so the
     *   client keeps the last known value instead of briefly showing 0. Do NOT
     *   fall back to project.currentBranch: with per-session worktrees that is
     *   the main checkout, not this worktree, so it would compare against the
     *   wrong branch.
     */
    async _resolveAheadBehind(project, branch) {
        if (!branch) {
            return { ahead: null, behind: null };
        }
        const candidates = [
            this._execGit(project, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
            this._execGit(project, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]),
        ];
        try {
            const r = await Promise.any(candidates);
            const [a, b] = r.stdout.trim().split('\t').map((n) => Number(n) || 0);
            return { ahead: a, behind: b };
        } catch {
            return { ahead: null, behind: null };
        }
    }

    async getStatus(project) {
        return withProjectGitLock(project?.id, async () => this._getStatus(project));
    }

    async _getStatus(project) {
        const [branchOut, shaOut, statusOut] = await Promise.all([
            this._execGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']).catch((err) => {
                console.warn('[GitOperationService] getStatus rev-parse branch failed:', err.message);
                return { stdout: 'HEAD' };
            }),
            this._execGit(project, ['rev-parse', 'HEAD']).catch((err) => {
                console.warn('[GitOperationService] getStatus rev-parse HEAD failed:', err.message);
                return { stdout: '' };
            }),
            this._execGit(project, ['--no-optional-locks', 'status', '--porcelain=v1', '-unormal']).catch((err) => {
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
        const expanded = await this._expandDirEntries(project, lines);
        lines = expanded.lines;
        const dirCounts = expanded.dirCounts;
        const truncated = expanded.truncated;

        // check-ignore 只对 untracked 文件有意义（已跟踪文件不受 .gitignore 影响）
        const untrackedPaths = lines
            .filter((line) => line.length >= 3 && line[0] === '?' && line[1] === '?')
            .map((line) => line.slice(3).trim());

        const [ignoredResult, aheadBehindResult] = await Promise.all([
            untrackedPaths.length > 0
                ? this._execGit(project, ['check-ignore', ...untrackedPaths])
                    .then((r) => new Set(r.stdout.split('\n').filter(Boolean)))
                    .catch(() => new Set())
                : Promise.resolve(new Set()),
            this._resolveAheadBehind(project, branch),
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
                if (filePath.endsWith('/')) {
                    // 保持折叠的大目录：带文件数下发，前端渲染为目录行
                    entry.type = 'untracked-dir';
                    entry.count = dirCounts.get(filePath) ?? null;
                } else {
                    entry.type = 'untracked';
                }
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

        return { branch, sha, dirty, staged, unstaged, untracked, merging, ahead, behind, truncated, files, stagedFiles, unstagedFiles, conflicts };
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

            const checkoutPaths = [];
            const cleanPaths = [];
            const rmCachedPaths = [];
            for (const line of lines) {
                const x = line[0];
                const y = line[1];
                const filePath = line.slice(3).trim();
                if (x === '?' && y === '?') {
                    cleanPaths.push(filePath);
                } else if (x === 'A' && y === ' ') {
                    // Staged new file (added to index, not yet committed).
                    // git checkout -- won't work; remove from index + delete from worktree.
                    rmCachedPaths.push(filePath);
                    cleanPaths.push(filePath);
                } else {
                    checkoutPaths.push(filePath);
                    // If the file has staged changes (x != ' ' and x !== '?'),
                    // also restore the index version to HEAD.
                    if (x !== ' ' && x !== '?' && x !== 'A') {
                        rmCachedPaths.push(filePath);
                    }
                }
            }

            if (checkoutPaths.length > 0) {
                await this._execGit(project, ['checkout', '--', ...checkoutPaths]);
            }
            if (rmCachedPaths.length > 0) {
                await this._execGit(project, ['rm', '--cached', '--force', '--', ...rmCachedPaths]);
            }
            if (cleanPaths.length > 0) {
                await this._execGit(project, ['clean', '-fd', '--', ...cleanPaths]);
            }
        });
    }

    async pushBranch(project, branchName, { force = false } = {}) {
        return this._mutate(project, async () => {
            const safeBranch = assertGitBranch(branchName);
            const args = ['push', '-u', 'origin', safeBranch];
            if (force) {
                args.push('--force');
            }
            await this._execGit(project, args);
            this._invalidateAheadBehind(project.id);
            const sha = await this._revParse(project, 'HEAD');
            return { sha };
        });
    }

    /**
     * Fetch the target branch and rebase the current branch onto origin/<target>.
     * Used before creating a PR to ensure the source branch is up-to-date and
     * conflict-free. Throws with code 'rebase_conflict' if conflicts arise.
     */
    async fetchAndRebase(project, targetBranch) {
        return this._mutate(project, async () => {
            const safeTarget = assertGitBranch(targetBranch);

            // Fetch latest refs from remote.
            await this._execGit(project, ['fetch', 'origin', safeTarget], { timeoutMs: 60_000 });

            // Check if origin/<target> exists.
            const remoteRef = `origin/${safeTarget}`;
            try {
                await this._execGit(project, ['rev-parse', '--verify', '--quiet', remoteRef]);
            } catch {
                // Target branch doesn't exist on remote — nothing to rebase onto.
                return { rebased: false, reason: 'target_not_found' };
            }

            // Attempt rebase.
            try {
                await this._execGit(project, ['rebase', remoteRef]);
                this._invalidateAheadBehind(project.id);
                return { rebased: true };
            } catch (err) {
                const msg = err.message || '';
                if (msg.includes('conflict') || msg.includes('CONFLICT')) {
                    // Abort the rebase to leave the working tree clean.
                    await this._execGit(project, ['rebase', '--abort']).catch(() => {});
                    const conflictErr = new Error(
                        `Rebase onto origin/${safeTarget} failed due to conflicts. ` +
                        `Please resolve conflicts locally and push again.`
                    );
                    conflictErr.code = 'rebase_conflict';
                    conflictErr.targetBranch = safeTarget;
                    throw conflictErr;
                }
                throw err;
            }
        });
    }

    async getDiff(project, { base, head, threeDot = false } = {}) {
        const args = ['diff'];
        if (base && head) {
            if (threeDot) {
                // Three-dot diff (base...head): shows changes on head since
                // it diverged from base (merge-base), excluding base-side changes.
                args.push(`${assertGitRef(base)}...${assertGitRef(head)}`);
            } else {
                args.push(assertGitRef(base), assertGitRef(head));
            }
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
