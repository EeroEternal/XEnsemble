const { FsAdapter, RuntimeError } = require('./interfaces');
const BoxLiteClient = require('./BoxLiteClient');
const { buildSessionStateDirRef } = require('../session/stateDirRef');
const { isHiddenWorkspacePath } = require('../workspace/hiddenPaths');

function safeRel(p) {
    const s = String(p || '.').replace(/\\/g, '/').replace(/^\//, '');
    if (s.includes('..')) return '.';
    return s || '.';
}

class BoxLiteFsAdapter extends FsAdapter {
    constructor() {
        super();
        this.client = new BoxLiteClient();
    }

    async fsList(rootDir, relativePath = '.', opts = {}) {
        const name = opts.runtimeRef;
        if (!name) return [];
        const rel = safeRel(relativePath);
        const cwd = '/workspace';
        const depth = opts.depth || 'recursive';
        const maxdepth = depth === 'single' ? 1 : 6;
        const limit = 1000;
        try {
            const cmd = `cd ${JSON.stringify(cwd)} && find ${JSON.stringify(rel)} -maxdepth ${maxdepth} \\( -type f -o -type d \\) -printf '%y %p %s\\n' 2>/dev/null | head -${limit + 50}`;
            const r = await this.client.execForResult(name, 'sh', ['-c', cmd], {}, cwd);
            const out = (r.stdout || '').trim();
            if (!out) return [];
            const res = [];
            for (const line of out.split('\n')) {
                if (!line.trim()) continue;
                if (res.length >= limit) break;
                const parts = line.split(' ');
                const t = parts[0];
                const sizeStr = parts[parts.length - 1];
                let p = parts.slice(1, -1).join(' ').trim();
                if (!p || p === '.' || p === '..') continue;
                if (p.startsWith('./')) p = p.slice(2);
                // 跳过被列目录自身（find <path> 会返回 <path> 自身作为第一个结果）
                if (p === rel) continue;
                if (!opts.includeHidden && isHiddenWorkspacePath(p)) continue;
                const nameOnly = p.split('/').pop() || p;
                const entry = {
                    name: nameOnly,
                    path: p,
                    type: t === 'd' ? 'directory' : 'file',
                };
                if (entry.type === 'file') {
                    entry.size = parseInt(sizeStr, 10) || 0;
                }
                res.push(entry);
            }
            return res;
        } catch (_) {
            return [];
        }
    }

    async fsRead(rootDir, relativePath, opts = {}) {
        const name = opts.runtimeRef;
        if (!name) throw new RuntimeError('runtimeRef required', 400);
        const rel = safeRel(relativePath);
        const cwd = '/workspace';
        const encoding = opts.encoding || 'utf8';
        try {
            const target = rel.startsWith('/') ? rel : (cwd.replace(/\/$/, '') + '/' + rel);
            const command = encoding === 'buffer' ? 'base64' : 'cat';
            const r = await this.client.execForResult(name, command, [target], {}, cwd);
            if (r.exitCode !== 0) throw new RuntimeError('read failed', 404);
            return r.stdout || '';
        } catch (e) {
            throw new RuntimeError(e.message || 'fs read error', 500);
        }
    }

    async fsStat(rootDir, relativePath, opts = {}) {
        const name = opts.runtimeRef;
        if (!name) throw new RuntimeError('runtimeRef required', 400);
        const target = this.boxTarget(rootDir, relativePath);
        const cwd = '/workspace';
        try {
            const r = await this.client.execForResult(name, 'stat', ['-c', '%F %s %Y', target], {}, cwd);
            if (r.exitCode !== 0) throw new RuntimeError('File not found', 404);
            const parts = r.stdout.trim().split(/\s+/);
            const type = parts[0] === 'directory' ? 'directory' : 'file';
            const size = parseInt(parts[1], 10) || 0;
            const mtime = parseFloat(parts[2]) * 1000;
            return { type, size, mtime };
        } catch (e) {
            if (e instanceof RuntimeError) throw e;
            throw new RuntimeError('File not found', 404);
        }
    }

    resolveStateDir(workspaceRoot, sessionId) {
        const stateDirRef = buildSessionStateDirRef(sessionId);
        const root = String(workspaceRoot || '/workspace').replace(/\/$/, '');
        const rel = stateDirRef.replace(/\\/g, '/');
        const stateDirPath = `${root}/${rel}`;
        return { stateDirRef, stateDirPath };
    }

    boxTarget(rootDir, relativePath) {
        const rel = safeRel(relativePath);
        const cwd = '/workspace';
        if (rel.startsWith('/')) {
            return rel;
        }
        return `${cwd.replace(/\/$/, '')}/${rel}`;
    }

    async exists(rootDir, relativePath, opts = {}) {
        const name = opts.runtimeRef;
        if (!name) {
            return false;
        }
        const target = this.boxTarget(rootDir, relativePath);
        const cwd = '/workspace';
        try {
            const r = await this.client.execForResult(name, 'test', ['-e', target], {}, cwd);
            return r.exitCode === 0;
        } catch (_) {
            return false;
        }
    }

    async mkdirp(rootDir, relativePath, opts = {}) {
        const name = opts.runtimeRef;
        if (!name) {
            throw new RuntimeError('runtimeRef required', 400);
        }
        const target = this.boxTarget(rootDir, relativePath);
        const cwd = '/workspace';
        const r = await this.client.execForResult(name, 'mkdir', ['-p', target], {}, cwd);
        if (r.exitCode !== 0) {
            throw new RuntimeError('mkdir failed', 500);
        }
    }

    async fsWrite(rootDir, relativePath, content, opts = {}) {
        const name = opts.runtimeRef;
        if (!name) throw new RuntimeError('runtimeRef required', 400);
        const raw = String(relativePath || '');
        if (raw.includes('..')) throw new RuntimeError('Invalid path', 400);
        const isAbsolute = raw.startsWith('/');
        const rel = isAbsolute ? raw : safeRel(raw);
        const cwd = '/workspace';
        const target = isAbsolute ? rel : (cwd.replace(/\/$/, '') + '/' + rel);
        const parentDir = target.replace(/\/[^/]+$/, '');
        // Merge mkdir -p and base64 -d into a single VM exec to save one HTTP+WS round-trip.
        // 安全约束：用 sh -c 固定脚本 + 位置参数 $1/$2/$3 传递 content(base64)、target、parentDir，
        // 用户输入不经 shell 解析。base64 字符串只含 A-Za-z0-9+/=，无 shell 元字符。
        const b64 = Buffer.from(content).toString('base64');
        const script = 'mkdir -p "$3" && printf \'%s\' "$1" | base64 -d > "$2"';
        const r = await this.client.execForResult(name, 'sh', ['-c', script, 'sh', b64, target, parentDir], {}, cwd);
        if (r.exitCode !== 0) throw new RuntimeError('write failed', 500);
        const size = Buffer.byteLength(content);
        return { path: relativePath.replace(/\\/g, '/'), size };
    }

    async fsDelete(rootDir, relativePath, opts = {}) {
        const name = opts.runtimeRef;
        if (!name) throw new RuntimeError('runtimeRef required', 400);
        const rel = safeRel(relativePath);
        const cwd = '/workspace';
        const target = rel.startsWith('/') ? rel : (cwd.replace(/\/$/, '') + '/' + rel);
        const testR = await this.client.execForResult(name, 'test', ['-d', target], {}, cwd);
        if (testR.exitCode === 0) throw new RuntimeError('Cannot delete directory via file endpoint', 400);
        const r = await this.client.execForResult(name, 'rm', [target], {}, cwd);
        if (r.exitCode !== 0) throw new RuntimeError('File not found', 404);
    }

    async fsMove(rootDir, fromRel, toRel, opts = {}) {
        const name = opts.runtimeRef;
        if (!name) throw new RuntimeError('runtimeRef required', 400);
        const from = safeRel(fromRel);
        const to = safeRel(toRel);
        const cwd = '/workspace';
        const fromTarget = from.startsWith('/') ? from : (cwd.replace(/\/$/, '') + '/' + from);
        const toTarget = to.startsWith('/') ? to : (cwd.replace(/\/$/, '') + '/' + to);
        const existR = await this.client.execForResult(name, 'test', ['-e', toTarget], {}, cwd);
        if (existR.exitCode === 0) throw new RuntimeError('Target path already exists', 409);
        const r = await this.client.execForResult(name, 'mv', [fromTarget, toTarget], {}, cwd);
        if (r.exitCode !== 0) throw new RuntimeError('move failed', 500);
    }

    async fsRmdir(rootDir, relativePath, opts = {}) {
        if (!relativePath || relativePath === '.') {
            throw new RuntimeError('Cannot delete workspace root', 400);
        }
        const name = opts.runtimeRef;
        if (!name) throw new RuntimeError('runtimeRef required', 400);
        const rel = safeRel(relativePath);
        const cwd = '/workspace';
        const target = rel.startsWith('/') ? rel : (cwd.replace(/\/$/, '') + '/' + rel);
        // 安全约束：用 args 数组传参，不走 sh -c 字符串拼接（命令注入风险）。
        await this.client.execForResult(name, 'rm', ['-r', target], {}, cwd);
    }
}

module.exports = BoxLiteFsAdapter;
module.exports.safeRel = safeRel;
