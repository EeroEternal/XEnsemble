const fs = require('fs');
const path = require('path');
const { FsAdapter, RuntimeError } = require('./interfaces');
const { resolveSafePath } = require('../workspace');
const { isHiddenWorkspacePath } = require('../workspace/hiddenPaths');
const { buildSessionStateDirRef } = require('../session/stateDirRef');

const FS_LIST_LIMIT = 1000;

// 递归列举时剪枝的重目录：不返回其内容，也不递归进入。
// node_modules/.git/dist 等依赖与构建产物条目数量巨大（可达数十万），
// 若不剪枝会占满 FS_LIST_LIMIT，把真实项目文件（server/、package.json 等）
// 挤出 1000 条上限，导致部署分析把全栈项目误判为纯静态站点。
const SKIP_WALK_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
    '.venv', '__pycache__', '.cache', '.turbo', '.nx',
    'vendor', 'target', 'venv', '.tox', 'Pods', 'bower_components',
    'jspm_packages', '.gradle', '.m2', 'tmp', 'logs',
]);

class LocalFsAdapter extends FsAdapter {
    /**
     * 递归列出 rootDir 下所有文件与目录。
     * @param {string} rootDir  project workspace 绝对路径
     * @param {string} relativePath 相对路径（可选）
     * @returns {Promise<Array<{ name, path, type }>>}
     */
    async fsList(rootDir, relativePath = '.', opts = {}) {
        const target = resolveSafePath(rootDir, relativePath);
        if (!target) throw new RuntimeError('Access denied', 403);
        if (!fs.existsSync(target)) return [];
        const root = path.resolve(rootDir);
        const results = [];
        const depth = opts.depth || 'recursive';

        const addEntry = (fullPath, stat) => {
            const rel = path.relative(root, fullPath);
            const entry = {
                name: path.basename(fullPath),
                path: rel.startsWith('..') ? path.basename(fullPath) : rel.replace(/\\/g, '/'),
                type: stat.isDirectory() ? 'directory' : 'file',
            };
            if (entry.type === 'file') {
                entry.size = stat.size;
            }
            results.push(entry);
        };

        if (depth === 'single') {
            let entries;
            try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch (e) { return results; }
            for (const dirent of entries) {
                const fullPath = path.join(target, dirent.name);
                const rel = path.relative(root, fullPath).replace(/\\/g, '/');
                if (!opts.includeHidden && isHiddenWorkspacePath(rel)) continue;
                if (dirent.isSymbolicLink()) continue;
                let stat;
                try { stat = fs.lstatSync(fullPath); } catch (e) { continue; }
                addEntry(fullPath, stat);
            }
            return results;
        }

        const walk = (dirPath) => {
            let entries;
            try { entries = fs.readdirSync(dirPath); } catch (e) { return; }
            for (const name of entries) {
                const fullPath = path.join(dirPath, name);
                const rel = path.relative(root, fullPath).replace(/\\/g, '/');
                if (!opts.includeHidden && isHiddenWorkspacePath(rel)) continue;
                let stat;
                try { stat = fs.lstatSync(fullPath); } catch (e) { continue; }
                if (stat.isSymbolicLink()) continue;
                addEntry(fullPath, stat);
                if (stat.isDirectory() && !SKIP_WALK_DIRS.has(name)) walk(fullPath);
            }
        };
        walk(target);
        if (results.length > FS_LIST_LIMIT) {
            results.length = FS_LIST_LIMIT;
        }
        return results;
    }

    /**
     * 安全读取 rootDir 内的文件内容。
     * @param {string} rootDir      project workspace 绝对路径
     * @param {string} relativePath 相对路径
     * @returns {Promise<string>}
     */
    async fsRead(rootDir, relativePath, opts = {}) {
        const absolutePath = resolveSafePath(rootDir, relativePath);
        if (!absolutePath) throw new RuntimeError('Access denied', 403);
        if (!fs.existsSync(absolutePath)) throw new RuntimeError('File not found', 404);
        if (fs.statSync(absolutePath).isDirectory()) throw new RuntimeError('Path is a directory', 400);
        const encoding = opts.encoding === 'buffer' ? undefined : 'utf8';
        return fs.readFileSync(absolutePath, encoding);
    }

    async fsStat(rootDir, relativePath, opts = {}) {
        const absolutePath = resolveSafePath(rootDir, relativePath);
        if (!absolutePath) throw new RuntimeError('Access denied', 403);
        if (!fs.existsSync(absolutePath)) throw new RuntimeError('File not found', 404);
        const stat = fs.statSync(absolutePath);
        return { type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, mtime: stat.mtimeMs };
    }

    resolveStateDir(workspaceRoot, sessionId) {
        const stateDirRef = buildSessionStateDirRef(sessionId);
        const stateDirPath = resolveSafePath(workspaceRoot, stateDirRef);
        if (!stateDirPath) {
            return null;
        }
        return { stateDirRef, stateDirPath };
    }

    async exists(rootDir, relativePath, opts = {}) {
        const target = resolveSafePath(rootDir, relativePath);
        if (!target) {
            return false;
        }
        return fs.existsSync(target);
    }

    async mkdirp(rootDir, relativePath, opts = {}) {
        const target = resolveSafePath(rootDir, relativePath);
        if (!target) {
            throw new RuntimeError('Access denied', 403);
        }
        fs.mkdirSync(target, { recursive: true });
    }

    async fsWrite(rootDir, relativePath, content, opts = {}) {
        const target = resolveSafePath(rootDir, relativePath);
        if (!target) throw new RuntimeError('Access denied', 403);
        const parentDir = path.dirname(target);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.writeFileSync(target, content);
        const stat = fs.statSync(target);
        return { path: relativePath.replace(/\\/g, '/'), size: stat.size };
    }

    async fsDelete(rootDir, relativePath, opts = {}) {
        const target = resolveSafePath(rootDir, relativePath);
        if (!target) throw new RuntimeError('Access denied', 403);
        if (!fs.existsSync(target)) throw new RuntimeError('File not found', 404);
        if (fs.lstatSync(target).isDirectory()) throw new RuntimeError('Cannot delete directory via file endpoint', 400);
        fs.unlinkSync(target);
    }

    async fsMove(rootDir, fromRel, toRel, opts = {}) {
        const from = resolveSafePath(rootDir, fromRel);
        if (!from) throw new RuntimeError('Access denied', 403);
        const to = resolveSafePath(rootDir, toRel);
        if (!to) throw new RuntimeError('Access denied', 403);
        if (fs.existsSync(to)) throw new RuntimeError('Target path already exists', 409);
        fs.renameSync(from, to);
    }

    async fsRmdir(rootDir, relativePath, opts = {}) {
        if (!relativePath || relativePath === '.') {
            throw new RuntimeError('Cannot delete workspace root', 400);
        }
        const target = resolveSafePath(rootDir, relativePath);
        if (!target) throw new RuntimeError('Access denied', 403);
        fs.rmSync(target, { recursive: opts.recursive !== false, force: true });
    }
}

module.exports = LocalFsAdapter;
