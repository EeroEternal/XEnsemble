/**
 * LocalGitService — Layer 1 built-in Git management.
 *
 * Provides per-project Git version tracking without any external provider.
 * All git commands run through the Runtime exec adapter (Local/BoxLite/K8s).
 *
 * Local-only scope:
 *   - Bare repos are stored on the server's local filesystem (BARE_REPO_ROOT).
 *     This is intentional: bare repos are server-side metadata, not workspace data.
 *   - Workspace filesystem operations (e.g. .gitignore creation) are routed
 *     through the FsAdapter so they work correctly on BoxLite/K8s runtimes
 *     where the workspace lives inside a sandbox.
 *
 * See docs/LocalGit.md for the full specification.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { eq, and } = require('drizzle-orm');
const { getRuntime } = require('../runtime/registry');
const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const workspace = require('../workspace');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { recordEvent } = require('../events/recordEvent');
const { singleflight } = require('../runtime/singleflight');
const { hostGit, usesHostWorkspace } = require('./hostGit');

const BARE_REPO_ROOT = process.env.BARE_REPO_ROOT
    || path.join(__dirname, '../../data/repos');

const GITIGNORE_TEMPLATE = `# XEnsemble runtime / secrets — never version
.env
.env.*
!.env.example

# Dependencies & build
node_modules/
dist/
build/
.next/
.turbo/
__pycache__/
*.pyc
.venv/
venv/

# IDE / OS
.DS_Store
.idea/
.vscode/

# Logs & local caches
*.log
.npm/
.cache/

# XEnsemble internal (git credential helpers, etc.)
.xensemble/

# XEnsemble platform metadata
.agents/
`;

function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function bareRepoPath(projectId) {
    return path.join(BARE_REPO_ROOT, `${projectId}.git`);
}

function formatCheckpointMessage(meta = {}) {
    const trigger = meta.trigger || 'manual';
    const summary = meta.summary || '';
    const lines = [`checkpoint(${trigger}): ${summary || 'checkpoint'}`];
    lines.push('');
    if (meta.sessionId) lines.push(`session_id: ${meta.sessionId}`);
    lines.push(`trigger: ${trigger}`);
    if (meta.agentId) lines.push(`agent_id: ${meta.agentId}`);
    if (meta.steps != null) lines.push(`steps: ${meta.steps}`);
    if (summary) lines.push(`summary: ${summary.slice(0, 500)}`);
    return lines.join('\n');
}

class LocalGitService {
    constructor(deps = {}) {
        this.exec = deps.exec ?? getRuntime().exec;
        this._runtimeId = deps.runtimeId || null;
        const origEnsure = deps.ensureProjectRuntime ?? ensureProjectRuntime;
        this.ensureProjectRuntime = async (project) => {
            const result = await origEnsure(project, this._runtimeId ? { runtimeId: this._runtimeId } : {});
            if (result.runtime?.runtimeRef) {
                this._lastRuntimeRef = result.runtime.runtimeRef;
            }
            return result;
        };
        this._lastRuntimeRef = null;
    }

    _execFn() {
        if (typeof this.exec === 'function') return this.exec;
        if (typeof this.exec?.exec === 'function') return this.exec.exec.bind(this.exec);
        throw new Error('No usable exec adapter provided to LocalGitService');
    }

    async _git(cwd, args, options = {}) {
        const exec = this._execFn();
        const result = await exec('git', args, {}, {
            cwd,
            timeoutMs: options.timeoutMs || 30_000,
            ...(options.runtimeRef || this._lastRuntimeRef ? { runtimeRef: options.runtimeRef || this._lastRuntimeRef } : {}),
            ...options,
        });
        if (result.exitCode !== 0) {
            const err = new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
            err.exitCode = result.exitCode;
            throw err;
        }
        return result;
    }

    // ── Init ──

    /**
     * Initialize a bare repo + workspace git repo for a new project.
     * Called during project creation when repoProvider = 'local_git'.
     *
     * Bare repos always live on the host. For local/boxlite the workspace is also
     * on the host (BoxLite virtiofs-mounts it), so bootstrap uses host `git` and
     * must NOT call ensureProjectRuntime — that would pin a premature box-base VM.
     * K8s keeps the runtime-exec path because the workspace is not host-local.
     */
    async initRepo(project) {
        return singleflight(`local-git-init:${project.id}`, async () => {
            if (usesHostWorkspace()) {
                return this._initRepoOnHost(project);
            }
            return this._initRepoViaRuntime(project);
        });
    }

    async _initRepoOnHost(project) {
        const bare = bareRepoPath(project.id);
        const hostWorkspacePath = workspace.createProjectDirectory(project.userId, project.id);

        fs.mkdirSync(bare, { recursive: true });
        if (!fs.existsSync(path.join(bare, 'HEAD'))) {
            await hostGit(bare, ['init', '--bare', '-b', 'main']);
        }

        const gitDir = path.join(hostWorkspacePath, '.git');
        if (!fs.existsSync(gitDir)) {
            await hostGit(hostWorkspacePath, ['init', '-b', 'main']);
        }
        await hostGit(hostWorkspacePath, ['config', 'user.email', 'xensemble@local']);
        await hostGit(hostWorkspacePath, ['config', 'user.name', 'XEnsemble']);

        try {
            await hostGit(hostWorkspacePath, ['remote', 'add', 'origin', bare]);
        } catch (err) {
            if (!/remote origin already exists/i.test(String(err.message))) throw err;
            await hostGit(hostWorkspacePath, ['remote', 'set-url', 'origin', bare]);
        }

        const ignorePath = path.join(hostWorkspacePath, '.gitignore');
        if (!fs.existsSync(ignorePath)) {
            fs.writeFileSync(ignorePath, GITIGNORE_TEMPLATE, 'utf8');
        }

        // Stage only .gitignore so a late backfill does not swallow agent-created
        // files into the initial commit (they should remain visible in Changes).
        await hostGit(hostWorkspacePath, ['add', '--', '.gitignore']);
        const headBefore = await hostGit(hostWorkspacePath, ['rev-parse', '--verify', 'HEAD']).catch(() => null);
        if (!headBefore) {
            await hostGit(hostWorkspacePath, [
                'commit', '--allow-empty', '-m', 'chore: initialize workspace',
            ]);
        }

        try {
            await hostGit(hostWorkspacePath, ['push', '-u', 'origin', 'main']);
        } catch {
            // Best-effort: bare mirror is optional for Changes / status.
        }

        await db.update(schema.projects).set({
            repoProvider: 'local_git',
            workspaceMode: 'git',
            repoUrl: bare,
            repoDefaultBranch: 'main',
            cloneStatus: 'ready',
            cloneError: null,
            serverPath: project.serverPath || hostWorkspacePath,
        }).where(eq(schema.projects.id, project.id));

        const headResult = await hostGit(hostWorkspacePath, ['rev-parse', 'HEAD']);
        const sha = headResult.stdout.trim();

        await recordEvent({
            userId: project.userId,
            projectId: project.id,
            subjectType: 'project',
            subjectId: project.id,
            type: 'local_git.initialized',
            data: { bareRepoPath: bare, initialSha: sha, hostWorkspacePath },
        });

        return { bareRepoPath: bare, workspacePath: hostWorkspacePath, initialSha: sha };
    }

    async _initRepoViaRuntime(project) {
        const bare = bareRepoPath(project.id);

        fs.mkdirSync(bare, { recursive: true });
        await hostGit(bare, ['init', '--bare', '-b', 'main']);

        const { workspacePath } = await this.ensureProjectRuntime(project);
        await this._git(workspacePath, ['init', '-b', 'main']);
        await this._git(workspacePath, ['config', 'user.email', 'xensemble@local']);
        await this._git(workspacePath, ['config', 'user.name', 'XEnsemble']);
        try {
            await this._git(workspacePath, ['remote', 'add', 'origin', bare]);
        } catch (err) {
            if (!/remote origin already exists/i.test(String(err.message))) throw err;
            await this._git(workspacePath, ['remote', 'set-url', 'origin', bare]);
        }

        const runtimeFs = getRuntime().fs;
        const ignoreExists = await runtimeFs.exists(workspacePath, '.gitignore');
        if (!ignoreExists) {
            await runtimeFs.fsWrite(workspacePath, '.gitignore', GITIGNORE_TEMPLATE);
        }

        await this._git(workspacePath, ['add', '--', '.gitignore']);
        const headBefore = await this._git(workspacePath, ['rev-parse', '--verify', 'HEAD']).catch(() => null);
        if (!headBefore) {
            await this._git(workspacePath, [
                'commit', '--allow-empty', '-m', 'chore: initialize workspace',
            ]);
        }

        try {
            await this._git(workspacePath, ['push', '-u', 'origin', 'main']);
        } catch {
            // Best-effort
        }

        await db.update(schema.projects).set({
            repoProvider: 'local_git',
            workspaceMode: 'git',
            repoUrl: bare,
            repoDefaultBranch: 'main',
            cloneStatus: 'ready',
            cloneError: null,
        }).where(eq(schema.projects.id, project.id));

        const headResult = await this._git(workspacePath, ['rev-parse', 'HEAD']);
        const sha = headResult.stdout.trim();

        await recordEvent({
            userId: project.userId,
            projectId: project.id,
            subjectType: 'project',
            subjectId: project.id,
            type: 'local_git.initialized',
            data: { bareRepoPath: bare, initialSha: sha },
        });

        return { bareRepoPath: bare, workspacePath, initialSha: sha };
    }

    /**
     * Lazy init: if a project's workspace has no .git, initialize it.
     * Returns true if init was performed, false if already initialized.
     */
    async ensureGitInit(project) {
        // External providers (github/gitlab/gitea) manage their own remote and
        // credentials.  Overwriting repoProvider to 'local_git' here breaks
        // pushBranch which uses repoProvider to resolve the OAuth token.
        const isExternal = project.repoProvider
            && project.repoProvider !== 'none'
            && project.repoProvider !== 'local_git';
        if (isExternal) {
            return false;
        }

        if (usesHostWorkspace()) {
            const hostWorkspacePath = workspace.createProjectDirectory(project.userId, project.id);
            if (fs.existsSync(path.join(hostWorkspacePath, '.git'))) {
                if (project.repoProvider !== 'local_git' || project.workspaceMode !== 'git') {
                    await db.update(schema.projects).set({
                        repoProvider: 'local_git',
                        workspaceMode: 'git',
                        repoUrl: project.repoUrl || bareRepoPath(project.id),
                        repoDefaultBranch: project.repoDefaultBranch || 'main',
                        cloneStatus: 'ready',
                        cloneError: null,
                    }).where(eq(schema.projects.id, project.id));
                }
                return false;
            }
            await this.initRepo(project);
            return true;
        }

        const { workspacePath } = await this.ensureProjectRuntime(project);
        try {
            await this._git(workspacePath, ['rev-parse', '--git-dir']);
            if (project.repoProvider !== 'local_git' || project.workspaceMode !== 'git') {
                await db.update(schema.projects).set({
                    repoProvider: 'local_git',
                    workspaceMode: 'git',
                    repoUrl: project.repoUrl || bareRepoPath(project.id),
                    repoDefaultBranch: project.repoDefaultBranch || 'main',
                    cloneStatus: 'ready',
                    cloneError: null,
                }).where(eq(schema.projects.id, project.id));
            }
            return false;
        } catch {
            await this.initRepo(project);
            return true;
        }
    }

    // ── Checkpoint ──

    /**
     * Create a checkpoint: git add -A + git commit + record in DB.
     * If no changes, still records the checkpoint pointing at HEAD.
     */
    async commitCheckpoint(project, meta = {}) {
        return singleflight(`local-git-ckpt:${project.id}`, async () => {
            const { workspacePath } = await this.ensureProjectRuntime(project);

            // Ensure git is initialized
            await this.ensureGitInit(project);

            await this._git(workspacePath, ['add', '-A']);

            // Check if there are staged changes
            let hasChanges = true;
            try {
                await this._git(workspacePath, ['diff', '--cached', '--quiet']);
                hasChanges = false;
            } catch {
                // diff --quiet exits with 1 if there are changes
            }

            let sha;
            if (hasChanges) {
                const message = formatCheckpointMessage(meta);
                await this._git(workspacePath, ['commit', '-m', message]);
            }

            const headResult = await this._git(workspacePath, ['rev-parse', 'HEAD']);
            sha = headResult.stdout.trim();

            // Push to bare repo (best-effort)
            try {
                await this._git(workspacePath, ['push', 'origin', 'HEAD']);
            } catch {
                // Push failure is non-fatal for checkpoint
            }

            // Record checkpoint in DB
            const checkpointId = newId('ckpt');
            const now = Date.now();
            const row = {
                id: checkpointId,
                projectId: project.id,
                sessionId: meta.sessionId || null,
                baseSnapshotId: project.lastSnapshotId || null,
                status: 'ready',
                storageRef: null,
                diffRef: null,
                gitSha: sha,
                createdBy: meta.userId || null,
                createdAt: now,
                expiresAt: null,
            };
            await db.insert(schema.workspaceCheckpoints).values(row);

            // Update project last_sync_sha
            await db.update(schema.projects).set({
                lastSyncSha: sha,
            }).where(eq(schema.projects.id, project.id));

            await recordEvent({
                userId: project.userId,
                projectId: project.id,
                subjectType: 'workspace_checkpoint',
                subjectId: checkpointId,
                type: 'workspace_checkpoint.ready',
                data: {
                    sessionId: meta.sessionId,
                    trigger: meta.trigger || 'manual',
                    gitSha: sha,
                    hasChanges,
                },
            });

            return {
                id: checkpointId,
                project_id: project.id,
                session_id: meta.sessionId || null,
                git_sha: sha,
                status: 'ready',
                has_changes: hasChanges,
                created_at: now,
            };
        });
    }

    // ── Restore ──

    /**
     * Restore workspace to a specific checkpoint's git SHA.
     */
    async restoreCheckpoint(project, checkpointId, options = {}) {
        return singleflight(`local-git-restore:${project.id}`, async () => {
            const rows = await db.select().from(schema.workspaceCheckpoints)
                .where(and(
                    eq(schema.workspaceCheckpoints.id, checkpointId),
                    eq(schema.workspaceCheckpoints.projectId, project.id),
                ));

            if (rows.length === 0) {
                const err = new Error('Checkpoint not found');
                err.statusCode = 404;
                throw err;
            }

            const checkpoint = rows[0];
            if (!checkpoint.gitSha) {
                const err = new Error('Checkpoint has no git_sha');
                err.statusCode = 409;
                throw err;
            }

            const { workspacePath } = await this.ensureProjectRuntime(project);

            // Verify SHA exists in repo
            try {
                await this._git(workspacePath, ['cat-file', '-t', checkpoint.gitSha]);
            } catch {
                const err = new Error(`SHA ${checkpoint.gitSha} not found in repository`);
                err.statusCode = 409;
                throw err;
            }

            // Auto-checkpoint current state before destructive restore
            // so uncommitted work is not lost (git reset --hard + clean).
            try {
                const statusResult = await this._git(workspacePath, ['status', '--porcelain']);
                if (statusResult.stdout && statusResult.stdout.trim()) {
                    await this._git(workspacePath, ['add', '-A']);
                    const autoMsg = `auto-checkpoint: pre-restore safety snapshot ${new Date().toISOString()}`;
                    await this._git(workspacePath, ['commit', '-m', autoMsg]);
                    // Best-effort push to bare repo for backup.
                    try { await this._git(workspacePath, ['push', 'origin', 'HEAD']); } catch { /* non-fatal */ }
                }
            } catch (autoCkptErr) {
                // Non-fatal: log but proceed with restore even if auto-checkpoint fails.
                console.warn('[LocalGitService] auto-checkpoint before restore failed:', autoCkptErr.message);
            }

            await this._git(workspacePath, ['reset', '--hard', checkpoint.gitSha], { timeoutMs: 60_000 });

            if (options.cleanUntracked !== false) {
                await this._git(workspacePath, ['clean', '-fd']);
            }

            await db.update(schema.projects).set({
                lastSyncSha: checkpoint.gitSha,
            }).where(eq(schema.projects.id, project.id));

            await recordEvent({
                userId: project.userId,
                projectId: project.id,
                subjectType: 'workspace_checkpoint',
                subjectId: checkpointId,
                type: 'workspace_checkpoint.restored',
                data: { gitSha: checkpoint.gitSha, cleanUntracked: options.cleanUntracked !== false },
            });

            return {
                id: checkpointId,
                project_id: project.id,
                git_sha: checkpoint.gitSha,
                restored: true,
            };
        });
    }

    // ── Introspection ──

    /**
     * Get recent commit log.
     * @returns {Array<{ sha, message, timestamp }>}
     */
    async getLog(project, options = {}) {
        const { workspacePath } = await this.ensureProjectRuntime(project);
        const count = Math.min(options.count || 20, 100);
        const result = await this._git(workspacePath, [
            'log', `-n`, String(count), `--format=%H %s %ct`,
        ]);

        return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
            const spaceIdx = line.indexOf(' ');
            const sha = line.slice(0, spaceIdx);
            const rest = line.slice(spaceIdx + 1);
            const lastSpace = rest.lastIndexOf(' ');
            const message = rest.slice(0, lastSpace);
            const timestamp = Number(rest.slice(lastSpace + 1));
            return { sha, message, timestamp };
        });
    }

    /**
     * Get diff for a specific commit (git show --stat).
     */
    async getDiff(project, sha, options = {}) {
        const { workspacePath } = await this.ensureProjectRuntime(project);

        // Verify SHA exists
        try {
            await this._git(workspacePath, ['cat-file', '-t', sha]);
        } catch {
            const err = new Error(`SHA ${sha} not found in repository`);
            err.statusCode = 404;
            throw err;
        }

        if (options.full) {
            const result = await this._git(workspacePath, ['show', sha], { timeoutMs: 60_000 });
            return { sha, diff: result.stdout };
        }

        const statResult = await this._git(workspacePath, ['show', '--stat', sha]);
        return { sha, stat: statResult.stdout };
    }

    /**
     * Get diff between two commits or between a commit and working tree.
     */
    async diffRange(project, fromSha, toSha) {
        const { workspacePath } = await this.ensureProjectRuntime(project);
        const args = toSha ? ['diff', fromSha, toSha] : ['diff', fromSha];
        const result = await this._git(workspacePath, args, { timeoutMs: 60_000 });
        return { from: fromSha, to: toSha || 'working-tree', diff: result.stdout };
    }

    // ── Phase 4: Advanced Git Features ──

    /**
     * Git blame for a file.
     * @returns {Array<{ sha, author, date, lineNumber, content }>}
     */
    async blame(project, filePath, options = {}) {
        const { workspacePath } = await this.ensureProjectRuntime(project);

        // Validate file path (no traversal)
        const normalized = path.normalize(filePath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
            const err = new Error('Invalid file path');
            err.statusCode = 400;
            throw err;
        }

        const args = ['blame', '--porcelain'];
        if (options.startLine && options.endLine) {
            args.push(`-L`, `${options.startLine},${options.endLine}`);
        }
        if (options.ref) {
            args.push(options.ref);
        }
        args.push('--', normalized);

        let result;
        try {
            result = await this._git(workspacePath, args, { timeoutMs: 60_000 });
        } catch (err) {
            if (err.message?.includes('no such path') || err.message?.includes('fatal:')) {
                const e = new Error(`File not found: ${filePath}`);
                e.statusCode = 404;
                throw e;
            }
            throw err;
        }

        return parseBlameOutput(result.stdout);
    }

    /**
     * Detailed commit log with file changes and author info.
     * @returns {Array<{ sha, message, author, email, timestamp, files }>}
     */
    async logDetailed(project, options = {}) {
        const { workspacePath } = await this.ensureProjectRuntime(project);
        const count = Math.min(options.count || 20, 100);
        const args = [
            'log', `-n`, String(count),
            `--format=COMMIT_START%n%H%n%an%n%ae%n%ct%n%s%n%b%nCOMMIT_BODY_END`,
            '--name-status',
        ];
        if (options.path) {
            args.push('--', options.path);
        }

        try {
            const result = await this._git(workspacePath, args, { timeoutMs: 60_000 });
            return parseDetailedLog(result.stdout);
        } catch (err) {
            if (err.message?.includes('does not have any commits')) {
                return [];
            }
            throw err;
        }
    }

    async logGraph(project, options = {}) {
        const { workspacePath } = await this.ensureProjectRuntime(project);
        const count = Math.min(options.count || 20, 100);

        let currentBranch = 'HEAD';
        try {
            const revParse = await this._git(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
            currentBranch = revParse.stdout.trim();
        } catch {
            currentBranch = 'HEAD';
        }

        const refs = [currentBranch];
        try {
            await this._git(workspacePath, ['rev-parse', '--verify', `refs/remotes/origin/${currentBranch}`]);
            refs.push(`origin/${currentBranch}`);
        } catch {
            // no remote tracking branch
        }

        const args = [
            'log', '--graph', ...refs, `-n`, String(count),
            '--date-order',
            '--format=%x00%H%x00%s%x00%ct%x00%an%x00%ae%x00%D%x00',
        ];
        try {
            const result = await this._git(workspacePath, args, { timeoutMs: 60_000 });
            return parseGraphLog(result.stdout);
        } catch (err) {
            if (err.message?.includes('does not have any commits')) {
                return [];
            }
            throw err;
        }
    }

    async listTrackedFiles(project) {
        const { workspacePath } = await this.ensureProjectRuntime(project);
        const result = await this._git(workspacePath, ['ls-files', '--cached', '--full-name'], { timeoutMs: 15_000 });
        return result.stdout.split('\n').filter(Boolean);
    }

    async getCommitFiles(project, sha) {
        const { workspacePath } = await this.ensureProjectRuntime(project);
        const result = await this._git(workspacePath, [
            'diff-tree', '--no-commit-id', '--name-status', '-r', sha,
        ], { timeoutMs: 30_000 });
        return result.stdout.split('\n').filter(Boolean).map((line) => {
            const parts = line.split('\t');
            if (parts.length < 2) return null;
            return { status: parts[0][0], path: parts[parts.length - 1] };
        }).filter(Boolean);
    }

    /**
     * Check for merge conflicts between current branch and a target branch.
     * Performs a dry-run merge (no actual changes).
     * @returns {{ canMerge, conflictFiles, aheadBehind }}
     */
    async conflictCheck(project, targetBranch) {
        const { workspacePath } = await this.ensureProjectRuntime(project);

        // Get ahead/behind counts
        let ahead = 0, behind = 0;
        try {
            const abResult = await this._git(workspacePath, [
                'rev-list', '--left-right', '--count', `HEAD...origin/${targetBranch}`,
            ]);
            const parts = abResult.stdout.trim().split(/\s+/);
            ahead = Number(parts[0]) || 0;
            behind = Number(parts[1]) || 0;
        } catch {
            // Branch may not exist on remote
        }

        // Dry-run merge to detect conflicts
        let canMerge = true;
        let conflictFiles = [];

        try {
            // Fetch latest target
            await this._git(workspacePath, ['fetch', 'origin', targetBranch], { timeoutMs: 60_000 });
        } catch {
            // Fetch failed — can't check
            return { canMerge: null, conflictFiles: [], aheadBehind: { ahead, behind } };
        }

        try {
            await this._git(workspacePath, ['merge-tree', '--write-tree', 'HEAD', `origin/${targetBranch}`]);
        } catch (err) {
            // merge-tree exits non-zero when there are conflicts
            canMerge = false;
            // Parse conflict files from output
            const output = err.message || '';
            conflictFiles = parseMergeTreeConflicts(output);
        }

        return { canMerge, conflictFiles, aheadBehind: { ahead, behind } };
    }

    /**
     * List files with merge conflicts in the working tree (after a merge attempt).
     * @returns {Array<{ path, status, ours, theirs }>}
     */
    async listConflicts(project) {
        const { workspacePath } = await this.ensureProjectRuntime(project);

        try {
            const result = await this._git(workspacePath, ['diff', '--name-only', '--diff-filter=U']);
            const files = result.stdout.trim().split('\n').filter(Boolean);

            const conflicts = [];
            for (const file of files) {
                conflicts.push({
                    path: file,
                    status: 'conflicted',
                });
            }
            return conflicts;
        } catch (err) {
            if (err.message?.includes('not a git repository')) {
                return [];
            }
            throw err;
        }
    }

    /**
     * Resolve a conflict by choosing a strategy (ours/theirs/manual).
     */
    async resolveConflict(project, filePath, strategy) {
        const { workspacePath } = await this.ensureProjectRuntime(project);

        const normalized = path.normalize(filePath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
            const err = new Error('Invalid file path');
            err.statusCode = 400;
            throw err;
        }

        if (strategy === 'ours') {
            await this._git(workspacePath, ['checkout', '--ours', '--', normalized]);
            await this._git(workspacePath, ['add', normalized]);
        } else if (strategy === 'theirs') {
            await this._git(workspacePath, ['checkout', '--theirs', '--', normalized]);
            await this._git(workspacePath, ['add', normalized]);
        } else {
            // 'manual' — just mark as resolved (file was already edited)
            await this._git(workspacePath, ['add', normalized]);
        }

        return { path: normalized, resolved: true, strategy };
    }

    /**
     * Get file content at a specific ref (for conflict visualization).
     */
    async showFile(project, filePath, ref = 'HEAD') {
        const { workspacePath } = await this.ensureProjectRuntime(project);

        const normalized = path.normalize(filePath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
            const err = new Error('Invalid file path');
            err.statusCode = 400;
            throw err;
        }

        // For conflict resolution, "theirs" is MERGE_HEAD during a merge,
        // REBASE_HEAD during a rebase, or index stage 3 (:3:) during a
        // stash pop (which does not create MERGE_HEAD/REBASE_HEAD).
        // Try the requested ref first, then fall back so the conflict UI
        // works in all scenarios.
        let refsToTry;
        if (ref === 'MERGE_HEAD') {
            refsToTry = [
                { ref: 'MERGE_HEAD', format: 'show' },
                { ref: 'REBASE_HEAD', format: 'show' },
                { ref: ':3:', format: 'stage' },
            ];
        } else if (ref === 'HEAD') {
            refsToTry = [
                { ref: 'HEAD', format: 'show' },
                { ref: ':2:', format: 'stage' },
            ];
        } else {
            refsToTry = [{ ref, format: 'show' }];
        }

        for (const { ref: tryRef, format } of refsToTry) {
            try {
                const gitArg = format === 'stage'
                    ? ['show', `${tryRef}${normalized}`]
                    : ['show', `${tryRef}:${normalized}`];
                const result = await this._git(workspacePath, gitArg);
                return { path: normalized, ref: tryRef, content: result.stdout };
            } catch {
                // try next ref
            }
        }

        const err = new Error(`File not found at ref ${ref}: ${filePath}`);
        err.statusCode = 404;
        throw err;
    }
}

