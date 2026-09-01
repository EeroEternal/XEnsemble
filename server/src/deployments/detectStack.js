'use strict';

/**
 * Project stack detector.
 *
 * Replaces the ad-hoc `detectProjectType` in twoStage.js:275. Now used both
 * by the two-stage auto-deploy orchestrator (LLM has its own analyzer; this
 * supplies the heuristic fallback for the static-info dump) and by
 * workspace bootstrap (the "Open Preview" button needs to know the right
 * start command without waiting for an LLM round-trip).
 *
 * Detection priority: monorepo > framework-specific lockfile > package.json >
 * pyproject/requirements.txt > go.mod > Cargo.toml > index.html > unknown.
 *
 * @typedef {object} StackInfo
 * @property {string} type                  - 'monorepo' | 'node-vite' | 'node-next'
 *                                          | 'node-nuxt' | 'node-sveltekit'
 *                                          | 'node-react' | 'node-express'
 *                                          | 'python' | 'go' | 'rust' | 'static'
 *                                          | 'unknown'
 * @property {number} defaultPort           - 启动后默认监听端口
 * @property {string|null} packageManager   - 'pnpm' | 'yarn' | 'bun' | 'npm' | null
 * @property {string|null} installCmd       - 全量安装命令
 * @property {string|null} buildCmd         - 生产构建命令
 * @property {string|null} startCmd         - 启动命令（含 $PORT 占位）
 * @property {string|null} framework        - 'vite' | 'next' | 'nuxt' | 'sveltekit' | null
 * @property {string[]|null} monorepoApps   - 发现的子项目目录名 (only when type='monorepo')
 * @property {string[]|null} confidence     - 命中的检测规则，调试用
 */

const fs = require('fs');
const path = require('path');

const MONOREPO_ROOT_FILES = [
    'pnpm-workspace.yaml',
    'lerna.json',
    'nx.json',
    'turbo.json',
];

const NODE_FRAMEWORK_DEPS = {
    next: 'node-next',
    nuxt: 'node-nuxt',
    '@sveltejs/kit': 'node-sveltekit',
    svelte: 'node-sveltekit',
    vite: 'node-vite',
    react: 'node-react',
    express: 'node-express',
    fastify: 'node-express',
    '@nestjs/core': 'node-express',
};

const FRAMEWORK_DEFAULT_PORTS = {
    vite: 5173,
    next: 3000,
    nuxt: 3000,
    'sveltekit': 5173,
    svelte: 5173,
    react: 3000,
    express: 3000,
    fastify: 3000,
};

const FRAMEWORK_DEV_SCRIPTS = {
    vite: 'dev',
    next: 'dev',
    nuxt: 'dev',
    sveltekit: 'dev',
    svelte: 'dev',
    react: 'dev',
    express: 'start',
    fastify: 'start',
};

function hasFile(dir, name) {
    try {
        return fs.existsSync(path.join(dir, name));
    } catch {
        return false;
    }
}

