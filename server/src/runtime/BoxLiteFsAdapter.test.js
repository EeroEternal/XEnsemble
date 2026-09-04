const { test } = require('node:test');
const assert = require('node:assert/strict');

const BoxLiteFsAdapter = require('./BoxLiteFsAdapter');

class MockBoxLiteClient {
    constructor() {
        this.paths = new Set(); // file paths
        this.dirs = new Set(); // directory paths
        this.files = new Map(); // file path -> content
        this.calls = [];
    }

    async execForResult(sessionName, command, args = [], env = {}, workingDir = null) {
        this.calls.push({ sessionName, command, args, workingDir });
        if (command === 'test' && args[0] === '-e') {
            return { exitCode: (this.paths.has(args[1]) || this.dirs.has(args[1]) || this.files.has(args[1])) ? 0 : 1, stdout: '', stderr: '' };
        }
        if (command === 'test' && args[0] === '-d') {
            return { exitCode: this.dirs.has(args[1]) ? 0 : 1, stdout: '', stderr: '' };
        }
        if (command === 'mkdir') {
            this.dirs.add(args[1]);
            this.paths.add(args[1]);
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (command === 'cat') {
            if (this.files.has(args[0])) {
                return { exitCode: 0, stdout: this.files.get(args[0]), stderr: '' };
            }
            return { exitCode: 1, stdout: '', stderr: 'No such file' };
        }
        if (command === 'base64') {
            if (this.files.has(args[0])) {
                return { exitCode: 0, stdout: Buffer.from(this.files.get(args[0])).toString('base64'), stderr: '' };
            }
            return { exitCode: 1, stdout: '', stderr: 'No such file' };
        }
        if (command === 'rm') {
            // fsDelete: rm <file>; fsRmdir: rm -r <dir>
            const target = args[args.length - 1];
            const recursive = args.includes('-r') || args.includes('-rf');
            if (recursive) {
                for (const p of [...this.files.keys()]) {
                    if (p === target || p.startsWith(target + '/')) this.files.delete(p);
                }
                for (const p of [...this.paths]) {
                    if (p === target || p.startsWith(target + '/')) this.paths.delete(p);
                }
                for (const p of [...this.dirs]) {
                    if (p === target || p.startsWith(target + '/')) this.dirs.delete(p);
                }
                return { exitCode: 0, stdout: '', stderr: '' };
            }
            if (this.files.has(target)) {
                this.files.delete(target);
                this.paths.delete(target);
                return { exitCode: 0, stdout: '', stderr: '' };
            }
            return { exitCode: 1, stdout: '', stderr: 'No such file' };
        }
        if (command === 'mv') {
            this.files.set(args[1], this.files.get(args[0]) || '');
            this.files.delete(args[0]);
            this.paths.delete(args[0]);
            this.paths.add(args[1]);
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (command === 'sh' && args[0] === '-c') {
            const cmd = args[1];
            const findCmd = cmd.includes('&& find ') ? cmd.slice(cmd.indexOf('find ')) : cmd;
            if (findCmd.startsWith('find ') || cmd.startsWith('find ')) {
                const maxdepthMatch = (findCmd || cmd).match(/-maxdepth (\d+)/);
                const maxdepth = maxdepthMatch ? parseInt(maxdepthMatch[1], 10) : 6;
                const lines = [];
                for (const [filePath, content] of this.files) {
                    if (filePath.startsWith('/workspace/')) {
                        const rel = filePath.slice('/workspace/'.length);
                        const depth = rel.split('/').length;
                        if (depth <= maxdepth) {
                            const size = Buffer.byteLength(content);
                            lines.push(`f ${rel} ${size}`);
                        }
                    }
                }
                for (const dir of this.dirs) {
                    if (dir.startsWith('/workspace/') && dir !== '/workspace') {
                        const rel = dir.slice('/workspace/'.length);
                        const depth = rel.split('/').length;
                        if (depth <= maxdepth && rel && !rel.includes('/')) {
                            lines.push(`d ${rel} 0`);
                        }
                    }
                }
                return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
            }
            if (cmd.includes('cat > ')) {
                const match = cmd.match(/cat > (\S+) <<'EOF'\n([\s\S]*?)EOF/);
                if (match) {
                    const target = match[1];
                    const content = match[2].replace(/\n$/, '');
                    this.files.set(target, content);
                    this.paths.add(target);
                    return { exitCode: 0, stdout: '', stderr: '' };
                }
            }
            // fsWrite: sh -c "printf '%s' \"$1\" | base64 -d > \"$2\"" sh <b64> <target>
            // args = ['-c', script, 'sh', b64, target]
            if (cmd.includes("base64 -d > ")) {
                const b64 = args[3];
                const target = args[4];
                if (b64 !== undefined && target) {
                    const content = Buffer.from(b64, 'base64').toString('utf8');
                    this.files.set(target, content);
                    this.paths.add(target);
                    return { exitCode: 0, stdout: '', stderr: '' };
                }
            }
            if (cmd.startsWith('rm -r ')) {
                const target = cmd.slice('rm -r '.length).trim();
                for (const p of [...this.files.keys()]) {
                    if (p === target || p.startsWith(target + '/')) this.files.delete(p);
                }
                for (const p of [...this.paths]) {
                    if (p === target || p.startsWith(target + '/')) this.paths.delete(p);
                }
                for (const p of [...this.dirs]) {
                    if (p === target || p.startsWith(target + '/')) this.dirs.delete(p);
                }
                return { exitCode: 0, stdout: '', stderr: '' };
            }
        }
        return { exitCode: 1, stdout: '', stderr: '' };
    }
}

test('BoxLite resolveStateDir uses in-box workspace paths', () => {
    const adapter = new BoxLiteFsAdapter();
    const resolved = adapter.resolveStateDir('/workspace', 'sess_box');
    assert.match(resolved.stateDirRef, /\.xensemble[/\\]state[/\\]sess_box$/);
    assert.equal(resolved.stateDirPath, '/workspace/.xensemble/state/sess_box');
});

test('BoxLite exists and mkdirp operate through blink exec', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    const sessionId = 'sess_box';
    const resolved = adapter.resolveStateDir('/workspace', sessionId);
    const opts = { runtimeRef: 'box_session_1' };

    assert.equal(await adapter.exists('/workspace', resolved.stateDirRef, opts), false);
    await adapter.mkdirp('/workspace', resolved.stateDirRef, opts);
    assert.equal(await adapter.exists('/workspace', resolved.stateDirRef, opts), true);
    assert.equal(client.calls[0].sessionName, 'box_session_1');
    assert.equal(client.calls[0].command, 'test');
    assert.equal(client.calls[1].command, 'mkdir');
    assert.equal(client.calls[1].args[1], '/workspace/.xensemble/state/sess_box');
});

// ─── 3.A.1: fsList depth parameter ───

test('BoxLite fsList with depth=single uses find -maxdepth 1', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    client.files.set('/workspace/src/main.js', 'code');
    client.dirs.add('/workspace/src');
    client.dirs.add('/workspace');
    const list = await adapter.fsList('/workspace', '.', { depth: 'single', runtimeRef: 'sess1' });
    const cmd = client.calls[0].args[1];
    assert.ok(cmd.includes('-maxdepth 1'), 'should use maxdepth 1');
    const paths = list.map((e) => e.path).sort();
    assert.ok(paths.includes('src'));
    assert.strictEqual(list.length, 1, 'should only have direct children');
});

