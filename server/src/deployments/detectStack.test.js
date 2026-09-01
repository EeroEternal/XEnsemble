const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectStack, stackToPreviewContract, _internal } = require('./detectStack');

function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-stack-'));
    try {
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function writeFile(dir, name, content) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

test('detectStack: empty workspace returns unknown fallback', () => {
    withTempDir((dir) => {
        const stack = detectStack(dir);
        assert.equal(stack.type, 'unknown');
        assert.equal(stack.startCmd, null);
        assert.equal(stack.defaultPort, 3000);
    });
});

test('detectStack: null/undefined path returns unknown', () => {
    assert.equal(detectStack(null).type, 'unknown');
    assert.equal(detectStack(undefined).type, 'unknown');
    assert.equal(detectStack('').type, 'unknown');
});

test('detectStack: monorepo (pnpm-workspace.yaml) is detected over package.json', () => {
    withTempDir((dir) => {
        writeFile(dir, 'pnpm-workspace.yaml', 'packages:\n  - "web/*"\n  - "server/*"\n');
        writeFile(dir, 'package.json', JSON.stringify({
            name: 'root',
            scripts: { 'dev:web': 'cd web && pnpm dev', 'dev:server': 'cd server && pnpm dev' },
        }));
        writeFile(dir, 'pnpm-lock.yaml', '');
        const stack = detectStack(dir);
        assert.equal(stack.type, 'monorepo');
        assert.equal(stack.packageManager, 'pnpm');
        assert.deepEqual(stack.monorepoApps, ['web', 'server']);
    });
});

test('detectStack: monorepo (turbo.json) is detected', () => {
    withTempDir((dir) => {
        writeFile(dir, 'turbo.json', JSON.stringify({ pipeline: { build: {}, dev: {} } }));
        writeFile(dir, 'package.json', JSON.stringify({ name: 'monorepo', scripts: { dev: 'turbo run dev' } }));
        const stack = detectStack(dir);
        assert.equal(stack.type, 'monorepo');
    });
});

test('detectStack: node + vite framework, port 5173', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({
            name: 'app',
            scripts: { dev: 'vite', build: 'vite build' },
            dependencies: { vite: '^5.0.0' },
        }));
        const stack = detectStack(dir);
        assert.equal(stack.type, 'node-vite');
        assert.equal(stack.framework, 'vite');
        assert.equal(stack.defaultPort, 5173);
        assert.equal(stack.startCmd, 'npm run dev');
    });
});

test('detectStack: node + next framework, port 3000', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({
            name: 'app',
            scripts: { dev: 'next dev', build: 'next build' },
            dependencies: { next: '^14.0.0' },
        }));
        const stack = detectStack(dir);
        assert.equal(stack.type, 'node-next');
        assert.equal(stack.framework, 'next');
        assert.equal(stack.defaultPort, 3000);
        assert.equal(stack.startCmd, 'npm run dev');
    });
});

test('detectStack: node + next with custom port from .env wins', () => {
    withTempDir((dir) => {
        writeFile(dir, '.env', 'PORT=4321\n');
        writeFile(dir, 'package.json', JSON.stringify({
            scripts: { dev: 'next dev' },
            dependencies: { next: '^14.0.0' },
        }));
        const stack = detectStack(dir);
        assert.equal(stack.defaultPort, 4321);
    });
});

test('detectStack: node + next with custom port from next.config.js', () => {
    withTempDir((dir) => {
        writeFile(dir, 'next.config.js', 'module.exports = { port: 4567 };\n');
        writeFile(dir, 'package.json', JSON.stringify({
            scripts: { dev: 'next dev' },
            dependencies: { next: '^14.0.0' },
        }));
        const stack = detectStack(dir);
        assert.equal(stack.defaultPort, 4567);
    });
});

