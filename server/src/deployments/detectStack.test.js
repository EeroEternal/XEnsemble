// Tests for detectStack.js — the heuristic-only project stack detector.
//
// Covers:
// - Existing detectors: monorepo (pnpm-workspace / turbo / directory-based), node variants,
//   python (django/fastapi/flask), go, rust, static, stackToPreviewContract, internal helpers.
//   (Original tests from `ea1c659 refactor(deploy): 拆出 detectStack.js`.)
// - NEW detectors: java (Spring Boot / generic maven / gradle), ruby (rails/sinatra/rack),
//   php (laravel/symfony/slim), elixir (phoenix / generic), static generators
//   (hugo / jekyll / mkdocs / docusaurus / 11ty).
// - Improved detection: monorepo now catches directory-based monorepos (no pnpm-workspace.yaml);
//   go prefers Makefile `run:` target or single cmd/<name>/main.go; rust prefers [[bin]] name;
//   python detects fastapi/flask entry files.
// - validatePlanAgainstProject: structural validation, replacing the regex-based fatal
//   checks. xensemble scenario (hallucinated static-serve plan with detected monorepo
//   startCmd) must be caught.
// - normalizeCmdForCompare: the unified compare used to decide whether LLM's plan
//   actually uses detected.startCmd.
//
// All tests use Node's node:test + assert/strict. No DB or runtime needed —
// detectStack is pure file-read heuristics that takes a directory path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    detectStack,
    detectBackendSignature,
    detectSystemDeps,
    detectStartCandidates,
    validatePlanAgainstProject,
    _internal: {
        parsePortFromViteConfig,
        parsePortFromNextConfig,
        parsePortFromEnv,
        resolvePort,
        resolveStartScript,
        detectNodeFramework,
        detectMonorepoApps,
        detectPackageManager,
        resolveMonorepoStartScript,
        hasIndependentSubProjects,
        resolveGoStartCmd,
        resolveRustStartCmd,
        resolveJavaStartCmd,
        normalizeCmdForCompare,
    },
} = require('./detectStack');

const stackToPreviewContract = require('./detectStack').stackToPreviewContract;
// Original tests use `_internal.<helper>()`; expose it as a top-level binding
// for backward compatibility (new tests destructure specific helpers).
const _internal = require('./detectStack')._internal;

// ─── Helpers ───

function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-stack-'));
    try {
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function writeFile(dir, name, content) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
}

function makeProject(layout) {
    // layout: { 'path/to/file': 'contents', 'dir/file': '' }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detectstack-test-'));
    for (const [rel, content] of Object.entries(layout)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (content !== null && content !== undefined) {
            fs.writeFileSync(full, content);
        }
    }
    return dir;
}

function rm(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── Existing tests (regression coverage for the original detectStack contract) ───

test('detectStack: empty workspace returns unknown fallback', () => {
    withTempDir((dir) => {
        const s = detectStack(dir);
        assert.equal(s.type, 'unknown');
        assert.deepEqual(s.confidence, ['fallback']);
    });
});

test('detectStack: null/undefined path returns unknown', () => {
    assert.equal(detectStack(null).type, 'unknown');
    assert.equal(detectStack(undefined).type, 'unknown');
});

test('detectStack: monorepo (pnpm-workspace.yaml) is detected over package.json', () => {
    withTempDir((dir) => {
        writeFile(dir, 'pnpm-workspace.yaml', 'packages:\n  - "web/*"\n  - "server/*"\n');
        // Root package.json (required for detectNodeStack to find a dev/start script).
        writeFile(dir, 'package.json', JSON.stringify({ scripts: { dev: 'concurrently "npm:dev:web" "npm:dev:server"' } }));
        writeFile(dir, 'web/vite/package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
        writeFile(dir, 'server/express/package.json', JSON.stringify({ dependencies: { express: '^4' } }));
        // pnpm-lock.yaml forces packageManager='pnpm' (otherwise falls back to 'npm')
        writeFile(dir, 'pnpm-lock.yaml', '');
        const s = detectStack(dir);
        assert.equal(s.type, 'monorepo');
        // 生产语义（2026-09）：dev script 不再进 startCmd（dev 是开发形态，live 模式由
        // devKind 承担）——fixture 子包没有 start/serve → startCmd=null。
        assert.equal(s.startCmd, null);
        // detectMonorepoApps returns actual directory names from pnpm-workspace.yaml globs
        assert.deepEqual(s.monorepoApps, ['web', 'server']);
    });
});

test('detectStack: monorepo (turbo.json) is detected', () => {
    withTempDir((dir) => {
        writeFile(dir, 'turbo.json', JSON.stringify({ workspaces: ['apps/*'] }));
        // Root package.json (required for detectNodeStack to find a dev/start script).
        writeFile(dir, 'package.json', JSON.stringify({ scripts: { dev: 'turbo run dev' } }));
        writeFile(dir, 'apps/web/package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
        // pnpm-lock.yaml forces packageManager='pnpm' (otherwise falls back to 'npm')
        writeFile(dir, 'pnpm-lock.yaml', '');
        const s = detectStack(dir);
        assert.equal(s.type, 'monorepo');
        assert.equal(s.startCmd, null); // dev-only fixture：dev 不进 startCmd（生产语义）
    });
});

test('detectStack: node + vite framework, port 5173', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { vite: '^5' } }));
        const s = detectStack(dir);
        assert.equal(s.type, 'node-vite');
        assert.equal(s.defaultPort, 5173);
    });
});