test('BoxLite fsList with depth=recursive uses find -maxdepth 6', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    client.files.set('/workspace/src/main.js', 'code');
    client.dirs.add('/workspace/src');
    client.dirs.add('/workspace');
    const list = await adapter.fsList('/workspace', '.', { depth: 'recursive', runtimeRef: 'sess1' });
    const cmd = client.calls[0].args[1];
    assert.ok(cmd.includes('-maxdepth 6'), 'should use maxdepth 6');
});

// ─── 防回归：find <path> 返回 <path> 自身时必须跳过 ───

test('BoxLite fsList skips the listed directory itself (find returns self)', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    // 模拟真实 find src -maxdepth 1 的输出（第一行是 src 自身）
    client.execForResult = async (sessionName, command, args = []) => {
        client.calls.push({ sessionName, command, args });
        if (command === 'sh' && args[0] === '-c' && args[1].includes('find')) {
            return {
                exitCode: 0,
                stdout: 'd src 0\nd src/components 0\nf src/index.js 100',
                stderr: '',
            };
        }
        return { exitCode: 1, stdout: '', stderr: '' };
    };
    const list = await adapter.fsList('/workspace', 'src', { depth: 'single', runtimeRef: 'sess1' });
    const paths = list.map((e) => e.path);
    // 自身条目 'src' 必须被跳过，否则 buildTree 无限递归
    assert.ok(!paths.includes('src'), 'must skip the listed directory itself');
    assert.ok(paths.includes('src/components'), 'should include subdirectories');
    assert.ok(paths.includes('src/index.js'), 'should include files');
});

// ─── 3.A.2: fsList returns size field ───

test('BoxLite fsList returns size field via find -printf %s', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    client.files.set('/workspace/readme.md', 'hello world');
    client.dirs.add('/workspace');
    const list = await adapter.fsList('/workspace', '.', { depth: 'single', runtimeRef: 'sess1' });
    const cmd = client.calls[0].args[1];
    assert.ok(cmd.includes('%s'), 'should include %s for size');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'readme.md');
    assert.strictEqual(list[0].type, 'file');
    assert.strictEqual(typeof list[0].size, 'number');
    assert.strictEqual(list[0].size, 11);
});

// ─── 3.A.3: fsRead encoding parameter ───

