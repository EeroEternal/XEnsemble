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

function projectDir(userId, projectId) {
    return path.join(WORKSPACE_ROOT, userId, projectId);
}

function worktreeDir(userId, projectId, runtimeId) {
    return path.join(WORKSPACE_ROOT, userId, `${projectId}.wt`, runtimeId);
}

function createProjectDirectory(userId, projectId) {
    ensureWorkspaceRoot();
    const dir = projectDir(userId, projectId);
    fs.mkdirSync(dir, { recursive: true });
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
    worktreeDir,
    createProjectDirectory,
    resolveSafePath,
};