test('detectStack: node + next framework, port 3000', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { next: '^14' } }));
        const s = detectStack(dir);
        assert.equal(s.type, 'node-next');
        assert.equal(s.defaultPort, 3000);
    });
});

test('detectStack: node + next with custom port from .env wins', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { next: '^14' } }));
        writeFile(dir, '.env', 'PORT=8080\n');
        const s = detectStack(dir);
        assert.equal(s.defaultPort, 8080);
    });
});

test('detectStack: node + next with custom port from next.config.js', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { next: '^14' } }));
        writeFile(dir, 'next.config.js', 'module.exports = { port: 4000 };\n');
        const s = detectStack(dir);
        assert.equal(s.defaultPort, 4000);
    });
});

test('detectStack: node + vite with custom port from vite.config.ts', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { vite: '^5' } }));
        writeFile(dir, 'vite.config.ts', 'export default { server: { port: 4321 } };\n');
        const s = detectStack(dir);
        assert.equal(s.defaultPort, 4321);
    });
});

test('detectStack: node + nuxt', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { nuxt: '^3' } }));
        const s = detectStack(dir);
        assert.equal(s.type, 'node-nuxt');
    });
});

test('detectStack: node + sveltekit', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { '@sveltejs/kit': '^2' } }));
        const s = detectStack(dir);
        assert.equal(s.type, 'node-sveltekit');
    });
});

test('detectStack: node + express (no dev script) falls back to start', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({
            dependencies: { express: '^4' },
            scripts: { start: 'node server.js' },
        }));
        const s = detectStack(dir);
        assert.equal(s.type, 'node-express');
        assert.equal(s.startCmd, 'npm run start');
    });
});

test('detectStack: pnpm package manager from pnpm-lock.yaml', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { express: '^4' } }));
        writeFile(dir, 'pnpm-lock.yaml', '');
        const s = detectStack(dir);
        assert.equal(s.packageManager, 'pnpm');
        assert.equal(s.installCmd, 'pnpm install --no-audit --no-fund');
    });
});

test('detectStack: yarn package manager from yarn.lock', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { express: '^4' } }));
        writeFile(dir, 'yarn.lock', '');
        const s = detectStack(dir);
        assert.equal(s.packageManager, 'yarn');
    });
});

test('detectStack: bun package manager from bun.lockb', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { express: '^4' } }));
        writeFile(dir, 'bun.lockb', '');
        const s = detectStack(dir);
        assert.equal(s.packageManager, 'bun');
    });
});

test('detectStack: python (requirements.txt)', () => {
    withTempDir((dir) => {
        writeFile(dir, 'requirements.txt', 'flask==3.0\n');
        writeFile(dir, 'app.py', 'from flask import Flask\napp = Flask(__name__)\n');
        const s = detectStack(dir);
        assert.equal(s.type, 'python');
    });
});

test('detectStack: python (pyproject.toml)', () => {
    withTempDir((dir) => {
        writeFile(dir, 'pyproject.toml', '[project]\nname = "demo"\n');
        const s = detectStack(dir);
        assert.equal(s.type, 'python');
    });
});

test('detectStack: go (go.mod)', () => {
    withTempDir((dir) => {
        writeFile(dir, 'go.mod', 'module example.com/x\n\ngo 1.22\n');
        writeFile(dir, 'main.go', 'package main\n');
        const s = detectStack(dir);
        assert.equal(s.type, 'go');
        assert.equal(s.startCmd, 'go run .');
    });
});

