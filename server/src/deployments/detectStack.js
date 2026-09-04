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
        const reqs = String(readTextSafe(path.join(dir, 'requirements.txt')) || '');
        // Django 有确定性的启动入口（manage.py runserver）；其余 Python 框架
        // 入口模块不可猜测，保持静态兜底（阶段 A 的 LLM 计划才是主路径）。
        if (hasFile(dir, 'manage.py') || /django/i.test(reqs)) {
            return {
                type: 'python',
                defaultPort: 8000,
                packageManager: 'pip',
                installCmd: 'pip install -r requirements.txt',
                buildCmd: null,
                startCmd: 'python3 manage.py runserver 0.0.0.0:$PORT',
                framework: 'django',
                monorepoApps: null,
                confidence: ['python', 'django'],
            };
        }
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

// 后端签名确定性扫描：毫秒级、纯文件读取，为阶段 A 提供权威后端证据。
// 目的：LLM 把带后端的项目误判成纯前端静态站时，self-check 能依据这里的证据拦截。
const BACKEND_DIR_CANDIDATES = [
    'server', 'api', 'backend', 'srv', 'apps/server', 'apps/api', 'apps/backend',
    'packages/server', 'packages/api', 'packages/backend', 'src/server', 'src/api',
];
const NODE_BACKEND_DEPS = [
    'express', 'fastify', 'koa', '@nestjs/core', 'hono', 'socket.io',
    'apollo-server', 'apollo-server-express', '@apollo/server', 'restify', 'egg',
];
const PY_BACKEND_RE = /\b(django|flask|fastapi|uvicorn|gunicorn|tornado|starlette|litestar)\b/i;

function readPkgBackendInfo(subDir, { rootMode = false } = {}) {
    const pkg = readJsonSafe(path.join(subDir, 'package.json'));
    if (!pkg) return null;
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const backendDep = NODE_BACKEND_DEPS.find((d) => allDeps[d]);
    const scripts = pkg.scripts || {};
    const hasStart = Boolean(scripts.start || scripts.dev || scripts.serve);
    const fw = detectNodeFramework(pkg);
    const frontendOnly = Boolean(fw?.framework && ['vite', 'next', 'nuxt', 'sveltekit'].includes(fw.framework) && !backendDep);
    // 根目录：仅有 start/dev 脚本不足以作为后端证据（纯前端项目同样有 dev 脚本），
    // 必须命中后端依赖。后端命名的子目录（server/、api/...）：start 脚本即可作证据。
    if (!backendDep) return null;
    if (frontendOnly) return null;
    const pm = detectPackageManager(subDir);
    const scriptName = scripts.start ? 'start' : (scripts.dev ? 'dev' : null);
    const cmd = scriptName ? `cd ${path.basename(subDir) || subDir} && ${pm} run ${scriptName}` : null;
    return {
        evidence: `${backendDep} in ${rootMode ? 'root' : `${path.basename(subDir) || subDir}/`}package.json`,
        suggestCmd: cmd,
    };
}

/**
 * 确定性后端签名扫描（不调用 LLM）。扫描根目录与常见后端子目录：
 * - Node 后端依赖（express/fastify/koa/nest/hono/socket.io/...）
 * - 后端子目录自带 package.json（含 start/dev 且非纯前端框架）
 * - Python：requirements.txt / pyproject.toml 含 django/flask/fastapi/uvicorn/gunicorn
 * - go.mod、pom.xml、build.gradle（JVM/Go 项目默认含服务端）
 * - manage.py（Django）
 *
 * @param {string} workspacePath - 宿主侧项目根目录
 * @returns {{ hasBackend: boolean, evidence: string[], suggestCmd: string|null }}
 */