// ── Parsers ──

function parseGraphLog(output) {
    const lines = output.split('\n');
    const commits = [];
    let pendingGraphLines = [];

    for (const line of lines) {
        if (!line.trim()) {
            pendingGraphLines = [];
            continue;
        }
        const nullIdx = line.indexOf('\x00');
        if (nullIdx === -1) {
            pendingGraphLines.push(line);
            continue;
        }
        const graph = pendingGraphLines.length > 0 ? pendingGraphLines.join('\n') + '\n' + line.slice(0, nullIdx) : line.slice(0, nullIdx);
        pendingGraphLines = [];

        const data = line.slice(nullIdx + 1).split('\x00');
        const sha = data[0];
        const subject = data[1] || '';
        const timestamp = Number(data[2]) || 0;
        const author = data[3] || '';
        const email = data[4] || '';
        const refsRaw = data[5] || '';

        const refs = [];
        if (refsRaw) {
            for (const ref of refsRaw.split(',')) {
                const trimmed = ref.trim();
                const arrowIdx = trimmed.indexOf(' -> ');
                if (arrowIdx !== -1) {
                    refs.push({ name: trimmed.slice(arrowIdx + 4).trim(), label: trimmed.slice(0, arrowIdx).trim() });
                } else {
                    const tagPrefix = trimmed.startsWith('tag: ') ? trimmed.slice(5).trim() : null;
                    refs.push({ name: tagPrefix || trimmed, label: tagPrefix ? 'tag' : 'ref' });
                }
            }
        }

        commits.push({
            sha,
            message: subject,
            author,
            email,
            timestamp,
            refs,
            graph,
        });
    }

    return commits;
}