test('detectStack: rust (Cargo.toml)', () => {
    withTempDir((dir) => {
        writeFile(dir, 'Cargo.toml', '[package]\nname = "demo"\n');
        writeFile(dir, 'Cargo.lock', '');
        const s = detectStack(dir);
        assert.equal(s.type, 'rust');
    });
});

test('detectStack: static (index.html only)', () => {
    withTempDir((dir) => {
        writeFile(dir, 'index.html', '<h1>Hi</h1>');
        const s = detectStack(dir);
        assert.equal(s.type, 'static');
    });
});

test('detectStack: unknown when nothing matches', () => {
    withTempDir((dir) => {
        // no project files at all (no package.json, no index.html, etc.)
        const s = detectStack(dir);
        assert.equal(s.type, 'unknown');
    });
});

test('stackToPreviewContract: monorepo with start command splits correctly', () => {
    withTempDir((dir) => {
        writeFile(dir, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n');
        // Root package.json with a production `start` script → startCmd = `pnpm run start`.
        writeFile(dir, 'package.json', JSON.stringify({ scripts: { start: 'pnpm -r start' } }));
        writeFile(dir, 'pnpm-lock.yaml', '');
        writeFile(dir, 'apps/web/package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
        const s = detectStack(dir);
        const c = stackToPreviewContract(s);
        assert.equal(c.command, 'pnpm'); // packageManager = 'pnpm' due to pnpm-lock.yaml
        assert.ok(Array.isArray(c.args));
        assert.ok(c.args.includes('run'));
        assert.ok(c.args.includes('start'));
        assert.equal(c.port, 3000);
    });
});

test('stackToPreviewContract: replaces $PORT with concrete port', () => {
    const c = stackToPreviewContract({ startCmd: 'npm run dev --port $PORT --host 0.0.0.0', defaultPort: 3000 });
    assert.equal(c.command, 'npm');
    assert.equal(c.args[0], 'run');
    assert.equal(c.args[1], 'dev');
    assert.equal(c.args[2], '--port');
    assert.equal(c.args[3], '3000');
    assert.equal(c.args[4], '--host');
    assert.equal(c.args[5], '0.0.0.0');
    assert.equal(c.port, 3000);
});

test('stackToPreviewContract: falls back to npx serve when no start command', () => {
    const c = stackToPreviewContract({ startCmd: null, defaultPort: 8000 });
    assert.equal(c.command, 'npx');
    assert.ok(c.args.includes('serve'));
    assert.equal(c.port, 8000);
});

test('stackToPreviewContract: returns null on null input', () => {
    assert.equal(stackToPreviewContract(null), null);
});

test('internal: resolveStartScript prefers framework-specific script', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({
            dependencies: { vite: '^5' },
            scripts: { dev: 'vite', start: 'node server.js', preview: 'vite preview' },
        }));
        // For vite, FRAMEWORK_DEV_SCRIPTS.vite = 'dev'
        assert.equal(_internal.resolveStartScript({ dev: 'vite', start: 'node server.js' }, 'vite'), 'dev');
    });
});

test('internal: resolvePort falls back to framework default', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { vite: '^5' } }));
        assert.equal(_internal.resolvePort(dir, 'vite', 'node-vite'), 5173);
    });
});

test('internal: parsePortFromViteConfig handles both inline and block syntax', () => {
    withTempDir((dir) => {
        writeFile(dir, 'vite.config.ts', 'export default { port: 4444 };\n');
        assert.equal(_internal.parsePortFromViteConfig(dir), 4444);
    });
});

test('internal: parsePortFromNextConfig reads port from next.config.js', () => {
    withTempDir((dir) => {
        writeFile(dir, 'next.config.js', 'module.exports = { port: 5000 };\n');
        assert.equal(_internal.parsePortFromNextConfig(dir), 5000);
    });
});

test('internal: parsePortFromEnv reads PORT from .env', () => {
    withTempDir((dir) => {
        writeFile(dir, '.env', 'PORT=7000\n');
        assert.equal(_internal.parsePortFromEnv(dir), 7000);
    });
});

test('internal: parsePortFromEnv returns null when PORT not set', () => {
    withTempDir((dir) => {
        writeFile(dir, '.env', 'OTHER_VAR=foo\n');
        assert.equal(_internal.parsePortFromEnv(dir), null);
    });
});

