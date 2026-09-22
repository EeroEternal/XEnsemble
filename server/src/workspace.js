const path = require('path');
const fs = require('fs');

// WORKSPACE_ROOT hosts per-user project data (clones, git worktrees, skill
// volumes). Production deployments must set this to a path OUTSIDE the repo
// (e.g. /var/lib/xensemble/workspaces) via xensemble.env → install.sh injects
// a sensible default when missing.
//
// Dev / npm start convention: server/.env ships WORKSPACE_ROOT=./server/data/workspaces
// so `npm run dev` from the repo root keeps workspace data inside the repo for
// inspection. That relative value is only correct when CWD is the repo root;
// in a dev container that runs `npm start` from <repo>/server, the same env
// resolves to <repo>/server/server/data/workspaces (the "double-server" bug
// that pollutes the source tree and breaks nested deploys).
//
// Hardening: if WORKSPACE_ROOT arrives as a relative path, resolve it against
// the repo root (this file's __dirname/../..) — independent of process.cwd().
// Absolute paths (production /var/lib/xensemble/workspaces, e2e tmpdir, etc.)
// pass through untouched, so neither prod nor tests change behavior.
const DEFAULT_WORKSPACE_ROOT = '/var/lib/xensemble/workspaces';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RAW_WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT;
const WORKSPACE_ROOT = path.isAbsolute(RAW_WORKSPACE_ROOT)
    ? RAW_WORKSPACE_ROOT
    : path.resolve(REPO_ROOT, RAW_WORKSPACE_ROOT);

function ensureWorkspaceRoot() {
    if (!fs.existsSync(WORKSPACE_ROOT)) {
        fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
    }
}

/**
 * Host-side owner the sandbox can write as.
 *
 * blink runs as a host user (administrator in the standard deploy) and its
 * virtiofs export enforces that host identity — the guest's root does NOT map to
 * host root. So workspace dirs/files created by the control plane (which runs as
 * root) are unwritable from inside the sandbox unless we hand them to the same
 * host user. Default: inherit WORKSPACE_ROOT's owner.
 */
function resolveHostWorkspaceOwner() {
    const uid = Number(process.env.WORKSPACE_OWNER_UID);
    const gid = Number(process.env.WORKSPACE_OWNER_GID);
    if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid };
    try {
        const st = fs.statSync(WORKSPACE_ROOT);
        return { uid: st.uid, gid: st.gid };
    } catch {
        return null;
    }
}

/**
 * Best-effort: make `dir` writable from inside the sandbox (owner + group).
 * `recursive` also fixes files created before this ran (e.g. by a root control
 * plane), which the agent could otherwise not edit.
 */
function ensureSandboxWritable(dir, { recursive = false } = {}) {
    const owner = resolveHostWorkspaceOwner();
    if (!owner || !dir) return;
    const apply = (target) => {
        try { fs.chownSync(target, owner.uid, owner.gid); } catch { /* best-effort */ }
        // Directories only: files must keep their mode, otherwise every tracked
        // file shows up as a "mode change" in the user's git status.
        try {
            if (fs.statSync(target).isDirectory()) fs.chmodSync(target, 0o775);
        } catch { /* best-effort */ }
    };
    apply(dir);
    if (!recursive) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const child = path.join(dir, entry.name);
        apply(child);
        if (entry.isDirectory()) ensureSandboxWritable(child, { recursive: true });
    }
}

/**
 * Repair the workspace entries the control plane creates host-side (as root when
 * the service runs as root): the workspace dir itself plus the well-known
 * subdirectories it seeds (.agents, .git). Cheap in the common case — three
 * stat() calls; only mismatching subtrees are chowned recursively.
 */
function repairWorkspaceOwnership(dir) {
    const owner = resolveHostWorkspaceOwner();
    if (!owner || !dir) return;
    const fix = (target) => {
        let st = null;
        try { st = fs.statSync(target); } catch { return; }
        if (st.uid === owner.uid) return;
        ensureSandboxWritable(target, { recursive: true });
        console.warn(`[workspace] repaired ownership for ${target} (uid ${st.uid} → ${owner.uid})`);
    };
    fix(dir);
    for (const sub of ['.agents', '.git']) fix(path.join(dir, sub));
}

function projectDir(userId, projectId) {
    return path.join(WORKSPACE_ROOT, userId, projectId);
}

