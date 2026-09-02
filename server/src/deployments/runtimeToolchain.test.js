const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    detectRuntimeToolchain,
    probeOne,
    groupByLanguage,
    renderToolchainBlock,
    aptInstall,
    TRACKED_TOOLS,
} = require('./runtimeToolchain');

/**
 * Build a fake runtime that responds to `command -v <cmd>` and
 * `<cmd> --version` based on a fixture. Used by every test in this file
 * to keep boxlite exec out of the test environment.
 */
function makeFakeRuntime(fixture) {
    // fixture is a { <cmd>: { path, version, available? } } map.
    return {
        exec: {
            async exec(_shell, args /* [ '-c', cmd ] */) {
                const cmd = String(args[1] || '').trim();
                // `command -v <X>` returns the path or stdout-empty.
                const m = cmd.match(/^command -v (\S+)/);
                if (m) {
                    const c = m[1];
                    const e = fixture[c];
                    if (e && e.available !== false) {
                        return { stdout: e.path || c, stderr: '', exitCode: 0 };
                    }
                    return { stdout: '', stderr: 'not found', exitCode: 1 };
                }
                // `<cmd> --version` returns version.
                const m2 = cmd.match(/^(\S+) --version/);
                if (m2) {
                    const c = m2[1];
                    const e = fixture[c];
                    if (e && e.version) {
                        return { stdout: e.version, stderr: '', exitCode: 0 };
                    }
                    return { stdout: '', stderr: 'unknown flag', exitCode: 2 };
                }
                // Fallback: echo the command for visibility.
                return { stdout: cmd, stderr: '', exitCode: 0 };
            },
        },
    };
}

test('probeOne: marks a tool as available when command -v finds it and --version returns', async () => {
    const rt = makeFakeRuntime({
        go: { path: '/usr/local/go/bin/go', version: 'go1.22.3' },
    });
    const info = await probeOne(rt, null, '/workspace', 'go');
    assert.equal(info.command, 'go');
    assert.equal(info.available, true);
    assert.equal(info.path, '/usr/local/go/bin/go');
    // Version prefix "go version" is stripped; only "go1.22.3" remains.
    assert.equal(info.version, 'go1.22.3');
});

test('probeOne: marks a tool as unavailable when command -v is empty', async () => {
    const rt = makeFakeRuntime({}); // no go
    const info = await probeOne(rt, null, '/workspace', 'go');
    assert.equal(info.available, false);
    assert.equal(info.version, null);
    assert.equal(info.path, null);
});

test('probeOne: treats tool as available even when --version errors', async () => {
    // Some broken installs run but reject --version. The fact that
    // `command -v` resolved is enough.
    const rt = makeFakeRuntime({
        cargo: { path: '/usr/bin/cargo', version: null },
    });
    const info = await probeOne(rt, null, '/workspace', 'cargo');
    assert.equal(info.available, true);
    assert.equal(info.path, '/usr/bin/cargo');
    assert.equal(info.version, null);
});

test('probeOne: never throws on exec failure (returns unavailable)', async () => {
    const rt = {
        exec: {
            async exec() {
                throw new Error('exec unavailable');
            },
        },
    };
    const info = await probeOne(rt, null, '/workspace', 'go');
    assert.equal(info.available, false);
});

test('detectRuntimeToolchain: returns one entry per tracked tool', async () => {
    const rt = makeFakeRuntime({});
    const inv = await detectRuntimeToolchain(rt);
    assert.equal(inv.length, TRACKED_TOOLS.length);
    assert.ok(inv.every((i) => typeof i.command === 'string'));
});

test('detectRuntimeToolchain: aggregates available + missing correctly', async () => {
    const rt = makeFakeRuntime({
        node: { path: '/usr/bin/node', version: 'v22.17.0' },
        npm: { path: '/usr/bin/npm', version: '10.9.0' },
        pnpm: { path: '/root/.local/bin/pnpm', version: '10.28.2' },
        go: { path: '/usr/local/go/bin/go', version: 'go1.22.3' },
        // go: false NOT in fixture = not available
    });
    const inv = await detectRuntimeToolchain(rt);
    const byCmd = Object.fromEntries(inv.map((i) => [i.command, i]));
    assert.equal(byCmd.node.available, true);
    assert.equal(byCmd.npm.available, true);
    assert.equal(byCmd.pnpm.available, true);
    assert.equal(byCmd.go.available, true);
    assert.equal(byCmd.python3.available, false);
    assert.equal(byCmd.cargo.available, false);
    assert.equal(byCmd.java.available, false);
});

