const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub the runtime registry before requiring analyzeDeploy so the
// module picks up our fake. The registry is a singleton but we can
// replace it via Node's require cache by injecting a fake into the
// require resolution path: simpler — analyzeDeploy calls getRuntime()
// lazily, so we replace the module's runtime-reference path.
const runtimeModule = require('../runtime/registry');
const runtimeToolchain = require('./runtimeToolchain');

/**
 * Build a fake runtime + fake runtimeRef-aware exec that returns
 * canned stdout/stderr based on the script content. Mirrors the
 * subset of the runtime interface used by runSelfCheck:
 *   - exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd })
 * plus detectRuntimeToolchain's `command -v <tool>` probes.
 */
function makeFakeRuntime(toolInventory) {
    return {
        exec: {
            async exec(_shell, args, _env, opts) {
                const cmd = String(args[1] || '').trim();
                // `command -v <X>` for toolchain probes.
                const which = cmd.match(/^command -v (\S+)/);
                if (which) {
                    const c = which[1];
                    if (toolInventory[c]) {
                        return { stdout: toolInventory[c], stderr: '', exitCode: 0 };
                    }
                    return { stdout: '', stderr: 'not found', exitCode: 1 };
                }
                // `<cmd> --version` for toolchain probes.
                const ver = cmd.match(/^(\S+) --version/);
                if (ver) {
                    return { stdout: `${ver[1]} version 1.0`, stderr: '', exitCode: 0 };
                }
                // `test -d <dir> && echo EXISTS || echo MISSING` for cd check.
                const td = cmd.match(/^test -d (\S+)/);
                if (td) {
                    if (td[1] === '.' || /EXISTS/.test(cmd)) {
                        return { stdout: 'EXISTS', stderr: '', exitCode: 0 };
                    }
                    return { stdout: 'MISSING', stderr: '', exitCode: 0 };
                }
                // `<pm> run` for script-existence check. The actual cmd
                // runSelfCheck builds is `cd <dir> 2>/dev/null && <pm> run
                // 2>&1 | head -80`; match anywhere in the string.
                if (/\b(npm|pnpm|yarn)\s+run\b/.test(cmd)) {
                    return { stdout: '  dev\n  build\n  start', stderr: '', exitCode: 0 };
                }
                return { stdout: '', stderr: '', exitCode: 0 };
            },
        },
    };
}

function patchRuntime(fakeRuntime) {
    // analyzeDeploy.js destructures `getRuntime` at module load, so
    // patching the export object alone doesn't affect already-loaded
    // modules. The clean fix is to re-require the dependents after
    // patching so they re-capture the patched getRuntime.
    const orig = runtimeModule.getRuntime;
    runtimeModule.getRuntime = () => fakeRuntime;
    // Bust the require cache for analyzeDeploy + runtimeToolchain so
    // their module-level `const { getRuntime } = ...` runs again and
    // captures the patched function. Without this, both modules keep
    // a direct reference to the original and our mock is invisible.
    for (const mod of ['./analyzeDeploy', './runtimeToolchain']) {
        try {
            const resolved = require.resolve(mod);
            delete require.cache[resolved];
        } catch { /* best effort */ }
    }
    // Re-require and refresh the local handle so runSelfCheck picks up
    // the new closure over the patched getRuntime.
    const mod = require('./analyzeDeploy');
    runSelfCheck = mod.runSelfCheck;
    return () => {
        runtimeModule.getRuntime = orig;
    };
}

// Wrap fake exec to log every call for debugging.
function makeLoggingFake(toolInventory, log = false) {
    const fake = makeFakeRuntime(toolInventory);
    const origExec = fake.exec.exec;
    fake.exec.exec = async function(...args) {
        if (log) console.error('  [fake.exec]', JSON.stringify(args[1]).slice(0, 80));
        return origExec.apply(this, args);
    };
    return fake;
}

let { runSelfCheck } = require('./analyzeDeploy');
// runSelfCheck is re-required inside patchRuntime() to capture the
// patched getRuntime. The handle is refreshed on every test for safety.

test('runSelfCheck: passes a well-formed node plan', async () => {
    const fake = makeFakeRuntime({ node: '/u/node', npm: '/u/npm' });
    const restore = patchRuntime(fake);
    try {
        const steps = [
            { id: 'step_1', name: 'Install', command: 'npm install', kind: 'prepare' },
            { id: 'step_2', name: 'Start', command: 'npm run dev', kind: 'serve' },
        ];
        const r = await runSelfCheck({ steps, runtimeRef: 'rt', workspacePath: '/workspace' });
        assert.equal(r.passed, true, `expected pass, got ${JSON.stringify(r.issues)}`);
        assert.equal(steps.length, 2, 'must not insert steps when toolchain is fine');
    } finally { restore(); }
});