test('internal: detectNodeFramework recognizes express/fastify/koa/nest', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', JSON.stringify({ dependencies: { express: '^4' } }));
        const s = _internal.detectNodeFramework(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')));
        assert.equal(s.framework, 'express');
        assert.equal(s.type, 'node-express');
    });
});

test('internal: detectMonorepoApps returns null when no workspace file', () => {
    withTempDir((dir) => {
        writeFile(dir, 'package.json', '{}');
        const r = _internal.detectMonorepoApps(dir);
        assert.equal(r, null);
    });
});

test('internal: hasIndependentSubProjects counts subdirs with own package.json', () => {
    withTempDir((dir) => {
        writeFile(dir, 'web/package.json', '{}');
        writeFile(dir, 'server/package.json', '{}');
        writeFile(dir, 'random.txt', 'x'); // file, not dir — should be ignored
        assert.equal(_internal.hasIndependentSubProjects(dir), 2);
    });
});

// ─── New detectors (added in this branch) ───

test('detectStack: monorepo (directory-based — xensemble case)', () => {
    // xensemble has root package.json (with `dev:server`, `dev:web` scripts)
    // plus web/server/desktop subdirs each with their own package.json + lockfile.
    // No pnpm-workspace.yaml / lerna.json / turbo.json.
    // server/package.json has a production `start` script (node src/server.js) —
    // detectNodeStack 的子包回退会把它提为 startCmd（生产语义）。
    const dir = makeProject({
        'package.json': JSON.stringify({
            scripts: { 'dev:server': 'cd server && npm run dev', 'dev:web': 'cd web && npm run dev' },
        }),
        'web/package.json': JSON.stringify({ dependencies: { vite: '^5' } }),
        'web/vite.config.ts': '',
        'web/package-lock.json': '',
        'server/package.json': JSON.stringify({ dependencies: { fastify: '^4' }, scripts: { start: 'node src/server.js' } }),
        'server/package-lock.json': '',
        'desktop/package.json': JSON.stringify({}),
        'desktop/package-lock.json': '',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'monorepo', 'xensemble-like dir should detect as monorepo');
        // 生产语义：子包 server 的 start 提为 startCmd（dev:* 不再进 startCmd）。
        assert.match(s.startCmd, /cd server && npm run start/);
        assert.ok(Array.isArray(s.monorepoApps) && s.monorepoApps.length >= 2,
            `monorepoApps should list subdirs, got ${JSON.stringify(s.monorepoApps)}`);
    } finally { rm(dir); }
});

test('detectStack: monorepo plain "dev" script no longer leaks into startCmd', () => {
    // 生产语义（2026-09）：plain `dev`（concurrently）与 `dev:*` 都是开发形态，
    // 不进 startCmd——fallback plan 的 serve 步骤跑 dev 会探测失败。
    const dir = makeProject({
        'package.json': JSON.stringify({
            scripts: { 'dev': 'concurrently "npm:dev:web" "npm:dev:server"', 'dev:web': 'cd web && vite', 'dev:server': 'cd server && npm start' },
        }),
        'web/package.json': JSON.stringify({ dependencies: { vite: '^5' } }),
        'web/package-lock.json': '',
        'server/package.json': JSON.stringify({ dependencies: { express: '^4' } }),
        'server/package-lock.json': '',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'monorepo');
        // server 子包没有 start/serve → startCmd=null（live 开发需求由 devKind 单独承担）。
        assert.equal(s.startCmd, null, `dev scripts must not leak into startCmd, got: ${s.startCmd}`);
    } finally { rm(dir); }
});

test('detectStack: monorepo falls back to node-express when no subdirs qualify', () => {
    // No workspace file, only one subdir with package.json → not a monorepo.
    const dir = makeProject({
        'package.json': JSON.stringify({ dependencies: { express: '^4' } }),
        'package-lock.json': '',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'node-express');
    } finally { rm(dir); }
});

// ─── Go: find main in cmd/ or Makefile ───

test('detectStack: go prefers cmd/<name>/main.go single-entry path', () => {
    const dir = makeProject({
        'go.mod': 'module example.com/x\n\ngo 1.22\n',
        'cmd/server/main.go': 'package main\nfunc main() {}\n',
        'cmd/cli/main.go': 'package main\nfunc main() {}\n', // multi-main → fallback
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'go');
        // multi-main → falls back to `go run .` (don't guess)
        assert.equal(s.startCmd, 'go run .');
    } finally { rm(dir); }
});