test('detectStack: node + vite with custom port from vite.config.ts', () => {
    withTempDir((dir) => {
        writeFile(dir, 'vite.config.ts', 'export default { server: { port: 8888 } };\n');
        writeFile(dir, 'package.json', JSON.stringify({
            scripts: { dev: 'vite' },
            dependencies: { vite: '^5.0.0' },
        }));
        const stack = detectStack(dir);
        assert.equal(stack.defaultPort, 8888);
    });
});

test('detectStack: node + nuxt', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({
            scripts: { dev: 'nuxt dev' },
            dependencies: { nuxt: '^3.0.0' },
        }));
        const stack = detectStack(dir);
        assert.equal(stack.type, 'node-nuxt');
        assert.equal(stack.framework, 'nuxt');
        assert.equal(stack.defaultPort, 3000);
    });
});

test('detectStack: node + sveltekit', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({
            scripts: { dev: 'vite dev' },
            dependencies: { '@sveltejs/kit': '^2.0.0' },
        }));
        const stack = detectStack(dir);
        assert.equal(stack.type, 'node-sveltekit');
        assert.equal(stack.framework, 'sveltekit');
        assert.equal(stack.defaultPort, 5173);
    });
});

test('detectStack: node + express (no dev script) falls back to start', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({
            scripts: { start: 'node server.js' },
            dependencies: { express: '^4.0.0' },
        }));
        const stack = detectStack(dir);
        assert.equal(stack.type, 'node-express');
        assert.equal(stack.startCmd, 'npm run start');
    });
});

