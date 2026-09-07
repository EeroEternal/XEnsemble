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

// 后端子目录约定（xensemble 这类"目录约定式 monorepo"的兜底识别）：
// root 没有 pnpm-workspace.yaml / turbo.json 等显式 lockfile，但 web/ server/ desktop/ 等
// 子目录各自有 package.json + 自己的 lockfile —— 同样说明是 monorepo。
// 改前仅认 4 个 lockfile → 改后兜底"两个及以上子项目各带 package.json + lockfile"。
const INDEPENDENT_SUBPROJECT_INDICATORS = ['web', 'client', 'app', 'frontend', 'server', 'api', 'backend', 'admin', 'desktop', 'mobile', 'packages', 'services', 'libs', 'tools', 'gateway', 'mock'];

function hasIndependentSubProjects(dir) {
    let count = 0;
    const seen = new Set();
    try {
        for (const sub of INDEPENDENT_SUBPROJECT_INDICATORS) {
            if (seen.has(sub)) continue;
            const subDir = path.join(dir, sub);
            if (!fs.existsSync(subDir)) continue;
            // 子目录必须是 directory（避免同名文件）
            if (!fs.statSync(subDir).isDirectory()) continue;
            // 子目录有 package.json 才有意义
            if (!fs.existsSync(path.join(subDir, 'package.json'))) continue;
            count++;
            seen.add(sub);
        }
    } catch { /* ignore */ }
    return count;
}