function worktreeDir(userId, projectId, runtimeId) {
    return path.join(WORKSPACE_ROOT, userId, `${projectId}.wt`, runtimeId);
}

// 多仓库：每个 repo 的 worktree 在 runtime worktree 目录下的 <subPath> 子目录
// （BoxLiteRuntimeProvider._ensureRepoWorktree / GitOperationService repoSubPath 路由共用）
function repoWorktreePath(userId, projectId, runtimeId, subPath) {
    return path.join(worktreeDir(userId, projectId, runtimeId), subPath);
}

function createProjectDirectory(userId, projectId) {
    ensureWorkspaceRoot();
    const dir = projectDir(userId, projectId);
    fs.mkdirSync(dir, { recursive: true });
    ensureSandboxWritable(dir);
    const { seedAgentWorkspaceFiles, ensureGitignoreEntries } = require('./workspace/agentBootstrap');
    seedAgentWorkspaceFiles(dir);
    // 0025（方案 B）：导入工程即写入 .gitignore 忽略条目（.xensemble/ 与各 Agent 原生技能目录），
    // 否则技能落盘会以 untracked 形式污染 changes 面板
    ensureGitignoreEntries(dir);
    return dir;
}

/** Resolve a relative path inside project root; returns null if traversal escapes jail. */
function resolveSafePath(rootDir, relativePath) {
    const root = path.resolve(rootDir);
    const input = String(relativePath || '');
    if (input.includes('\0')) return null;
    const trimmed = input.replace(/^[/\\]+/, '');
    const safe = path.normalize(trimmed).replace(/^(\.\.(\/|\\|$))+/, '');
    if (safe.startsWith('..')) return null;
    const absolute = path.resolve(root, safe === '.' ? '' : safe);

    let realRoot;
    try {
        realRoot = fs.realpathSync.native(root);
    } catch {
        realRoot = root;
    }

    // Walk path components from root, resolving symlinks, to handle non-existent
    // final targets and symlinks (including broken ones) pointing outside the jail.
    const relativeParts = path.relative(root, absolute).split(path.sep).filter(Boolean);
    let resolvedReal = realRoot;

    for (let i = 0; i < relativeParts.length; i++) {
        const part = relativeParts[i];
        if (part === '..') return null;
        const current = path.join(root, ...relativeParts.slice(0, i + 1));

        let stat;
        try {
            stat = fs.lstatSync(current);
        } catch {
            // Component does not exist. Append remaining parts to the real path
            // and verify it stays inside root.
            const remaining = relativeParts.slice(i).join(path.sep);
            const finalReal = path.join(resolvedReal, remaining);
            const realRootNorm = path.normalize(realRoot + path.sep);
            const finalNorm = path.normalize(finalReal);
            if (finalNorm !== realRoot && !finalNorm.startsWith(realRootNorm)) {
                return null;
            }
            return absolute;
        }

        if (stat.isSymbolicLink()) {
            let linkTarget;
            try {
                linkTarget = fs.realpathSync.native(current);
            } catch {
                // Symlink target does not exist; resolve the link text manually.
                linkTarget = fs.readlinkSync(current);
                if (!path.isAbsolute(linkTarget)) {
                    linkTarget = path.resolve(path.dirname(current), linkTarget);
                }
                linkTarget = path.normalize(linkTarget);
            }
            const realRootNorm = path.normalize(realRoot + path.sep);
            const linkNorm = path.normalize(linkTarget + path.sep);
            if (linkTarget !== realRoot && !linkNorm.startsWith(realRootNorm)) {
                return null;
            }
            resolvedReal = linkTarget;
        } else {
            resolvedReal = path.join(resolvedReal, part);
        }
    }

    const realRootNorm = path.normalize(realRoot + path.sep);
    const realAbsNorm = path.normalize(resolvedReal);
    if (realAbsNorm !== realRoot && !realAbsNorm.startsWith(realRootNorm)) {
        return null;
    }
    return absolute;
}

module.exports = {
    WORKSPACE_ROOT,
    ensureWorkspaceRoot,
    projectDir,
    ensureSandboxWritable,
    repairWorkspaceOwnership,
    resolveHostWorkspaceOwner,
    worktreeDir,
    repoWorktreePath,
    createProjectDirectory,
    resolveSafePath,
};