test('detectStack: pnpm package manager from pnpm-lock.yaml', () => {
    withTempDir((dir) => {
        writeFile(dir, 'pnpm-lock.yaml', '');
        writeFile(dir, 'package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
        const stack = detectStack(dir);
        assert.equal(stack.packageManager, 'pnpm');
        assert.match(stack.installCmd, /^pnpm install/);
        assert.match(stack.startCmd, /^pnpm run dev/);
    });
});

test('detectStack: yarn package manager from yarn.lock', () => {
    withTempDir((dir) => {
        writeFile(dir, 'yarn.lock', '');
        writeFile(dir, 'package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
        const stack = detectStack(dir);
        assert.equal(stack.packageManager, 'yarn');
        assert.match(stack.startCmd, /^yarn run dev/);
    });
});

test('detectStack: bun package manager from bun.lockb', () => {
    withTempDir((dir) => {
        writeFile(dir, 'bun.lockb', '');
        writeFile(dir, 'package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
        const stack = detectStack(dir);
        assert.equal(stack.packageManager, 'bun');
        assert.match(stack.startCmd, /^bun run dev/);
    });
});

test('detectStack: python (requirements.txt)', () => {
    withTempDir((dir) => {
        writeFile(dir, 'requirements.txt', 'flask==3.0.0\n');
        const stack = detectStack(dir);
        assert.equal(stack.type, 'python');
        assert.equal(stack.defaultPort, 8000);
        assert.equal(stack.installCmd, 'pip install -r requirements.txt');
        assert.equal(stack.startCmd, 'python3 -m http.server $PORT --bind 0.0.0.0');
    });
});

test('detectStack: python (pyproject.toml)', () => {
    withTempDir((dir) => {
        writeFile(dir, 'pyproject.toml', '[project]\nname = "x"\n');
        const stack = detectStack(dir);
        assert.equal(stack.type, 'python');
        assert.equal(stack.installCmd, 'pip install -e .');
    });
});

test('detectStack: go (go.mod)', () => {
    withTempDir((dir) => {
        writeFile(dir, 'go.mod', 'module x\n\ngo 1.22\n');
        const stack = detectStack(dir);
        assert.equal(stack.type, 'go');
        assert.equal(stack.defaultPort, 8080);
        assert.equal(stack.installCmd, 'go mod download');
        assert.equal(stack.buildCmd, 'go build ./...');
        assert.equal(stack.startCmd, 'go run .');
    });
});

test('detectStack: rust (Cargo.toml)', () => {
    withTempDir((dir) => {
        writeFile(dir, 'Cargo.toml', '[package]\nname = "x"\n');
        const stack = detectStack(dir);
        assert.equal(stack.type, 'rust');
        assert.equal(stack.startCmd, 'cargo run --release');
    });
});

test('detectStack: static (index.html only)', () => {
    withTempDir((dir) => {
        writeFile(dir, 'index.html', '<!DOCTYPE html><html></html>');
        const stack = detectStack(dir);
        assert.equal(stack.type, 'static');
        assert.equal(stack.startCmd, 'python3 -m http.server $PORT --bind 0.0.0.0');
    });
});

test('detectStack: unknown when nothing matches', () => {
    withTempDir((dir) => {
        writeFile(dir, 'README.md', 'hi');
        const stack = detectStack(dir);
        assert.equal(stack.type, 'unknown');
    });
});

test('stackToPreviewContract: monorepo with start command splits correctly', () => {
    withTempDir((dir) => {
        writeFile(dir, 'pnpm-workspace.yaml', 'packages:\n  - "web"\n');
        writeFile(dir, 'pnpm-lock.yaml', '');
        writeFile(dir, 'package.json', JSON.stringify({
            scripts: { 'dev:web': 'cd web && pnpm dev' },
        }));
        const stack = detectStack(dir);
        const contract = stackToPreviewContract(stack);
        assert.ok(contract);
        assert.equal(contract.command, 'pnpm');
        assert.deepEqual(contract.args, ['run', 'dev:web']);
    });
});

test('stackToPreviewContract: replaces $PORT with concrete port', () => {
    withTempDir((dir) => {
        writeFile(dir, 'requirements.txt', '');
        const stack = detectStack(dir);
        const contract = stackToPreviewContract(stack);
        assert.equal(contract.command, 'python3');
        // args are ['-m', 'http.server', '$PORT', '--bind', '0.0.0.0'];
        // the $PORT placeholder is replaced with the resolved port.
        assert.equal(contract.args[2], '8000');
        assert.equal(contract.port, 8000);
    });
});

test('stackToPreviewContract: falls back to npx serve when no start command', () => {
    const contract = stackToPreviewContract({
        type: 'unknown', startCmd: null, defaultPort: 3000, framework: null,
    });
    assert.equal(contract.command, 'npx');
    assert.equal(contract.type, 'fallback');
});

test('stackToPreviewContract: returns null on null input', () => {
    assert.equal(stackToPreviewContract(null), null);
});

test('internal: resolveStartScript prefers framework-specific script', () => {
    assert.equal(
        _internal.resolveStartScript({ dev: 'vite' }, 'vite'),
        'dev',
    );
    assert.equal(
        _internal.resolveStartScript({ start: 'node server.js' }, 'express'),
        'start',
    );
    // Express has no dev script: falls back to the first available.
    assert.equal(
        _internal.resolveStartScript({ start: 'node server.js' }, null),
        'start',
    );
    // No scripts at all.
    assert.equal(_internal.resolveStartScript({}, 'vite'), null);
});

test('internal: resolvePort falls back to framework default', () => {
    withTempDir((dir) => {
        assert.equal(_internal.resolvePort(dir, 'vite', 'node-vite'), 5173);
        assert.equal(_internal.resolvePort(dir, 'next', 'node-next'), 3000);
        assert.equal(_internal.resolvePort(dir, null, 'python'), 8000);
        assert.equal(_internal.resolvePort(dir, null, 'go'), 8080);
        assert.equal(_internal.resolvePort(dir, null, 'unknown'), 3000);
    });
});

test('internal: parsePortFromViteConfig handles both inline and block syntax', () => {
    withTempDir((dir) => {
        writeFile(dir, 'vite.config.ts', 'export default { server: { port: 4321 } };');
        assert.equal(_internal.parsePortFromViteConfig(dir), 4321);

        writeFile(dir, 'vite.config.ts', 'export default { port: 1234 };');
        assert.equal(_internal.parsePortFromViteConfig(dir), 1234);

        writeFile(dir, 'vite.config.ts', 'export default {};');
        assert.equal(_internal.parsePortFromViteConfig(dir), null);
    });
});