function detectMonorepo(dir) {
    const matched = MONOREPO_ROOT_FILES.find((f) => hasFile(dir, f));
    if (!matched) {
        // 兜底：root 没有显式 lockfile，但有 ≥2 个子项目各带独立 package.json → 仍判 monorepo。
        // xensemble（root 无 pnpm-workspace.yaml，server/ web/ desktop/ 各自 package.json）从此识别。
        const subCount = hasIndependentSubProjects(dir);
        if (subCount < 2) return null;
    }
    const confidence = matched ? ['monorepo', matched] : ['monorepo', 'directory-based'];
    const inner = detectNodeStack(dir);
    // 兜底路径（directory-based monorepo）：detectMonorepoApps 找不到 pnpm-workspace.yaml 时返 null，
    // 从 hasIndependentSubProjects 推导的子目录名作为 apps。detectMonorepoApps 仍会跑
    // （兜底 null 不影响 monorepoApps 字段填充——下面合并）。
    const apps = detectMonorepoApps(dir) || (matched ? null : collectMonorepoAppsFromSubdirs(dir));
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

// Directory-based monorepo 兜底：root 无 pnpm-workspace.yaml / turbo.json 时，
// 用 hasIndependentSubProjects 列出的子目录作为 monorepoApps。
function collectMonorepoAppsFromSubdirs(dir) {
    const apps = [];
    for (const sub of INDEPENDENT_SUBPROJECT_INDICATORS) {
        const subDir = path.join(dir, sub);
        if (!fs.existsSync(subDir)) continue;
        try { if (!fs.statSync(subDir).isDirectory()) continue; } catch { continue; }
        if (!fs.existsSync(path.join(subDir, 'package.json'))) continue;
        if (!apps.includes(sub)) apps.push(sub);
    }
    return apps.length ? apps : null;
}

function detectPythonStack(dir) {
    if (hasFile(dir, 'requirements.txt') || hasFile(dir, 'pyproject.toml')) {
        const allText = String(readTextSafe(path.join(dir, 'requirements.txt')) || '')
            + String(readTextSafe(path.join(dir, 'pyproject.toml')) || '');
        const scripts = readTextSafe(path.join(dir, 'pyproject.toml')) || '';
        // 优先级：Django（确定性入口 manage.py）> FastAPI/Flask（典型 main.py/app.py）> 兜底
        if (hasFile(dir, 'manage.py') || /django/i.test(allText)) {
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
        // FastAPI / Flask / Starlette / uvicorn：startup 文件通常叫 main.py / app.py / asgi.py
        // 优先看 pyproject.toml 的 [project.scripts]（poetry/PEP 621 项目最权威），
        // 否则 heuristic：requirements 含 fastapi/flask/starlette → 找常见的入口文件名
        if (/\b(fastapi|flask|starlette|uvicorn|gunicorn)\b/i.test(allText)) {
            // 提取 pyproject [project.scripts] 的 console_scripts
            const scriptMatch = scripts.match(/\[project\][\s\S]*?scripts\s*=\s*([^\[]+?)(?=\n\[|$)/);
            let entryPoint = null;
            if (scriptMatch) {
                const m = scriptMatch[1].match(/^\s*(\S+)\s*=/m);
                if (m) entryPoint = m[1];
            }
            if (!entryPoint) {
                // 找常见入口文件
                for (const f of ['main.py', 'app.py', 'asgi.py', 'wsgi.py', 'server.py']) {
                    if (hasFile(dir, f)) { entryPoint = f.replace(/\.py$/, ''); break; }
                }
            }
            if (entryPoint) {
                return {
                    type: 'python',
                    defaultPort: 8000,
                    packageManager: 'pip',
                    installCmd: 'pip install -r requirements.txt',
                    buildCmd: null,
                    // uvicorn 是 FastAPI/Starlette 标准 server；Flask 一般用 gunicorn
                    startCmd: /\b(gunicorn|flask)\b/i.test(allText)
                        ? `gunicorn ${entryPoint}:app -b 0.0.0.0:$PORT`
                        : `uvicorn ${entryPoint}:app --host 0.0.0.0 --port $PORT`,
                    framework: /\bfastapi\b/i.test(allText) ? 'fastapi' : 'flask',
                    monorepoApps: null,
                    confidence: ['python', entryPoint],
                };
            }
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
    return null;
}

// 探测 Go 项目：go.mod 存在时，确认 main 包路径（避免多 main 时 go run . 选错）。
// 优先读 Makefile/Cakefile 的 run target（项目最权威的启动入口定义），
// 否则用 `go list -f '{{.DefaultImportPath}}'` 找 default 包，回退到 `.`（= go run .）。
function resolveGoStartCmd(dir) {
    if (!hasFile(dir, 'go.mod')) return null;
    // 1) Makefile 的 run target
    const makefile = readTextSafe(path.join(dir, 'Makefile'));
    if (makefile) {
        const m = makefile.match(/^run\s*:\s*([^\n]+)/m);
        if (m) {
            const recipe = m[1].trim();
            if (recipe && !recipe.startsWith('@') && !recipe.startsWith('#')) {
                return { startCmd: `make run`, confidence: ['go', 'Makefile-run'] };
            }
        }
    }
    // 2) cmd/<name>/main.go 约定（Go 项目常见布局，main 在子目录里）
    try {
        const cmdDirs = fs.readdirSync(path.join(dir, 'cmd')).filter((f) => {
            try { return fs.statSync(path.join(dir, 'cmd', f)).isDirectory() && fs.existsSync(path.join(dir, 'cmd', f, 'main.go')); }
            catch { return false; }
        });
        if (cmdDirs.length === 1) {
            return { startCmd: `go run ./cmd/${cmdDirs[0]}`, confidence: ['go', 'cmd-main'] };
        }
    } catch { /* no cmd/ dir */ }
    // 3) 根 main.go
    if (hasFile(dir, 'main.go')) {
        return { startCmd: 'go run .', confidence: ['go', 'root-main'] };
    }
    // 4) 兜底
    return { startCmd: 'go run .', confidence: ['go', 'fallback'] };
}

function detectGoStack(dir) {
    if (!hasFile(dir, 'go.mod')) return null;
    const resolved = resolveGoStartCmd(dir) || { startCmd: 'go run .', confidence: ['go', 'fallback'] };
    return {
        type: 'go',
        defaultPort: resolvePort(dir, null, 'go'),
        packageManager: 'go',
        installCmd: 'go mod download',
        buildCmd: 'go build ./...',
        startCmd: resolved.startCmd,
        framework: null,
        monorepoApps: null,
        confidence: resolved.confidence,
    };
}

// Rust 项目同 Go：识别 binary 路径。Cargo workspace 多个 bin 时不能用 `cargo run --release`
// 一刀切（会要求选包）。优先 [[bin]] section，其次 src/main.rs，再 Makefile run target。
function resolveRustStartCmd(dir) {
    if (!hasFile(dir, 'Cargo.toml')) return null;
    // 1) Cargo.toml [[bin]] name（最权威）
    const cargo = readTextSafe(path.join(dir, 'Cargo.toml')) || '';
    const binMatch = cargo.match(/name\s*=\s*"([^"]+)"[\s\S]*?\[\[bin\]\][\s\S]*?path\s*=\s*"([^"]+)"/);
    if (binMatch) {
        // binary 路径通常在 src/bin/<name>.rs 或同名根
        return { startCmd: 'cargo run --release --bin ' + binMatch[1], confidence: ['rust', 'cargo-bin'] };
    }
    // 2) Makefile run target
    const makefile = readTextSafe(path.join(dir, 'Makefile'));
    if (makefile) {
        const m = makefile.match(/^run\s*:\s*([^\n]+)/m);
        if (m) {
            const recipe = m[1].trim();
            if (recipe && !recipe.startsWith('@') && !recipe.startsWith('#')) {
                return { startCmd: 'make run', confidence: ['rust', 'Makefile-run'] };
            }
        }
    }
    // 3) src/main.rs 是 bin 的强信号
    if (hasFile(dir, 'src', 'main.rs')) {
        return { startCmd: 'cargo run --release', confidence: ['rust', 'src-main'] };
    }
    return { startCmd: 'cargo run --release', confidence: ['rust', 'fallback'] };
}

function detectRustStack(dir) {
    if (!hasFile(dir, 'Cargo.toml')) return null;
    const resolved = resolveRustStartCmd(dir) || { startCmd: 'cargo run --release', confidence: ['rust', 'fallback'] };
    return {
        type: 'rust',
        defaultPort: resolvePort(dir, null, 'rust'),
        packageManager: 'cargo',
        installCmd: 'cargo fetch',
        buildCmd: 'cargo build --release',
        startCmd: resolved.startCmd,
        framework: null,
        monorepoApps: null,
        confidence: resolved.confidence,
    };
}

// JVM 检测：pom.xml / build.gradle 存在 → Spring Boot / 通用 JVM。
// Spring Boot 的"启动入口"用 mvn spring-boot:run（开发模式）或 java -jar（产物模式）。
function readJavaBuildFile(dir) {
    for (const name of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
        if (hasFile(dir, name)) return { name, content: readTextSafe(path.join(dir, name)) || '' };
    }
    return null;
}

function resolveJavaStartCmd(dir, isSpring) {
    const build = readJavaBuildFile(dir);
    if (!build) return null;
    if (build.name === 'pom.xml') {
        return isSpring ? 'mvn spring-boot:run' : 'mvn exec:java';
    }
    // build.gradle / .kts → gradle bootRun (spring) / gradle run (generic)
    return isSpring ? 'gradle bootRun' : 'gradle run';
}

function detectJavaStack(dir) {
    const build = readJavaBuildFile(dir);
    if (!build) return null;
    const isSpring = /\bspring-boot-starter\b/i.test(build.content) || /\bspring-boot\b/.test(build.content);
    const startCmd = resolveJavaStartCmd(dir, isSpring);
    if (!startCmd) return null;
    return {
        type: isSpring ? 'java-spring-boot' : 'java-maven',
        defaultPort: 8080,
        packageManager: build.name === 'pom.xml' ? 'maven' : 'gradle',
        installCmd: null, // mvn/gradle 自带依赖拉取
        buildCmd: isSpring
            ? (build.name === 'pom.xml' ? 'mvn package -DskipTests' : 'gradle bootJar')
            : (build.name === 'pom.xml' ? 'mvn package' : 'gradle build'),
        startCmd,
        framework: isSpring ? 'spring-boot' : null,
        monorepoApps: null,
        confidence: isSpring ? ['java', 'spring-boot'] : ['java'],
    };
}

// Ruby 检测：Gemfile + Rails / Sinatra。
function detectRubyStack(dir) {
    if (!hasFile(dir, 'Gemfile')) return null;
    const gemfile = readTextSafe(path.join(dir, 'Gemfile')) || '';
    // Rails：bin/rails + config/application.rb 都存在
    if (hasFile(dir, 'bin', 'rails') && hasFile(dir, 'config', 'application.rb')) {
        return {
            type: 'ruby-rails',
            defaultPort: 3000,
            packageManager: 'bundler',
            installCmd: 'bundle install',
            buildCmd: 'bundle exec rails assets:precompile',
            startCmd: 'bundle exec rails server -b 0.0.0.0 -p $PORT',
            framework: 'rails',
            monorepoApps: null,
            confidence: ['ruby', 'rails'],
        };
    }
    // Sinatra / 其他：找常见入口文件
    if (/\bsinatra\b/i.test(gemfile)) {
        const entry = ['app.rb', 'config.ru', 'main.rb'].find((f) => hasFile(dir, f));
        if (entry) {
            const mod = entry.replace(/\.(rb|ru)$/, '');
            return {
                type: 'ruby-sinatra',
                defaultPort: 4567,
                packageManager: 'bundler',
                installCmd: 'bundle install',
                buildCmd: null,
                startCmd: `bundle exec ruby ${entry} -o 0.0.0.0 -p $PORT`,
                framework: 'sinatra',
                monorepoApps: null,
                confidence: ['ruby', 'sinatra', entry],
            };
        }
    }
    // 兜底：纯 rack 入口
    if (hasFile(dir, 'config.ru')) {
        return {
            type: 'ruby-rack',
            defaultPort: 9292,
            packageManager: 'bundler',
            installCmd: 'bundle install',
            buildCmd: null,
            startCmd: 'bundle exec rackup -o 0.0.0.0 -p $PORT',
            framework: 'rack',
            monorepoApps: null,
            confidence: ['ruby', 'rack'],
        };
    }
    return null;
}

// PHP 检测：composer.json + Laravel / Symfony / Slim。
function detectPhpStack(dir) {
    const composer = readTextSafe(path.join(dir, 'composer.json'));
    if (!composer) return null;
    let composerJson = {};
    try { composerJson = JSON.parse(composer); } catch { /* ignore */ }
    const require = { ...(composerJson.require || {}), ...(composerJson['require-dev'] || {}) };
    // Laravel
    if (/\blaravel\/framework\b/.test(JSON.stringify(require)) || hasFile(dir, 'artisan')) {
        return {
            type: 'php-laravel',
            defaultPort: 8000,
            packageManager: 'composer',
            installCmd: 'composer install --no-dev --optimize-autoloader',
            buildCmd: 'php artisan key:generate --force || true',
            startCmd: 'php artisan serve --host=0.0.0.0 --port=$PORT',
            framework: 'laravel',
            monorepoApps: null,
            confidence: ['php', 'laravel'],
        };
    }
    // Symfony
    if (/\bsymfony\/framework-bundle\b/.test(JSON.stringify(require)) || hasFile(dir, 'bin', 'console')) {
        return {
            type: 'php-symfony',
            defaultPort: 8000,
            packageManager: 'composer',
            installCmd: 'composer install',
            buildCmd: null,
            startCmd: 'php -S 0.0.0.0:$PORT -t public',
            framework: 'symfony',
            monorepoApps: null,
            confidence: ['php', 'symfony'],
        };
    }
    // Slim / 通用：内置 php server
    if (/\bslim\/slim\b/.test(JSON.stringify(require)) || hasFile(dir, 'public', 'index.php')) {
        return {
            type: 'php-slim',
            defaultPort: 8000,
            packageManager: 'composer',
            installCmd: 'composer install',
            buildCmd: null,
            startCmd: 'php -S 0.0.0.0:$PORT -t public',
            framework: 'slim',
            monorepoApps: null,
            confidence: ['php', 'slim'],
        };
    }
    return null;
}

// Elixir 检测：mix.exs + Phoenix。
function detectElixirStack(dir) {
    if (!hasFile(dir, 'mix.exs')) return null;
    const mixExs = readTextSafe(path.join(dir, 'mix.exs')) || '';
    if (/\bphoenix\b/.test(mixExs)) {
        return {
            type: 'elixir-phoenix',
            defaultPort: 4000,
            packageManager: 'mix',
            installCmd: 'mix deps.get',
            buildCmd: 'mix compile',
            startCmd: 'mix phx.server',
            framework: 'phoenix',
            monorepoApps: null,
            confidence: ['elixir', 'phoenix'],
        };
    }
    // 通用 Elixir：mix run
    return {
        type: 'elixir',
        defaultPort: 4000,
        packageManager: 'mix',
        installCmd: 'mix deps.get',
        buildCmd: 'mix compile',
        startCmd: 'mix run --no-halt',
        framework: null,
        monorepoApps: null,
        confidence: ['elixir'],
    };
}

// 静态站点生成器：Hugo / Jekyll / Docusaurus / MkDocs / 11ty。
// 之前 detectStaticStack 只看 index.html 兜底到 python3 -m http.server —
// 现在各种生成器有自己的 dev server，用原生命令比通用静态服务器更准。
function detectStaticGenerators(dir) {
    // Hugo
    if (hasFile(dir, 'hugo.toml') || hasFile(dir, 'config.toml')) {
        return {
            type: 'static-hugo',
            defaultPort: 1313,
            packageManager: null,
            installCmd: null,
            buildCmd: 'hugo --minify',
            startCmd: 'hugo server --bind 0.0.0.0 --port $PORT',
            framework: 'hugo',
            monorepoApps: null,
            confidence: ['static', 'hugo'],
        };
    }
    // Jekyll
    if (hasFile(dir, '_config.yml') || hasFile(dir, '_config.yaml')) {
        return {
            type: 'static-jekyll',
            defaultPort: 4000,
            packageManager: 'bundler',
            installCmd: 'bundle install',
            buildCmd: 'bundle exec jekyll build',
            startCmd: 'bundle exec jekyll serve --host 0.0.0.0 --port $PORT',
            framework: 'jekyll',
            monorepoApps: null,
            confidence: ['static', 'jekyll'],
        };
    }
    // MkDocs
    if (hasFile(dir, 'mkdocs.yml')) {
        return {
            type: 'static-mkdocs',
            defaultPort: 8000,
            packageManager: 'pip',
            installCmd: 'pip install mkdocs',
            buildCmd: 'mkdocs build',
            startCmd: 'mkdocs serve -a 0.0.0.0:$PORT',
            framework: 'mkdocs',
            monorepoApps: null,
            confidence: ['static', 'mkdocs'],
        };
    }
    // Docusaurus
    if (hasFile(dir, 'docusaurus.config.js') || hasFile(dir, 'docusaurus.config.ts')) {
        return {
            type: 'static-docusaurus',
            defaultPort: 3000,
            packageManager: 'npm',
            installCmd: 'npm install',
            buildCmd: 'npm run build',
            startCmd: 'npm run serve -- --host 0.0.0.0 --port $PORT',
            framework: 'docusaurus',
            monorepoApps: null,
            confidence: ['static', 'docusaurus'],
        };
    }
    // 11ty
    if (hasFile(dir, '.eleventy.js') || hasFile(dir, 'eleventy.config.js') || hasFile(dir, 'eleventy.config.mjs') || hasFile(dir, 'eleventy.config.cjs')) {
        return {
            type: 'static-11ty',
            defaultPort: 8080,
            packageManager: 'npm',
            installCmd: 'npm install',
            buildCmd: 'npx @11ty/eleventy',
            startCmd: 'npx @11ty/eleventy --serve --port=$PORT',
            framework: '11ty',
            monorepoApps: null,
            confidence: ['static', '11ty'],
        };
    }
    return null;
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

// 已知需要原生编译链（node-gyp / C++ 编译 / python3 预处理）的常用 npm 包。
// 命中 → platform install 阶段先 apt 装 build-essential + python3（沙箱镜像默认无编译链），
// 否则 npm install 部分失败或 agent 要自己试错 apt（实测 1.6 分钟 + 一轮 LLM）。
const NATIVE_COMPILE_PKGS = new Set([
    'node-pty', 'bcrypt', 'node-gyp', 'canvas', 'sharp', 'sqlite3',
    'better-sqlite3', 'bufferutil', 'utf-8-validate', 'koffi', 'tree-sitter',
    'oniguruma', 'deasync', 'serialport', 'microtime', 'grpc', 'leveldown',
    'lmdb', 'sodium-native', 'nan',
]);

// 确定性 native 依赖扫描：读根 + 一层子目录的 package.json（纯文件读取，毫秒级）。
// @returns {{ hit: boolean, pkgs: string[] }}
function detectNativeDeps(hostWorkspacePath) {
    if (!hostWorkspacePath) return { hit: false, pkgs: [] };
    const found = new Set();
    const check = (pkg) => {
        if (!pkg) return;
        const deps = {
            ...(pkg.dependencies || {}),
            ...(pkg.devDependencies || {}),
            ...(pkg.optionalDependencies || {}),
        };
        for (const name of Object.keys(deps)) {
            if (NATIVE_COMPILE_PKGS.has(name)) found.add(name);
        }
    };
    try {
        check(readJsonSafe(path.join(hostWorkspacePath, 'package.json')));
        for (const ent of fs.readdirSync(hostWorkspacePath, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
            check(readJsonSafe(path.join(hostWorkspacePath, ent.name, 'package.json')));
        }
    } catch { /* 扫描失败不影响部署流程 */ }
    return { hit: found.size > 0, pkgs: [...found].slice(0, 8) };
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
                    if (!suggestCmd) {
                        // 入口：优先 manage.py（django）→ main.py（fastapi）→ app.py
                        if (hasFile(subDir, 'manage.py')) {
                            suggestCmd = `cd ${sub} && python3 manage.py runserver 0.0.0.0:$PORT`;
                        } else {
                            for (const entry of ['main', 'app', 'asgi', 'wsgi', 'server']) {
                                if (hasFile(subDir, `${entry}.py`)) {
                                    suggestCmd = `cd ${sub} && uvicorn ${entry}:app --host 0.0.0.0 --port $PORT`;
                                    break;
                                }
                            }
                            if (!suggestCmd) suggestCmd = `cd ${sub} && python3 -m gunicorn --bind 0.0.0.0:$PORT app:app`;
                        }
                    }
                }
            }
            // Java/Ruby/PHP 后端子目录：子目录有 pom.xml/build.gradle/Gemfile/composer.json + 入口
            const subBuild = readJavaBuildFile(subDir);
            if (subBuild && /\bspring-boot-starter\b/i.test(subBuild.content)) {
                evidence.push(`spring-boot in ${sub}/`);
                if (!suggestCmd) {
                    suggestCmd = subBuild.name === 'pom.xml'
                        ? `cd ${sub} && mvn spring-boot:run`
                        : `cd ${sub} && gradle bootRun`;
                }
            }
            const subGemfile = readTextSafe(path.join(subDir, 'Gemfile'));
            if (subGemfile && hasFile(subDir, 'bin', 'rails') && hasFile(subDir, 'config', 'application.rb')) {
                evidence.push(`rails in ${sub}/`);
                if (!suggestCmd) suggestCmd = `cd ${sub} && bundle exec rails server -b 0.0.0.0 -p $PORT`;
            }
            const subComposer = readTextSafe(path.join(subDir, 'composer.json'));
            if (subComposer && hasFile(subDir, 'artisan')) {
                evidence.push(`laravel in ${sub}/`);
                if (!suggestCmd) suggestCmd = `cd ${sub} && php artisan serve --host=0.0.0.0 --port=$PORT`;
            }
            // 兜底：原 node 后端识别
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
        // Go 多 main 时优先 cmd/<name>/main.go
        if (!suggestCmd && hasFile(dir, 'go.mod')) {
            try {
                const cmdDirs = fs.readdirSync(path.join(dir, 'cmd')).filter((f) => {
                    try { return fs.statSync(path.join(dir, 'cmd', f)).isDirectory() && fs.existsSync(path.join(dir, 'cmd', f, 'main.go')); }
                    catch { return false; }
                });
                if (cmdDirs.length === 1) suggestCmd = `go run ./cmd/${cmdDirs[0]}`;
            } catch { /* no cmd/ */ }
        }
        const javaBuild = readJavaBuildFile(dir);
        if (javaBuild) {
            if (/\bspring-boot-starter\b/i.test(javaBuild.content)) {
                evidence.push('spring-boot in root');
            } else {
                evidence.push(`JVM build file (${javaBuild.name})`);
            }
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
    // 顺序：具体 → 通用。monorepo 优先（xensemble 这类"目录约定"已能命中），
    // 然后是真实项目（java/ruby/php/elixir/static-generators 全部走各自原生命令），
    // 再是 node/python/go/rust，最后 generic static 兜底。
    const detectors = [
        detectMonorepo,
        detectNodeStack,
        detectJavaStack,
        detectPythonStack,
        detectRubyStack,
        detectPhpStack,
        detectGoStack,
        detectRustStack,
        detectElixirStack,
        detectStaticGenerators,
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
    // node-* 全系统一用 node-monorepo 探测（maxdepth 4 枚举根+子 package.json）：
    // 单包 'node' 规则只查根 node_modules，导致 server/web 等子包不被探测、
    // platform install 补装循环覆盖不到（xensemble 实测：server/web 依赖全靠 agent 手装）。
    // node-monorepo 脚本对单包项目同样兼容（只有根 package.json → `.:MISSING`）。
    'node-vite':      { pkg: 'node', detect: 'node-monorepo' },
    'node-next':      { pkg: 'node', detect: 'node-monorepo' },
    'node-nuxt':      { pkg: 'node', detect: 'node-monorepo' },
    'node-sveltekit': { pkg: 'node', detect: 'node-monorepo' },
    'node-react':     { pkg: 'node', detect: 'node-monorepo' },
    'node-express':   { pkg: 'node', detect: 'node-monorepo' },
    'monorepo':       { pkg: 'node', detect: 'node-monorepo' },
    // python
    'python':         { pkg: 'python', detect: 'python' },
    // go
    'go':             { pkg: 'go', detect: 'go' },
    // rust
    'rust':           { pkg: 'rust', detect: 'rust' },
    // jvm
    'java-spring-boot': { pkg: 'java', detect: 'java-maven' },
    'java-maven':       { pkg: 'java', detect: 'java-maven' },
    // ruby
    'ruby-rails':    { pkg: 'ruby', detect: 'ruby' },
    'ruby-sinatra':  { pkg: 'ruby', detect: 'ruby' },
    'ruby-rack':     { pkg: 'ruby', detect: 'ruby' },
    // php
    'php-laravel':   { pkg: 'php', detect: 'php' },
    'php-symfony':   { pkg: 'php', detect: 'php' },
    'php-slim':      { pkg: 'php', detect: 'php' },
    // elixir
    'elixir-phoenix':{ pkg: 'elixir', detect: 'elixir' },
    'elixir':        { pkg: 'elixir', detect: 'elixir' },
    // static generators
    'static-hugo':     { pkg: 'hugo', detect: 'none' },
    'static-jekyll':   { pkg: 'ruby', detect: 'ruby' },
    'static-mkdocs':   { pkg: 'python', detect: 'python' },
    'static-docusaurus':{ pkg: 'node', detect: 'node' },
    'static-11ty':     { pkg: 'node', detect: 'node' },
    // generic
    'static':         { pkg: 'none', detect: 'none' },
    'unknown':        { pkg: 'node', detect: 'node-monorepo' },
    'fallback':       { pkg: 'node', detect: 'node-monorepo' },
};

module.exports = {
    detectStack,
    stackToPreviewContract,
    detectBackendSignature,
    validatePlanAgainstProject,
    readTextSafe,
    detectNativeDeps,
    // Internal helpers exposed for tests.
    _internal: {
        detectPackageManager,
        detectNodeFramework,
        detectMonorepoApps,
        resolveMonorepoStartScript,
        parsePortFromViteConfig,
        parsePortFromNextConfig,
        parsePortFromEnv,
        resolvePort,
        resolveStartScript,
        hasIndependentSubProjects,
        resolveGoStartCmd,
        resolveRustStartCmd,
        resolveJavaStartCmd,
        normalizeCmdForCompare,
    },
    STACK_DEPS_RULES,
    buildDetectScript,
    parseDepsStatus,
};

// 把命令归一化：剥掉前导 cd / setpriv wrapper / 公共 flag，便于做语义等价比较。
// 用来判断"LLM 的 plan serve step 是否在用 detected.startCmd"。
// 例："setpriv --reuid=1000 --regid=1000 --clear-groups npm run dev" 与
//    "cd server && npm run dev" 与 "npm run dev" 归一化后都 == "npm run dev"。
function normalizeCmdForCompare(raw) {
    let c = String(raw || '').trim();
    // 去掉前导 setpriv 包装（BoxLiteExecAdapter.exec 注入的 uid 切换）
    c = c.replace(/^setpriv\s+(?:\S+\s+)*--clear-groups\s+/, '');
    // 去掉前导 cd X && / cd X; 链
    while (/^cd\s+\S+\s*(?:&&|;)\s*/.test(c)) {
        c = c.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '');
    }
    // 去掉前导环境变量赋值
    c = c.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
    // 去掉常见的 --port / --host / --strictPort 等与启动语义无关的 flag
    c = c.replace(/\s+--port\s+\S+/g, ' ');
    c = c.replace(/\s+--host\s+\S+/g, ' ');
    c = c.replace(/\s+--strictPort\b/g, ' ');
    c = c.replace(/\s+--listen\s+\S+/g, ' ');
    c = c.replace(/\s+--no-clipboard\b/g, ' ');
    // 合并多余空白
    c = c.replace(/\s+/g, ' ').trim();
    return c;
}

/**
 * 结构性 plan 验证：取代原先基于 STATIC_SERVE_RE regex 的 fatal 判定。
 *
 * 核心思路：plan 的"serve 步骤是否合理"应当由"项目结构是否支持"判定，而不是
 * "命令名是否在黑名单里"。具体规则：
 * - rule 1：detectStack 检测到非 static 的 startCmd，plan serve 步骤不包含 detected.startCmd
 *   的语义（normalizeCmdForCompare 等价）→ fatal。理由：plan 没有真正启动这个项目。
 * - rule 2：backendSig.hasBackend=true 且 plan 完全没 serve 步骤 → fatal。
 *   后端签名证据（fastify/express in server/ 等）说明有后端要起，plan 没起 = 永远连不上。
 * - rule 3：backendSig.hasBackend=true 但所有 serve 步骤都不像在启后端 → fatal。
 *   后端没起，前端独活 = 浏览器 5xx / 白屏。
 * - rule 4：detected.type='static' → 静态站 serve 合法（npx serve / hugo server 等），不报错。
 * - rule 5：detected.startCmd 缺失（fallback 路径）→ 不判（heuristic 无法判断时保留 LLM 决定）。
 *
 * 保留原 runSelfCheck 的 toolchain / cd 重复 / script 存在性检查（与项目类型无关，不动）。
 *
 * @param {Array} steps - plan.steps
 * @param {object|null} detected - detectStack() 输出
 * @param {{hasBackend:boolean,evidence:string[],suggestCmd:string|null}} backendSig
 * @returns {{fatal:string[],issues:string[]}}
 */
function validatePlanAgainstProject(steps, detected, backendSig) {
    const fatal = [];
    const issues = [];
    if (!Array.isArray(steps) || !steps.length) return { fatal, issues };

    const serveSteps = steps.filter((s) => s && s.kind === 'serve');
    const detectedStart = detected && detected.startCmd;
    const isStaticDetected = detected && (detected.type === 'static' || /^static-/.test(detected.type));

    // rule 1：detected 有 startCmd 且非 static，但 plan serve 步骤不包含它的语义
    if (detectedStart && !isStaticDetected) {
        const targetCmd = normalizeCmdForCompare(detectedStart);
        const opensWithTarget = serveSteps.some((s) => {
            const n = normalizeCmdForCompare(s.command);
            return n === targetCmd || n.endsWith(' ' + targetCmd) || n.startsWith(targetCmd + ' ');
        });
        if (serveSteps.length === 0) {
            fatal.push(`plan has no serve step, but detectStack says project needs: ${detectedStart}`);
        } else if (!opensWithTarget) {
            fatal.push(`plan's serve step doesn't use the detected start command. detected: "${detectedStart}", got: [${serveSteps.map((s) => `"${s.command}"`).join(', ')}]. The plan must call the real entry point.`);
        }
    }

    // rule 2：后端签名有 + plan 完全没 serve
    if (backendSig && backendSig.hasBackend && serveSteps.length === 0) {
        fatal.push(`Deterministic backend scan found evidence (${backendSig.evidence.join('; ')}) but plan has NO serve step. The backend will never start.`);
    }

    // rule 3：后端签名有 + 所有 serve 步骤都不像在启后端
    if (backendSig && backendSig.hasBackend && serveSteps.length > 0) {
        // 启发式：detectStack 的 startCmd 或 backendSig.suggestCmd 已经标识了后端启动入口
        const backendMarkers = [];
        if (detectedStart) backendMarkers.push(detectedStart);
        if (backendSig.suggestCmd) backendMarkers.push(backendSig.suggestCmd);
        // evidence 里的子目录名（如 "fastify in server/package.json" → "server"）也是信号
        for (const ev of backendSig.evidence || []) {
            const m = ev.match(/in ([\w/.-]+)\//);
            if (m) backendMarkers.push(m[1].replace(/^.*\//, ''));
        }
        const hitsBackend = serveSteps.some((s) => {
            const n = normalizeCmdForCompare(s.command);
            return backendMarkers.some((mk) => {
                const nm = normalizeCmdForCompare(mk);
                return n.includes(nm) || n.includes(mk);
            });
        });
        if (!hitsBackend) {
            fatal.push(`plan has serve steps but none reference the detected backend (${backendSig.evidence.join('; ')}; markers: ${backendMarkers.slice(0, 3).join(', ')}). The backend will never run, browser will show 5xx.`);
        }
    }

    return { fatal, issues };
}

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
    echo "\${subdir}: MISSING"; status_cached=0
elif [ "target" -ot "Cargo.lock" ]; then
    echo "\${subdir}: STALE"; status_cached=0
else
    echo "\${subdir}: CACHED"
fi
[ "\$status_cached" = "1" ] && echo "OVERALL: CACHED" || echo "OVERALL: STALE"
`.trim();
        case 'java-maven':
            // JVM 没有标准 mtime 缓存（target/ 增量编译结构复杂），永远 STALE 让 agent
            // 跑 mvn dependency:resolve 或 gradle dependencies 验证。
            return `
echo ".: STALE"
echo "OVERALL: STALE"
`.trim();
        case 'ruby':
            // Gemfile.lock 存在 + vendor/ 缺失 → STALE；有 vendor/ 且比 Gemfile.lock 新 → CACHED
            return `
status_cached=1
subdir="."
if [ -f "Gemfile.lock" ] && [ ! -d "vendor/bundle" ]; then
    echo "\${subdir}: STALE"; status_cached=0
elif [ -d "vendor/bundle" ] && [ -f "Gemfile.lock" ] && [ "vendor/bundle" -ot "Gemfile.lock" ]; then
    echo "\${subdir}: STALE"; status_cached=0
else
    echo "\${subdir}: CACHED"
fi
[ "\$status_cached" = "1" ] && echo "OVERALL: CACHED" || echo "OVERALL: STALE"
`.trim();
        case 'php':
            // composer.lock 存在 + vendor/ 缺失 → STALE
            return `
status_cached=1
subdir="."
if [ -f "composer.lock" ] && [ ! -d "vendor" ]; then
    echo "\${subdir}: STALE"; status_cached=0
elif [ -d "vendor" ] && [ -f "composer.lock" ] && [ "vendor" -ot "composer.lock" ]; then
    echo "\${subdir}: STALE"; status_cached=0
else
    echo "\${subdir}: CACHED"
fi
[ "\$status_cached" = "1" ] && echo "OVERALL: CACHED" || echo "OVERALL: STALE"
`.trim();
        case 'elixir':
            // mix.lock 存在 + _build/ 缺失 → STALE
            return `
status_cached=1
subdir="."
if [ -f "mix.lock" ] && [ ! -d "_build" ]; then
    echo "\${subdir}: STALE"; status_cached=0
elif [ -d "_build" ] && [ -f "mix.lock" ] && [ "_build" -ot "mix.lock" ]; then
    echo "\${subdir}: STALE"; status_cached=0
else
    echo "\${subdir}: CACHED"
fi
[ "\$status_cached" = "1" ] && echo "OVERALL: CACHED" || echo "OVERALL: STALE"
`.trim();
        case 'hugo':
            // Hugo 是二进制，无依赖缓存概念
            return `echo "OVERALL: CACHED"`;
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