function readJsonSafe(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function readTextSafe(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

function detectPackageManager(dir) {
    if (hasFile(dir, 'pnpm-lock.yaml')) return 'pnpm';
    if (hasFile(dir, 'yarn.lock')) return 'yarn';
    if (hasFile(dir, 'bun.lockb') || hasFile(dir, 'bun.lock')) return 'bun';
    return 'npm';
}

function detectNodeFramework(pkg) {
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const dep of Object.keys(allDeps)) {
        if (NODE_FRAMEWORK_DEPS[dep]) {
            // Normalize framework id for downstream port/script lookups:
            // `@sveltejs/kit` and `svelte` both resolve to "sveltekit".
            const framework = (dep === 'svelte' || dep === '@sveltejs/kit') ? 'sveltekit' : dep;
            return { framework, type: NODE_FRAMEWORK_DEPS[dep] };
        }
    }
    return null;
}

function resolveStartScript(scripts, framework) {
    if (framework && FRAMEWORK_DEV_SCRIPTS[framework]) {
        const candidate = FRAMEWORK_DEV_SCRIPTS[framework];
        if (scripts[candidate]) return candidate;
    }
    return ['dev', 'start', 'preview', 'serve'].find((n) => scripts[n]) || null;
}

/**
 * For monorepos: if no top-level dev/start script exists, fall back to the
 * first `dev:*` script (a single-subproject preview, since spawning every
 * dev:* concurrently is out of scope for the preview flow).
 */
function resolveMonorepoStartScript(scripts) {
    if (!scripts) return null;
    if (['dev', 'start', 'preview', 'serve'].find((n) => scripts[n])) {
        return resolveStartScript(scripts, null);
    }
    return Object.keys(scripts).find((n) => /^dev:/.test(n)) || null;
}

function parsePortFromViteConfig(dir) {
    for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
        const content = readTextSafe(path.join(dir, name));
        if (!content) continue;
        // Look for `port: <digits>` near a `server` block first, then fall
        // back to a top-level `port:` (which is uncommon but supported by
        // the Vite `preview` block). The boundary class avoids matching
        // arbitrary identifier suffixes like `subPort: 4321`.
        const serverBlock = content.match(/server\s*:\s*\{[^}]*?port\s*:\s*(\d{2,5})/m);
        if (serverBlock) return Number(serverBlock[1]);
        const topLevel = content.match(/(?:^|[{,(?:=>])\s*port\s*:\s*(\d{2,5})/);
        if (topLevel) return Number(topLevel[1]);
    }
    return null;
}

function parsePortFromNextConfig(dir) {
    // next.config.js can be CJS or ESM. We only handle the common cases
    // (port: 3000) without spawning a Node process.
    for (const name of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
        const content = readTextSafe(path.join(dir, name));
        if (!content) continue;
        const m = content.match(/port\s*:\s*(\d{2,5})/);
        if (m) return Number(m[1]);
    }
    return null;
}

function parsePortFromEnv(dir) {
    for (const name of ['.env', '.env.local']) {
        const content = readTextSafe(path.join(dir, name));
        if (!content) continue;
        const m = content.match(/^PORT\s*=\s*(\d{2,5})/m);
        if (m) return Number(m[1]);
    }
    return null;
}

function resolvePort(dir, framework, type) {
    const explicit =
        parsePortFromEnv(dir) ||
        (framework === 'vite' ? parsePortFromViteConfig(dir) : null) ||
        (framework === 'next' ? parsePortFromNextConfig(dir) : null);
    if (explicit) return explicit;
    if (framework && FRAMEWORK_DEFAULT_PORTS[framework]) return FRAMEWORK_DEFAULT_PORTS[framework];
    if (type === 'python') return 8000;
    if (type === 'go' || type === 'rust') return 8080;
    return 3000;
}

function detectMonorepoApps(dir) {
    // pnpm-workspace.yaml: top-level `packages:` is a list of globs.
    const ws = readTextSafe(path.join(dir, 'pnpm-workspace.yaml'));
    if (ws) {
        const lines = ws.split('\n');
        let inPackages = false;
        const apps = [];
        for (const line of lines) {
            if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
            if (inPackages) {
                const m = line.match(/^\s*-\s*['"]?([^'"\s#]+)['"]?/);
                if (m) apps.push(m[1].replace(/\/\*$/, ''));
                else if (/^[a-zA-Z]/.test(line)) inPackages = false;
            }
        }
        return apps.length ? apps : null;
    }
    // turbo.json: `tasks` block isn't enough; look for `pipeline` (legacy)
    // or `workspaces` (turbo 2.x).
    const turbo = readJsonSafe(path.join(dir, 'turbo.json'));
    if (turbo) {
        if (Array.isArray(turbo.workspaces)) return turbo.workspaces;
        if (turbo.pipeline && typeof turbo.pipeline === 'object') return Object.keys(turbo.pipeline);
    }
    return null;
}

function detectNodeStack(dir) {
    const pkg = readJsonSafe(path.join(dir, 'package.json'));
    if (!pkg) return null;
    const confidence = ['node'];
    const pm = detectPackageManager(dir);
    const installCmd = `${pm} install --no-audit --no-fund`;
    const fw = detectNodeFramework(pkg);
    const framework = fw?.framework || null;
    const type = fw?.type || 'node-express';

    const scripts = pkg.scripts || {};
    const buildCmd = scripts.build ? `${pm} run build` : null;
    const scriptName = resolveStartScript(scripts, framework);
    const startCmd = scriptName ? `${pm} run ${scriptName}` : null;

    return {
        type,
        defaultPort: resolvePort(dir, framework, type),
        packageManager: pm,
        installCmd,
        buildCmd,
        startCmd,
        framework,
        monorepoApps: null,
        confidence: fw ? [...confidence, framework] : confidence,
    };
}

function detectMonorepo(dir) {
    const matched = MONOREPO_ROOT_FILES.find((f) => hasFile(dir, f));
    if (!matched) return null;
    const confidence = ['monorepo', matched];
    const inner = detectNodeStack(dir);
    const apps = detectMonorepoApps(dir);
    if (inner) {
        // Re-resolve start script with the monorepo fallback so we can
        // surface `dev:web` / `dev:server` style scripts.
        const pkg = readJsonSafe(path.join(dir, 'package.json')) || {};
        const monorepoScript = resolveMonorepoStartScript(pkg.scripts || {});
        const startCmd = monorepoScript ? `${inner.packageManager} run ${monorepoScript}` : inner.startCmd;
        return {
            type: 'monorepo',
            defaultPort: inner.defaultPort,
            packageManager: inner.packageManager,
            installCmd: inner.installCmd,
            buildCmd: inner.buildCmd,
            startCmd,
            framework: inner.framework,
            monorepoApps: apps,
            confidence,
        };
    }
    return {
        type: 'monorepo',
        defaultPort: 3000,
        packageManager: null,
        installCmd: null,
        buildCmd: null,
        startCmd: null,
        framework: null,
        monorepoApps: apps,
        confidence,
    };
}

function detectPythonStack(dir) {
    if (hasFile(dir, 'requirements.txt')) {
        return {
            type: 'python',
            defaultPort: resolvePort(dir, null, 'python'),
            packageManager: 'pip',
            installCmd: 'pip install -r requirements.txt',
            buildCmd: null,
            startCmd: 'python3 -m http.server $PORT --bind 0.0.0.0',
            framework: null,
            monorepoApps: null,
            confidence: ['python', 'requirements.txt'],
        };
    }
    if (hasFile(dir, 'pyproject.toml')) {
        return {
            type: 'python',
            defaultPort: resolvePort(dir, null, 'python'),
            packageManager: 'pip',
            installCmd: 'pip install -e .',
            buildCmd: null,
            startCmd: 'python3 -m http.server $PORT --bind 0.0.0.0',
            framework: null,
            monorepoApps: null,
            confidence: ['python', 'pyproject.toml'],
        };
    }
    return null;
}

function detectGoStack(dir) {
    if (!hasFile(dir, 'go.mod')) return null;
    return {
        type: 'go',
        defaultPort: resolvePort(dir, null, 'go'),
        packageManager: 'go',
        installCmd: 'go mod download',
        buildCmd: 'go build ./...',
        startCmd: 'go run .',
        framework: null,
        monorepoApps: null,
        confidence: ['go'],
    };
}

function detectRustStack(dir) {
    if (!hasFile(dir, 'Cargo.toml')) return null;
    return {
        type: 'rust',
        defaultPort: resolvePort(dir, null, 'rust'),
        packageManager: 'cargo',
        installCmd: 'cargo fetch',
        buildCmd: 'cargo build --release',
        startCmd: 'cargo run --release',
        framework: null,
        monorepoApps: null,
        confidence: ['rust'],
    };
}

function detectStaticStack(dir) {
    if (!hasFile(dir, 'index.html')) return null;
    return {
        type: 'static',
        defaultPort: 8000,
        packageManager: null,
        installCmd: null,
        buildCmd: null,
        startCmd: 'python3 -m http.server $PORT --bind 0.0.0.0',
        framework: null,
        monorepoApps: null,
        confidence: ['static'],
    };
}

/**
 * Heuristic-only project stack detector. Does not invoke the LLM.
 * Each detector is pure and order-sensitive: the first match wins.
 *
 * @param {string} workspacePath
 * @returns {StackInfo}
 */
function detectStack(workspacePath) {
    if (!workspacePath) {
        return emptyStack('unknown', ['no_workspace_path']);
    }
    const dir = workspacePath;
    const detectors = [
        detectMonorepo,
        detectNodeStack,
        detectPythonStack,
        detectGoStack,
        detectRustStack,
        detectStaticStack,
    ];
    for (const fn of detectors) {
        try {
            const result = fn(dir);
            if (result) return result;
        } catch {
            // individual detector failure must not block the rest
        }
    }
    return emptyStack('unknown', ['fallback']);
}

function emptyStack(type, confidence) {
    return {
        type,
        defaultPort: 3000,
        packageManager: null,
        installCmd: null,
        buildCmd: null,
        startCmd: null,
        framework: null,
        monorepoApps: null,
        confidence,
    };
}

/**
 * Convert a StackInfo into a `.agents/preview.json` style contract.
 * Used by both the workspace bootstrap (idempotent) and the two-stage
 * "write preview contract" step (LLM can override).
 *
 * @param {StackInfo} stack
 * @returns {{ command: string, args: string[], port: number, framework: string|null, type: string }}
 */
function stackToPreviewContract(stack) {
    if (!stack) return null;
    // Start command takes priority; if we have it, render as [command, ...args]
    // so the LocalPreviewAdapter / shell can spawn it directly.
    if (stack.startCmd) {
        const parts = stack.startCmd.split(/\s+/);
        return {
            command: parts[0],
            args: parts.slice(1).map((a) => a.replace('$PORT', String(stack.defaultPort))),
            port: stack.defaultPort,
            framework: stack.framework,
            type: stack.type,
        };
    }
    // No detectable start command: fall back to the historical npx serve
    // behavior so the workspace still has *something* to render.
    return {
        command: 'npx',
        args: ['--yes', 'serve', '.', '--listen', '$PORT', '--no-clipboard'],
        port: stack.defaultPort,
        framework: null,
        type: 'fallback',
    };
}

module.exports = {
    detectStack,
    stackToPreviewContract,
    // Internal helpers exposed for tests.
    _internal: {
        detectPackageManager,
        detectNodeFramework,
        detectMonorepoApps,
        parsePortFromViteConfig,
        parsePortFromNextConfig,
        parsePortFromEnv,
        resolvePort,
        resolveStartScript,
    },
};