test('detectStack: go uses Makefile run target when present', () => {
    const dir = makeProject({
        'go.mod': 'module example.com/x\n',
        'main.go': 'package main\n',
        'Makefile': 'run:\n\tgo run .\n\nbuild:\n\tgo build ./...\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.startCmd, 'make run');
    } finally { rm(dir); }
});

// ─── Python: FastAPI / Flask / Django ───

test('detectStack: python recognizes FastAPI via uvicorn', () => {
    const dir = makeProject({
        'requirements.txt': 'fastapi==0.100\nuvicorn[standard]==0.24\n',
        'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'python');
        assert.equal(s.startCmd, 'uvicorn main:app --host 0.0.0.0 --port $PORT');
        assert.equal(s.framework, 'fastapi');
    } finally { rm(dir); }
});

test('detectStack: python uses gunicorn for Flask', () => {
    const dir = makeProject({
        'requirements.txt': 'flask==3.0\ngunicorn==21\n',
        'app.py': 'from flask import Flask\napp = Flask(__name__)\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.startCmd, 'gunicorn app:app -b 0.0.0.0:$PORT');
    } finally { rm(dir); }
});

test('detectStack: python still detects django via manage.py', () => {
    const dir = makeProject({
        'requirements.txt': 'django==4.2\n',
        'manage.py': '#!/usr/bin/env python\nimport django\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.startCmd, 'python3 manage.py runserver 0.0.0.0:$PORT');
        assert.equal(s.framework, 'django');
    } finally { rm(dir); }
});

// ─── Rust: cargo bin / src/main.rs ───

test('detectStack: rust uses [[bin]] name from Cargo.toml', () => {
    const dir = makeProject({
        'Cargo.toml': '[package]\nname = "demo"\n\n[[bin]]\nname = "demo"\npath = "src/main.rs"\n',
        'Cargo.lock': '',
        'src/main.rs': 'fn main() {}\n',
    });
    try {
        const s = detectStack(dir);
        assert.match(s.startCmd, /cargo run --release --bin demo/);
    } finally { rm(dir); }
});

// ─── Java: Spring Boot / Maven ───

test('detectStack: java detects Spring Boot in pom.xml', () => {
    const dir = makeProject({
        'pom.xml': '<?xml version="1.0"?>\n<project><parent><groupId>org.springframework.boot</groupId></parent><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'java-spring-boot');
        assert.equal(s.startCmd, 'mvn spring-boot:run');
        assert.equal(s.framework, 'spring-boot');
    } finally { rm(dir); }
});

test('detectStack: java falls back to mvn exec:java without Spring Boot', () => {
    const dir = makeProject({
        'pom.xml': '<?xml version="1.0"?>\n<project><modelVersion>4.0.0</modelVersion></project>\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'java-maven');
        assert.equal(s.startCmd, 'mvn exec:java');
    } finally { rm(dir); }
});

test('detectStack: java detects Gradle build.gradle with Spring Boot', () => {
    const dir = makeProject({
        'build.gradle': 'plugins { id "org.springframework.boot" version "3.0.0" }\ndependencies { implementation "org.springframework.boot:spring-boot-starter-web" }\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'java-spring-boot');
        assert.equal(s.startCmd, 'gradle bootRun');
    } finally { rm(dir); }
});

// ─── Ruby: Rails / Sinatra ───

test('detectStack: ruby recognizes Rails', () => {
    const dir = makeProject({
        'Gemfile': 'source "https://rubygems.org"\ngem "rails", "~> 7"\n',
        'bin/rails': '#!/usr/bin/env ruby\n',
        'config/application.rb': 'module Demo; class Application < Rails::Application; end; end\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'ruby-rails');
        assert.equal(s.startCmd, 'bundle exec rails server -b 0.0.0.0 -p $PORT');
    } finally { rm(dir); }
});

test('detectStack: ruby detects Sinatra when sinatra gem is in Gemfile', () => {
    // sinatra gem detected → sinatra branch, not rack fallback
    const dir = makeProject({
        'Gemfile': 'source "https://rubygems.org"\ngem "sinatra"\n',
        'config.ru': 'require "sinatra/base"\nrun Sinatra::Application\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'ruby-sinatra');
        assert.match(s.startCmd, /bundle exec ruby config\.ru/);
    } finally { rm(dir); }
});

test('detectStack: ruby falls back to rack with config.ru only (no sinatra gem)', () => {
    // No sinatra/rails gem → bare rack via config.ru
    const dir = makeProject({
        'Gemfile': 'source "https://rubygems.org"\ngem "rack"\n',
        'config.ru': 'require "./app"\nrun App\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'ruby-rack');
        assert.match(s.startCmd, /bundle exec rackup/);
    } finally { rm(dir); }
});

// ─── PHP: Laravel ───

test('detectStack: php recognizes Laravel via composer.json', () => {
    const dir = makeProject({
        'composer.json': JSON.stringify({ require: { 'laravel/framework': '^10' } }),
        'artisan': '#!/usr/bin/env php\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'php-laravel');
        assert.match(s.startCmd, /php artisan serve/);
    } finally { rm(dir); }
});

test('detectStack: php recognizes Slim via public/index.php', () => {
    const dir = makeProject({
        'composer.json': JSON.stringify({ require: { 'slim/slim': '^4' } }),
        'public/index.php': '<?php\nrequire "../vendor/autoload.php";\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'php-slim');
        assert.equal(s.startCmd, 'php -S 0.0.0.0:$PORT -t public');
    } finally { rm(dir); }
});

// ─── Elixir: Phoenix ───

test('detectStack: elixir recognizes Phoenix', () => {
    const dir = makeProject({
        'mix.exs': 'defmodule Demo.MixProject do\nuse Mix.Project\ndefp deps do\n[{:phoenix, "~> 1.7"}]\nend\nend\n',
    });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'elixir-phoenix');
        assert.equal(s.startCmd, 'mix phx.server');
    } finally { rm(dir); }
});

// ─── Static generators ───

test('detectStack: static-hugo identified', () => {
    const dir = makeProject({ 'hugo.toml': 'baseURL = "https://example.com/"\n' });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'static-hugo');
        assert.match(s.startCmd, /hugo server/);
    } finally { rm(dir); }
});

test('detectStack: static-jekyll identified', () => {
    const dir = makeProject({ '_config.yml': 'title: Demo\n' });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'static-jekyll');
        assert.match(s.startCmd, /jekyll serve/);
    } finally { rm(dir); }
});

test('detectStack: static-mkdocs identified', () => {
    const dir = makeProject({ 'mkdocs.yml': 'site_name: Demo\n' });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'static-mkdocs');
    } finally { rm(dir); }
});

test('detectStack: static-docusaurus identified', () => {
    const dir = makeProject({ 'docusaurus.config.js': 'module.exports = { title: "Demo" };\n' });
    try {
        const s = detectStack(dir);
        assert.equal(s.type, 'static-docusaurus');
    } finally { rm(dir); }
});

// ─── normalizeCmdForCompare ───

test('normalizeCmdForCompare strips setpriv wrapper and cd prefix', () => {
    const a = 'setpriv --reuid=1000 --regid=1000 --clear-groups npm run dev';
    const b = 'cd server && npm run dev';
    const c = 'npm run dev';
    const na = _internal.normalizeCmdForCompare(a);
    const nb = _internal.normalizeCmdForCompare(b);
    const nc = _internal.normalizeCmdForCompare(c);
    assert.equal(na, nc, `setpriv+cd should normalize to bare: na=${na}, nc=${nc}`);
    assert.equal(nb, nc, `cd prefix should strip: nb=${nb}, nc=${nc}`);
});

test('normalizeCmdForCompare handles env vars and flags', () => {
    const a = 'PORT=3000 npm run dev --port 3000 --host 0.0.0.0';
    const b = 'npm run dev';
    const na = _internal.normalizeCmdForCompare(a);
    const nb = _internal.normalizeCmdForCompare(b);
    assert.equal(na, nb);
});

// ─── validatePlanAgainstProject ───

test('validatePlanAgainstProject: static-serve plan on a monorepo is fatal', () => {
    // xensemble case: detected = monorepo/node-express, plan = "npm install -g serve; serve ."
    const detected = {
        type: 'monorepo',
        startCmd: 'npm run dev',
        defaultPort: 3000,
        framework: null,
    };
    const backendSig = { hasBackend: true, evidence: ['express in server/package.json'], suggestCmd: 'cd server && npm start' };
    const plan = [
        { id: 's1', kind: 'prepare', name: 'install', command: 'npm install -g serve' },
        { id: 's2', kind: 'serve', name: 'serve_static', command: 'serve . --listen tcp://0.0.0.0:$PORT --no-clipboard' },
    ];
    const { fatal, issues } = validatePlanAgainstProject(plan, detected, backendSig);
    assert.ok(fatal.length > 0, `expected fatal, got ${JSON.stringify(fatal)}`);
    // rule 1: plan doesn't use detected startCmd → fatal
    // rule 3: plan serve doesn't start backend → fatal
    assert.ok(fatal.some((f) => f.includes("doesn't use the detected start command")), 'rule 1 should fire');
    assert.ok(fatal.some((f) => f.includes("none reference the detected backend")), 'rule 3 should fire');
});

test('validatePlanAgainstProject: plan matching detected startCmd is not fatal', () => {
    const detected = { type: 'monorepo', startCmd: 'npm run dev', defaultPort: 3000, framework: null };
    const backendSig = { hasBackend: true, evidence: ['express in server/package.json'], suggestCmd: 'cd server && npm start' };
    // Plan uses detected startCmd → rule 1 passes; rule 3 still fires (no server start) but
    // a competent plan that does `cd server && npm start` (backend) + `npm run dev` (root)
    // would pass rule 3 too. Test the LLM-friendly case.
    const plan = [
        { id: 's1', kind: 'prepare', name: 'install', command: 'npm install' },
        { id: 's2', kind: 'serve', name: 'monorepo dev', command: 'npm run dev' },
    ];
    const { fatal, issues } = validatePlanAgainstProject(plan, detected, backendSig);
    assert.equal(fatal.length, 0, `LLM-friendly plan should not be fatal: ${JSON.stringify(fatal)}`);
});

test('validatePlanAgainstProject: no backend signature, no startCmd in detectStack → no fatal', () => {
    // Pure static site, no backend, no detectable startCmd — let LLM decide
    const detected = { type: 'static', startCmd: 'python3 -m http.server $PORT --bind 0.0.0.0', defaultPort: 8000, framework: null };
    const backendSig = { hasBackend: false, evidence: [], suggestCmd: null };
    const plan = [
        { id: 's1', kind: 'serve', name: 'static', command: 'python3 -m http.server $PORT --bind 0.0.0.0' },
    ];
    const { fatal, issues } = validatePlanAgainstProject(plan, detected, backendSig);
    assert.equal(fatal.length, 0, `static site with no backend should not be fatal: ${JSON.stringify(fatal)}`);
});

test('validatePlanAgainstProject: backend sig present but no serve step → fatal', () => {
    const detected = { type: 'node-express', startCmd: 'npm run dev', defaultPort: 3000, framework: null };
    const backendSig = { hasBackend: true, evidence: ['fastify in server/package.json'], suggestCmd: 'cd server && npm start' };
    const plan = [
        { id: 's1', kind: 'prepare', name: 'install', command: 'npm install' },
    ];  // no serve step
    const { fatal, issues } = validatePlanAgainstProject(plan, detected, backendSig);
    assert.ok(fatal.some((f) => f.includes('NO serve step')), `expected "no serve step" fatal: ${JSON.stringify(fatal)}`);
});

// ─── detectBackendSignature improvements ───

test('detectBackendSignature: finds FastAPI entry file in subdir', () => {
    const dir = makeProject({
        'server/requirements.txt': 'fastapi==0.100\nuvicorn==0.24\n',
        'server/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    });
    try {
        const sig = detectBackendSignature(dir);
        assert.equal(sig.hasBackend, true);
        assert.match(sig.suggestCmd, /uvicorn main:app/);
    } finally { rm(dir); }
});

test('detectBackendSignature: finds Spring Boot in subdir', () => {
    const dir = makeProject({
        'api/pom.xml': '<dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>\n',
    });
    try {
        const sig = detectBackendSignature(dir);
        assert.equal(sig.hasBackend, true);
        assert.match(sig.suggestCmd, /spring-boot:run/);
    } finally { rm(dir); }
});

test('detectBackendSignature: finds Laravel artisan', () => {
    const dir = makeProject({
        'api/composer.json': JSON.stringify({ require: { 'laravel/framework': '^10' } }),
        'api/artisan': '#!/usr/bin/env php\n',
    });
    try {
        const sig = detectBackendSignature(dir);
        assert.equal(sig.hasBackend, true);
        assert.match(sig.suggestCmd, /artisan serve/);
    } finally { rm(dir); }
});

// ─── detectSystemDeps: 系统服务依赖探测（postgres/mysql/redis/mongodb）───

test('detectSystemDeps: finds postgres via npm pg dep in subdir', () => {
    const dir = makeProject({
        'package.json': JSON.stringify({ name: 'root', private: true }),
        'server/package.json': JSON.stringify({ dependencies: { pg: '^8.0.0', express: '^4' } }),
    });
    try {
        const r = detectSystemDeps(dir);
        assert.deepEqual(r.services.sort(), ['postgres']);
        assert.ok(r.signals.some((s) => s.service === 'postgres' && /server\/package\.json/.test(s.evidence)));
    } finally { rm(dir); }
});

test('detectSystemDeps: finds go pgx + mysql via go.mod', () => {
    const dir = makeProject({
        'go.mod': 'module github.com/example/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/jackc/pgx/v5 v5.5.0\n\tgithub.com/go-sql-driver/mysql v1.7.0\n)\n',
    });
    try {
        const r = detectSystemDeps(dir);
        assert.deepEqual(r.services.sort(), ['mysql', 'postgres']);
    } finally { rm(dir); }
});

test('detectSystemDeps: finds postgres + redis via DATABASE_URL/REDIS_URL in .env', () => {
    const dir = makeProject({
        'server/.env': 'DATABASE_URL=postgres://user:pass@127.0.0.1:5432/app\nREDIS_URL=redis://127.0.0.1:6379\n',
    });
    try {
        const r = detectSystemDeps(dir);
        assert.deepEqual(r.services.sort(), ['postgres', 'redis']);
    } finally { rm(dir); }
});

test('detectSystemDeps: finds mongo via docker-compose image + python pymongo', () => {
    const dir = makeProject({
        'docker-compose.yml': 'services:\n  db:\n    image: mongo:7\n',
        'requirements.txt': 'pymongo==4.6.0\n',
    });
    try {
        const r = detectSystemDeps(dir);
        assert.deepEqual(r.services.sort(), ['mongodb']);
    } finally { rm(dir); }
});

test('detectSystemDeps: no false positive for vanilla node project', () => {
    const dir = makeProject({
        'package.json': JSON.stringify({ dependencies: { express: '^4' } }),
    });
    try {
        const r = detectSystemDeps(dir);
        assert.deepEqual(r.services, []);
    } finally { rm(dir); }
});

test('detectSystemDeps: null path returns empty', () => {
    const r = detectSystemDeps(null);
    assert.deepEqual(r.services, []);
    assert.deepEqual(r.signals, []);
});

// ─── detectStartCandidates: 启动命令候选探测（多来源、启发式）───

test('detectStartCandidates: finds go server start from dev.sh + Makefile + ports', () => {
    const dir = makeProject({
        'Makefile': 'dev:\n\tbash scripts/dev.sh\nstart:\n\t$(REQUIRE_ENV)\n',
        'scripts/dev.sh': 'cd server && go run ./cmd/server) &\n',
        'start-server.sh': 'PORT=8080 ./server\n',
        'README.md': '## Run\n\ngo run ./cmd/server\nBackend on :8080\n',
    });
    try {
        const r = detectStartCandidates(dir);
        assert.ok(r.candidates.some((c) => c.cmd === 'go run ./cmd/server'), `candidates: ${JSON.stringify(r.candidates)}`);
        assert.ok(r.candidates.some((c) => c.cmd === 'bash scripts/dev.sh'));
        assert.ok(r.ports.includes(8080), `ports: ${r.ports.join(',')}`);
        // 变量片段应被清理
        assert.ok(!r.candidates.some((c) => c.cmd.startsWith('$(')));
        // 命令尾部杂字符应被清理（go run ./cmd/server) → go run ./cmd/server）
        assert.ok(!r.candidates.some((c) => /\)\s*$/.test(c.cmd)));
    } finally { rm(dir); }
});

test('detectStartCandidates: finds node start script from package.json', () => {
    const dir = makeProject({
        'server/package.json': JSON.stringify({ scripts: { start: 'node index.js' }, dependencies: { express: '^4' } }),
    });
    try {
        const r = detectStartCandidates(dir);
        assert.ok(r.candidates.some((c) => c.cmd.includes('run start')));
    } finally { rm(dir); }
});

test('detectStartCandidates: null path returns empty', () => {
    const r = detectStartCandidates(null);
    assert.deepEqual(r.candidates, []);
    assert.deepEqual(r.ports, []);
});