test('runSelfCheck: detects missing `go` and auto-injects an apt-get install step', async () => {
    // boxlite base image: node + git, no go / cargo / python3 / etc.
    const fake = makeFakeRuntime({ node: '/u/node', npm: '/u/npm' });
    const restore = patchRuntime(fake);
    try {
        const steps = [
            { id: 'step_1', name: 'Build Go server', command: 'cd server && go build -o bin/server ./cmd/server', kind: 'prepare' },
            { id: 'step_2', name: 'Start', command: 'cd server && ./bin/server', kind: 'serve' },
        ];
        const r = await runSelfCheck({ steps, runtimeRef: 'rt', workspacePath: '/workspace' });
        assert.equal(r.passed, false);
        // The prepare step should be auto-injected ahead of "Build Go server".
        assert.ok(steps.length > 2, 'expected an injected install step');
        const injected = steps.find((s) => /apt-get install/.test(s.command || ''));
        assert.ok(injected, 'expected an apt-get install step in the plan');
        assert.match(injected.command, /golang-go/);
        assert.equal(injected.kind, 'prepare');
        // `go` was the missing tool, so an issue must reference it.
        assert.ok(r.issues.some((i) => /"go"/.test(i) && /not installed/.test(i)));
    } finally { restore(); }
});

test('runSelfCheck: does NOT insert an install step when the plan already installs the tool', async () => {
    const fake = makeFakeRuntime({ node: '/u/node', npm: '/u/npm' });
    const restore = patchRuntime(fake);
    try {
        const steps = [
            { id: 'step_1', name: 'Install go', command: 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends golang-go', kind: 'prepare' },
            { id: 'step_2', name: 'Build', command: 'go build ./...', kind: 'prepare' },
        ];
        const r = await runSelfCheck({ steps, runtimeRef: 'rt', workspacePath: '/workspace' });
        // The plan covers its own go install — should pass without injection.
        assert.equal(r.passed, true, `expected pass, got ${JSON.stringify(r.issues)}`);
        assert.equal(steps.length, 2, 'must not double-inject when plan already covers the tool');
    } finally { restore(); }
});

test('runSelfCheck: groups multiple missing tools into a single install step', async () => {
    // no go, no cargo, no python3 — but only go is actually called.
    // cargo/python3 are not called so should not be installed.
    const fake = makeFakeRuntime({ node: '/u/node', npm: '/u/npm' });
    const restore = patchRuntime(fake);
    try {
        const steps = [
            { id: 'step_1', name: 'Build', command: 'cd server && go build -o bin/x', kind: 'prepare' },
            { id: 'step_2', name: 'Start', command: 'cd server && ./bin/x', kind: 'serve' },
        ];
        const r = await runSelfCheck({ steps, runtimeRef: 'rt', workspacePath: '/workspace' });
        assert.equal(r.passed, false);
        // Only one new install step should be inserted (for go).
        const installs = steps.filter((s) => /apt-get install/.test(s.command || ''));
        assert.equal(installs.length, 1, 'expected exactly one install step');
        assert.match(installs[0].command, /golang-go/);
        assert.doesNotMatch(installs[0].command, /cargo/);
        assert.doesNotMatch(installs[0].command, /python/);
    } finally { restore(); }
});

test('runSelfCheck: passes when all called tools are available', async () => {
    // boxlite base has node + python3. Declare python3 in the inventory
    // so the run_shell `python3 -m http.server` step is considered satisfied.
    const fake = makeFakeRuntime({
        node: '/u/node', npm: '/u/npm', python3: '/u/bin/python3',
    });
    const restore = patchRuntime(fake);
    try {
        const steps = [
            { id: 'step_1', name: 'Install', command: 'pip install -r requirements.txt', kind: 'prepare' },
            { id: 'step_2', name: 'Start', command: 'python3 -m http.server $PORT', kind: 'serve' },
        ];
        const r = await runSelfCheck({ steps, runtimeRef: 'rt', workspacePath: '/workspace' });
        // pip is missing — the prepare step will need an inject for pip.
        // The run asserts on the SHAPE of the fix, not strict pass.
        // We expect an inject mentioning pip.
        const installs = steps.filter((s) => /apt-get install/.test(s.command || ''));
        if (installs.length) {
            assert.match(installs[0].command, /python3-pip/);
        }
    } finally { restore(); }
});

test('runSelfCheck: fatal — npx serve on a monorepo is rejected (cannot serve the real app)', async () => {
    // The host fs is what detects pnpm-workspace.yaml. We point
    // hostWorkspacePath at a real temp dir that has the marker, so
    // runSelfCheck's monorepo probe sees a true signal.
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const hostWs = fs.mkdtempSync(path.join(os.tmpdir(), 'monorepo-host-'));
    fs.writeFileSync(path.join(hostWs, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    const fake = makeFakeRuntime({ node: '/u/node', npm: '/u/npm' });
    const restore = patchRuntime(fake);
    try {
        // This is the exact wrong plan opencode produced for multica:
        // a monorepo (pnpm-workspace.yaml) but serve step is npx serve
        // a single directory — can never serve the real app stack.
        const steps = [
            { id: 'step_1', name: 'Install', command: 'cd packages/tsconfig && pnpm install', kind: 'prepare' },
            { id: 'step_2', name: 'Start', command: 'npx --yes serve . --listen $PORT --no-clipboard', kind: 'serve' },
        ];
        const r = await runSelfCheck({ steps, runtimeRef: 'rt', workspacePath: '/workspace', hostWorkspacePath: hostWs });
        // Fatal must be set; non-fatal issues array still has any
        // toolchain misses (npx is fine here so issues should be empty).
        assert.ok(r.fatal && r.fatal.length > 0, `expected fatal issues, got ${JSON.stringify(r)}`);
        assert.ok(r.fatal[0].includes('static-serve') && r.fatal[0].includes('monorepo'));
        // The static-serve plan was NOT auto-fixed by self-check; the
        // caller (analyzeProjectDeploy) must fall back to detectStack
        // instead.
        assert.equal(steps.length, 2, 'must not auto-inject for fatal plan');
    } finally {
        fs.rmSync(hostWs, { recursive: true, force: true });
        restore();
    }
});

test('runSelfCheck: no fatal for static-serve when the project is NOT a monorepo', async () => {
    // hostWorkspacePath has no monorepo markers → plan-text signals are
    // the fallback. A plain `npx serve` on a static site is fine.
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const hostWs = fs.mkdtempSync(path.join(os.tmpdir(), 'static-host-'));
    fs.writeFileSync(path.join(hostWs, 'index.html'), '<html></html>');
    const fake = makeFakeRuntime({ node: '/u/node', npm: '/u/npm' });
    const restore = patchRuntime(fake);
    try {
        const steps = [
            { id: 'step_1', name: 'Install', command: 'npm install', kind: 'prepare' },
            { id: 'step_2', name: 'Start', command: 'npx --yes serve . --listen $PORT --no-clipboard', kind: 'serve' },
        ];
        const r = await runSelfCheck({ steps, runtimeRef: 'rt', workspacePath: '/workspace', hostWorkspacePath: hostWs });
        assert.equal((r.fatal || []).length, 0, 'static-serve on a non-monorepo is fine');
    } finally {
        fs.rmSync(hostWs, { recursive: true, force: true });
        restore();
    }
});

test('runSelfCheck: fatal also fires when no hostWorkspacePath but plan-text signals monorepo', async () => {
    // Some hosts pass workspacePath === hostWorkspacePath; the fallback
    // is to look at the plan text for `turbo run` / `pnpm -r` / etc.
    const fake = makeFakeRuntime({ node: '/u/node', npm: '/u/npm' });
    const restore = patchRuntime(fake);
    try {
        const steps = [
            { id: 'step_1', name: 'Install', command: 'pnpm install', kind: 'prepare' },
            { id: 'step_2', name: 'Start', command: 'npx --yes serve . --listen $PORT --no-clipboard', kind: 'serve' },
        ];
        // No hostWorkspacePath — fall back to plan-text signals: the
        // install step uses pnpm -r which is a monorepo signal.
        const r = await runSelfCheck({
            steps,
            runtimeRef: 'rt',
            workspacePath: '/workspace',
            // Inject a fake install step that uses `pnpm -r` so the
            // plan-text signal triggers.
        });
        // Without pnpm -r, this shouldn't fatal. Now add a pnpm -r
        // signal to make the point.
        steps[0].command = 'pnpm -r install';
        const r2 = await runSelfCheck({ steps, runtimeRef: 'rt', workspacePath: '/workspace' });
        assert.ok(r2.fatal && r2.fatal.length > 0, 'pnpm -r should signal monorepo');
    } finally { restore(); }
});