function parseBlameOutput(output) {
    const lines = output.split('\n');
    const entries = [];
    let current = null;
    let lineNumber = 0;

    for (const line of lines) {
        if (/^[0-9a-f]{40}/.test(line)) {
            const parts = line.split(' ');
            const sha = parts[0];
            lineNumber = Number(parts[2]) || lineNumber + 1;
            current = { sha, lineNumber, author: null, date: null, content: '' };
        } else if (line.startsWith('author ') && current) {
            current.author = line.slice(7);
        } else if (line.startsWith('author-time ') && current) {
            current.date = Number(line.slice(12)) || null;
        } else if (line.startsWith('\t') && current) {
            current.content = line.slice(1);
            entries.push(current);
            current = null;
        }
    }

    return entries;
}

function parseDetailedLog(output) {
    const commits = [];
    const blocks = output.split('COMMIT_START\n').filter(Boolean);

    for (const block of blocks) {
        const bodyEnd = block.indexOf('COMMIT_BODY_END');
        const headerPart = block.slice(0, bodyEnd);
        const filePart = block.slice(bodyEnd + 'COMMIT_BODY_END'.length);

        const headerLines = headerPart.split('\n');
        const sha = headerLines[0];
        const author = headerLines[1];
        const email = headerLines[2];
        const timestamp = Number(headerLines[3]) || 0;
        const subject = headerLines[4] || '';
        const body = headerLines.slice(5).join('\n').trim();

        const files = filePart.trim().split('\n').filter(Boolean).map((fl) => {
            const match = fl.match(/^([AMDRC]\d*)\t(.+)$/);
            if (!match) return null;
            return { status: match[1][0], path: match[2] };
        }).filter(Boolean);

        if (sha) {
            commits.push({
                sha,
                message: subject,
                body: body || null,
                author,
                email,
                timestamp,
                files,
            });
        }
    }

    return commits;
}

function parseMergeTreeConflicts(output) {
    const files = [];
    const lines = output.split('\n');
    for (const line of lines) {
        // merge-tree conflict output format varies; look for conflict markers
        const match = line.match(/CONFLICT \([^)]+\): (.+)/);
        if (match) {
            files.push(match[1].trim());
        }
    }
    return files;
}

module.exports = {
    LocalGitService,
    bareRepoPath,
    formatCheckpointMessage,
    BARE_REPO_ROOT,
    parseBlameOutput,
    parseDetailedLog,
};