function detectBackendSignature(workspacePath) {
    const evidence = [];
    let suggestCmd = null;
    if (!workspacePath) return { hasBackend: false, evidence, suggestCmd };
    const dir = workspacePath;
    try {
        // 1) 根 package.json
        const root = readPkgBackendInfo(dir);
        if (root) {
            evidence.push(root.evidence);
            if (!suggestCmd) suggestCmd = root.suggestCmd;
        }
        // 2) 常见后端子目录
        for (const sub of BACKEND_DIR_CANDIDATES) {
            const subDir = path.join(dir, sub);
            if (!fs.existsSync(subDir)) continue;
            // python 后端子目录
            if (hasFile(subDir, 'requirements.txt') || hasFile(subDir, 'pyproject.toml')) {
                const reqs = String(readTextSafe(path.join(subDir, 'requirements.txt')) || '')
                    + String(readTextSafe(path.join(subDir, 'pyproject.toml')) || '');
                if (PY_BACKEND_RE.test(reqs)) {
                    evidence.push(`python backend deps in ${sub}/`);
                    if (!suggestCmd) suggestCmd = `cd ${sub} && python3 -m gunicorn --bind 0.0.0.0:$PORT app:app`;
                }
            }
            const info = readPkgBackendInfo(subDir);
            if (info) {
                evidence.push(info.evidence);
                if (!suggestCmd) suggestCmd = info.suggestCmd;
            }
        }
        // 3) Python 根目录
        const rootPy = String(readTextSafe(path.join(dir, 'requirements.txt')) || '')
            + String(readTextSafe(path.join(dir, 'pyproject.toml')) || '');
        if (rootPy && PY_BACKEND_RE.test(rootPy)) {
            const fw = (PY_BACKEND_RE.exec(rootPy) || [])[1] || 'python';
            evidence.push(`python backend framework: ${fw.toLowerCase()}`);
            if (!suggestCmd && hasFile(dir, 'manage.py')) {
                suggestCmd = 'python3 manage.py runserver 0.0.0.0:$PORT';
            }
        }
        // 4) 其他语言（Go/JVM 默认视为含服务端）
        if (hasFile(dir, 'go.mod')) {
            evidence.push('go.mod (go service)');
            if (!suggestCmd) suggestCmd = 'go run .';
        }
        if (hasFile(dir, 'pom.xml') || hasFile(dir, 'build.gradle') || hasFile(dir, 'build.gradle.kts')) {
            evidence.push('JVM build file (maven/gradle service)');
        }
        // 5) Django 入口
        if (hasFile(dir, 'manage.py')) {
            evidence.push('manage.py (django)');
            if (!suggestCmd) suggestCmd = 'python3 manage.py runserver 0.0.0.0:$PORT';
        }
    } catch {
        // 扫描失败不阻塞：按无后端处理（保守，不产生 fatal）
    }
    return { hasBackend: evidence.length > 0, evidence, suggestCmd };
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

// 改动 2 配套：每种 stack 的"依赖 stale 探测"规则
// - node 生态：检查每个子包 directory 里 node_modules 是否比 package.json / lockfile 旧
// - python：检查 site-packages（或 venv）是否比 lockfile 旧
// - go：依赖统一放在 $GOPATH/pkg/mod，无法用文件系统 mtime 直接判断；规则简化为
//   "总是 STALE"，让 verify agent 跑 `go mod download`（这个命令轻量且幂等）
// - rust：检查 target/ 缺失或旧
// - monorepo：枚举所有子 package.json（排除 node_modules 内部），每个独立判断
// 输出格式：每行 `<subdir>: CACHED|STALE|STALE_LOCK|STALE_PKG|MISSING`，最后 `OVERALL: CACHED|STALE`
const STACK_DEPS_RULES = {
    'node-vite':      { pkg: 'node', detect: 'node' },
    'node-next':      { pkg: 'node', detect: 'node' },
    'node-nuxt':      { pkg: 'node', detect: 'node' },
    'node-sveltekit': { pkg: 'node', detect: 'node' },
    'node-react':     { pkg: 'node', detect: 'node' },
    'node-express':   { pkg: 'node', detect: 'node' },
    'monorepo':       { pkg: 'node', detect: 'node-monorepo' },
    'python':         { pkg: 'python', detect: 'python' },
    'go':             { pkg: 'go', detect: 'go' },
    'rust':           { pkg: 'rust', detect: 'rust' },
    'static':         { pkg: 'none', detect: 'none' },
    'unknown':        { pkg: 'node', detect: 'node-monorepo' },
    'fallback':       { pkg: 'node', detect: 'node-monorepo' },
};

module.exports = {
    detectStack,
    stackToPreviewContract,
    detectBackendSignature,
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
    STACK_DEPS_RULES,
    buildDetectScript,
    parseDepsStatus,
};

// 改动 2 配套：每种 stack 的"依赖 stale 探测"规则
// - node 生态：检查每个子包 directory 里 node_modules 是否比 package.json / lockfile 旧
// - python：检查 site-packages（或 venv）是否比 lockfile 旧
// - go：依赖统一放在 $GOPATH/pkg/mod，无法用文件系统 mtime 直接判断；规则简化为
//   "总是 STALE"，让 verify agent 跑 `go mod download`（这个命令轻量且幂等）
// - rust：检查 target/ 缺失或旧
// - monorepo：枚举所有子 package.json（排除 node_modules 内部），每个独立判断
// 输出格式：每行 `<subdir>: CACHED|STALE|STALE_LOCK|STALE_PKG|MISSING`，最后 `OVERALL: CACHED|STALE`

// 改动 2：按 stack type 生成沙箱内跑的"依赖是否 stale"探测脚本。
// 在沙箱内 sh -c 跑，输出形如：
//   server: CACHED
//   web: STALE_PKG
//   OVERALL: STALE
function buildDetectScript(stack) {
    const detect = (stack && stack.type && STACK_DEPS_RULES[stack.type]?.detect) || 'node-monorepo';
    switch (detect) {
        case 'node':
            return `
status_cached=1
subdir="."
if [ ! -d "node_modules" ]; then
    echo "\${subdir}: MISSING"; status_cached=0
elif [ -f "package-lock.json" ] && [ "node_modules" -ot "package-lock.json" ]; then
    echo "\${subdir}: STALE_LOCK"; status_cached=0
elif [ "node_modules" -ot "package.json" ]; then
    echo "\${subdir}: STALE_PKG"; status_cached=0
else
    echo "\${subdir}: CACHED"
fi
[ "\$status_cached" = "1" ] && echo "OVERALL: CACHED" || echo "OVERALL: STALE"
`.trim();
        case 'node-monorepo':
            return `
status_cached=1
# 找所有 package.json（排除 node_modules 内部）；maxdepth 4 覆盖 server/ web/ client/ apps/x/
for pkg in $(find . -maxdepth 4 -name 'package.json' \
    -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null); do
    dir=\$(dirname "\$pkg")
    subdir=\${dir#./}; subdir=\${subdir:-.}
    lk=""
    for f in "\$dir/package-lock.json" "\$dir/pnpm-lock.yaml" "\$dir/yarn.lock" "\$dir/bun.lockb"; do
        [ -f "\$f" ] && lk="\$f" && break
    done
    if [ ! -d "\$dir/node_modules" ]; then
        echo "\$subdir: MISSING"; status_cached=0
    elif [ -n "\$lk" ] && [ "\$dir/node_modules" -ot "\$lk" ]; then
        echo "\$subdir: STALE_LOCK"; status_cached=0
    elif [ "\$dir/node_modules" -ot "\$pkg" ]; then
        echo "\$subdir: STALE_PKG"; status_cached=0
    else
        echo "\$subdir: CACHED"
    fi
done
[ "\$status_cached" = "1" ] && echo "OVERALL: CACHED" || echo "OVERALL: STALE"
`.trim();
        case 'python':
            return `
status_cached=1
subdir="."
# 找 site-packages（venv / system / poetry virtualenv）
sp=$(find . -maxdepth 4 -type d -name 'site-packages' 2>/dev/null | head -1)
[ -z "\$sp" ] && sp=\$(python3 -c 'import sys; print(sys.prefix + "/lib/python" + ".".join(map(str, sys.version_info[:2])) + "/site-packages")' 2>/dev/null)
# 优先级：uv.lock / poetry.lock / requirements.txt / Pipfile.lock
lk=""
for f in uv.lock poetry.lock Pipfile.lock requirements.txt; do
    [ -f "\$f" ] && lk="\$f" && break
done
if [ -z "\$lk" ]; then
    echo "\$subdir: NO_LOCKFILE"; status_cached=0
elif [ ! -d "\$sp" ]; then
    echo "\$subdir: MISSING"; status_cached=0
elif [ "\$sp" -ot "\$lk" ]; then
    echo "\$subdir: STALE"; status_cached=0
else
    echo "\$subdir: CACHED"
fi
[ "\$status_cached" = "1" ] && echo "OVERALL: CACHED" || echo "OVERALL: STALE"
`.trim();
        case 'go':
            // go 没有标准本地 mtime 缓存；永远 STALE 让 agent 跑 go mod download（轻量幂等）
            return `
echo ".: STALE"
echo "OVERALL: STALE"
`.trim();
        case 'rust':
            return `
status_cached=1
subdir="."
if [ ! -d "target" ] || [ ! -f "Cargo.lock" ]; then
    echo "\$subdir: MISSING"; status_cached=0
elif [ "target" -ot "Cargo.lock" ]; then
    echo "\$subdir: STALE"; status_cached=0
else
    echo "\$subdir: CACHED"
fi
[ "\$status_cached" = "1" ] && echo "OVERALL: CACHED" || echo "OVERALL: STALE"
`.trim();
        case 'none':
        default:
            return `echo "OVERALL: CACHED"`;
    }
}

// 改动 2 配套：沙箱内 shell 输出 → { overallCached, perPackage }
function parseDepsStatus(stdout) {
    const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const perPackage = {};
    let overallCached = true;
    for (const line of lines) {
        if (line.startsWith('OVERALL:')) {
            overallCached = line.includes('CACHED') && !line.includes('STALE');
            continue;
        }
        const m = line.match(/^([^:]+):\s*(.+)$/);
        if (m) {
            const [, subdir, status] = m;
            perPackage[subdir.trim()] = status.trim();
            if (status !== 'CACHED') overallCached = false;
        }
    }
    return { overallCached, perPackage };
}

// ensure STACK_DEPS_RULES / buildDetectScript / parseDepsStatus are all exported above
// so twoStage.js can use them via require('./detectStack')