test('BoxLite fsRead with encoding=utf8 uses cat', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    client.files.set('/workspace/hello.txt', 'hello utf8');
    const content = await adapter.fsRead('/workspace', 'hello.txt', { encoding: 'utf8', runtimeRef: 'sess1' });
    assert.strictEqual(client.calls[0].command, 'cat');
    assert.strictEqual(typeof content, 'string');
    assert.strictEqual(content, 'hello utf8');
});

test('BoxLite fsRead with encoding=buffer uses base64', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    client.files.set('/workspace/data.bin', 'binary data');
    const content = await adapter.fsRead('/workspace', 'data.bin', { encoding: 'buffer', runtimeRef: 'sess1' });
    assert.strictEqual(client.calls[0].command, 'base64');
    assert.strictEqual(typeof content, 'string');
    assert.strictEqual(content, Buffer.from('binary data').toString('base64'));
});

// ─── 3.A.4: fsWrite / fsDelete / fsMove / fsRmdir ───

test('BoxLite fsWrite creates file via base64 pipe (no heredoc)', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    client.dirs.add('/workspace');
    await adapter.fsWrite('/workspace', 'new.js', 'const x = 1;', { runtimeRef: 'sess1' });
    assert.strictEqual(client.files.get('/workspace/new.js'), 'const x = 1;');
    // 安全约束：禁止用 heredoc
    const shCall = client.calls.find(c => c.command === 'sh');
    assert.ok(shCall, 'should call sh');
    assert.ok(!shCall.args[1].includes('<<'), 'must not use heredoc');
    assert.ok(shCall.args[1].includes('base64 -d'), 'should use base64 pipe');
});

test('BoxLite fsDelete removes file via rm', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    client.files.set('/workspace/old.js', 'bye');
    await adapter.fsDelete('/workspace', 'old.js', { runtimeRef: 'sess1' });
    assert.ok(client.calls.some(c => c.command === 'rm'), 'should call rm');
    assert.strictEqual(client.files.has('/workspace/old.js'), false);
});

test('BoxLite fsDelete rejects directory with 400', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    client.dirs.add('/workspace/mydir');
    let err;
    try {
        await adapter.fsDelete('/workspace', 'mydir', { runtimeRef: 'sess1' });
    } catch (e) {
        err = e;
    }
    assert.ok(err, 'should throw');
    assert.strictEqual(err.statusCode, 400);
});

test('BoxLite fsMove renames via mv', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    client.files.set('/workspace/a.txt', 'data');
    await adapter.fsMove('/workspace', 'a.txt', 'b.txt', { runtimeRef: 'sess1' });
    assert.ok(client.calls.some(c => c.command === 'mv'), 'should call mv');
    assert.strictEqual(client.files.has('/workspace/a.txt'), false);
    assert.strictEqual(client.files.get('/workspace/b.txt'), 'data');
});

test('BoxLite fsMove rejects when target exists (409)', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    client.files.set('/workspace/a.txt', 'a');
    client.files.set('/workspace/b.txt', 'b');
    let err;
    try {
        await adapter.fsMove('/workspace', 'a.txt', 'b.txt', { runtimeRef: 'sess1' });
    } catch (e) {
        err = e;
    }
    assert.ok(err, 'should throw');
    assert.strictEqual(err.statusCode, 409);
});

test('BoxLite fsRmdir removes directory via rm -r args (no sh -c)', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    client.dirs.add('/workspace/olddir');
    client.files.set('/workspace/olddir/file.js', 'code');
    await adapter.fsRmdir('/workspace', 'olddir', { runtimeRef: 'sess1' });
    // 安全约束：用 rm args 数组，禁止 sh -c 字符串拼接
    const rmCall = client.calls.find(c => c.command === 'rm');
    assert.ok(rmCall, 'should call rm directly (not sh -c)');
    assert.ok(rmCall.args.includes('-r'), 'should pass -r arg');
    assert.strictEqual(rmCall.args[rmCall.args.length - 1], '/workspace/olddir');
    assert.strictEqual(client.dirs.has('/workspace/olddir'), false);
});

test('BoxLite fsRmdir rejects root (empty path)', async () => {
    const adapter = new BoxLiteFsAdapter();
    const client = new MockBoxLiteClient();
    adapter.client = client;
    let err;
    try {
        await adapter.fsRmdir('/workspace', '', { runtimeRef: 'sess1' });
    } catch (e) {
        err = e;
    }
    assert.ok(err, 'should throw');
    assert.strictEqual(err.statusCode, 400);
});

// ─── 3.A.5: safeRel P0 security (regression) ───

test('BoxLite safeRel returns dot for .. traversal', () => {
    const { safeRel } = require('./BoxLiteFsAdapter');
    assert.strictEqual(safeRel('../etc/passwd'), '.');
    assert.strictEqual(safeRel('..'), '.');
});