test('detectRuntimeToolchain: returns all-unavailable when runtime is missing', async () => {
    const inv = await detectRuntimeToolchain({ exec: {} });
    assert.ok(inv.every((i) => i.available === false));
});

test('groupByLanguage: splits available vs missing per language', () => {
    // Pass a full inventory so every TRACKED_TOOL is accounted for.
    const inv = TRACKED_TOOLS.map((t) => {
        if (t.cmd === 'node' || t.cmd === 'go') {
            return { command: t.cmd, available: true, version: 'v1', path: '/u/' + t.cmd };
        }
        if (t.cmd === 'cargo') {
            return { command: t.cmd, available: false, version: null, path: null };
        }
        return { command: t.cmd, available: false, version: null, path: null };
    });
    const g = groupByLanguage(inv);
    assert.deepEqual(g.node.available, ['node (v1)']);
    // Other node tools in TRACKED_TOOLS all default to missing.
    assert.ok(g.node.missing.includes('pnpm'));
    assert.ok(g.node.missing.includes('npm'));
    assert.ok(g.node.missing.includes('yarn'));
    // `go` is available; cargo lives under the `rust` language family, not `go`.
    assert.deepEqual(g.go.available, ['go (v1)']);
    // `cargo` (rust) is missing.
    assert.deepEqual(g.rust.missing, ['cargo', 'rustc']);
    // Every language family in TRACKED_TOOLS should have a group.
    assert.ok(g.python); // python3/pip/pip3 default to missing here
    assert.ok(g.native); // make/gcc/python default to missing
});

test('renderToolchainBlock: shows both available and missing tools', () => {
    const inv = [
        { command: 'node', available: true, version: 'v22', path: '/u/n' },
        { command: 'go', available: false, version: null, path: null },
        { command: 'cargo', available: false, version: null, path: null },
    ];
    const block = renderToolchainBlock(inv);
    assert.match(block, /SANDBOX TOOLCHAIN/);
    assert.match(block, /available\s*=\s*node \(v22\)/);
    assert.match(block, /missing\s*=\s*go/);
    assert.match(block, /missing\s*=\s*cargo/);
    // Must tell the LLM how to install missing tools.
    assert.match(block, /apt-get install/);
    // Common package names should be mentioned.
    assert.match(block, /golang-go/);
    assert.match(block, /cargo/);
});

test('renderToolchainBlock: warns against wasting rounds on missing-tool probes', () => {
    const block = renderToolchainBlock([]);
    assert.match(block, /NEVER spend rounds trying to/);
});

test('aptInstall: rejects empty package list', async () => {
    await assert.rejects(
        () => aptInstall({}, []),
        /non-empty package list/,
    );
});

test('aptInstall: invokes apt-get update + install with the given packages', async () => {
    const calls = [];
    const rt = {
        exec: {
            async exec(_s, args, _env, opts) {
                calls.push({ cmd: args[1], timeout: opts.timeoutMs });
                return { stdout: 'ok', stderr: '', exitCode: 0 };
            },
        },
    };
    await aptInstall(rt, ['golang-go', 'build-essential']);
    assert.equal(calls.length, 1);
    assert.match(calls[0].cmd, /apt-get update -qq/);
    assert.match(calls[0].cmd, /apt-get install -y/);
    assert.match(calls[0].cmd, /golang-go/);
    assert.match(calls[0].cmd, /build-essential/);
    // Must use the long-form timeout (default 600s) — go/cargo installs
    // are slow on first boot.
    assert.equal(calls[0].timeout, 600000);
});

test('aptInstall: sanitizes package names to prevent shell injection', async () => {
    let captured = '';
    const rt = {
        exec: {
            async exec(_s, args) {
                captured = args[1];
                return { stdout: '', stderr: '', exitCode: 0 };
            },
        },
    };
    await aptInstall(rt, ['go; rm -rf /', 'safe-pkg', '../../../etc/passwd']);
    // `;` and `/` are stripped from package names (only alnum + + . _ - allowed).
    // 'go; rm -rf /' → 'gorm-rf' (no spaces, no slashes)
    assert.match(captured, /\bgorm-rf\b/);
    assert.match(captured, /\bsafe-pkg\b/);
    // No path-traversal chars survive in the package list.
    assert.doesNotMatch(captured, /\.\.\//);
    // No ';' inside the sanitized package list (the ';' in `set -e;` is
    // the trusted prefix, not user input).
    const pkgList = captured.split('--no-install-recommends ')[1] || '';
    assert.doesNotMatch(pkgList, /;/);
    assert.doesNotMatch(pkgList, /etc\/passwd/);
});
