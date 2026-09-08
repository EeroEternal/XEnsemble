const { getRuntime } = require('../runtime/registry');
const { RuntimeError } = require('../runtime/interfaces');
const { analyzeProjectWithOpencode } = require('./analyzeOpencode');
const { detectRuntimeToolchain } = require('./runtimeToolchain');
const {
    detectStack,
    stackToPreviewContract,
    detectBackendSignature,
    validatePlanAgainstProject,
    normalizeCmdForCompare,
} = require('./detectStack');

const API_KEY = process.env.LLM_ANALYZE_API_KEY;
// OpenAI 兼容端点：配置可能给 base URL（如 …/api/v1）或完整 chat/completions URL；
// 统一归一化为完整端点，否则这里直接 POST 到 base URL 会 404，部署必挂。
function chatCompletionsUrl(url) {
    const u = String(url || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions\/?$/i.test(u)) return u;
    return `${u}/chat/completions`;
}
const API_URL = chatCompletionsUrl(process.env.LLM_ANALYZE_API_URL || 'https://api.deepseek.com/chat/completions');
const MODEL = process.env.LLM_ANALYZE_MODEL || 'deepseek-chat';
const LLM_TIMEOUT_MS = 180000;

const KEY_FILES = [
    'package.json',
    'Dockerfile',
    'docker-compose.yml',
    'Makefile',
    'requirements.txt',
    'pyproject.toml',
    'go.mod',
    'Cargo.toml',
    'pom.xml',
    'build.gradle',
    '.agents/preview.json',
    'vite.config.js',
    'vite.config.ts',
    'next.config.js',
    'vercel.json',
    'netlify.toml',
    'index.html',
    'README.md',
];

const MAX_FILE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 80000;
const MAX_FILES_READ = 30;
// 分析时跳过的重目录（目录与文件统一按路径段匹配）。fsList 已在递归时剪枝同名单
// 目录；此处作为兜底，且对 file 条目也生效（旧实现只过滤 directory 导致 node_modules
// 下文件全部泄漏进 tree，把 server/ 等真实文件挤出 800 行）。
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
    '.venv', '__pycache__', '.cache', '.turbo', '.nx',
    'vendor', 'target', 'venv', '.tox', 'Pods', 'bower_components',
    'jspm_packages', '.gradle', '.m2', 'tmp', 'logs',
    '.pnpm-store', // pnpm 全局依赖缓存：体量巨大且非项目代码，不排除会占满 800 行 tree 把真实文件挤出
]);
const SKIP_EXTS = new Set(['.lock', '.map', '.min.js', '.min.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.webm', '.zip', '.tar', '.gz', '.pdf', '.bin', '.so', '.dylib', '.exe']);
const CONFIG_PATTERNS = [/^\.env(\.|$)/, /\.example$/, /\.sample$/, /\.template$/, /^config\.(json|ya?ml|toml|js|ts)$/, /^application\.(ya?ml|properties)$/];
const PRIORITY_FILES = ['package.json', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'README.md', 'Dockerfile', 'docker-compose.yml', 'Makefile', 'index.html', 'vite.config.js', 'vite.config.ts', 'next.config.js', 'nuxt.config.js', 'svelte.config.js', 'tsconfig.json', '.agents/preview.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'];

// 判断路径任意一级是否命中重目录（目录与文件通用）。
function isSkippedPath(p) {
    const parts = String(p || '').split('/').filter(Boolean);
    return parts.some((seg) => SKIP_DIRS.has(seg));
}

// 文件名（basename）级高优先级：后端/前端入口、依赖清单、脚本说明等，
// 确保 MAX_FILES_READ 名额优先覆盖这些"判断项目如何启动"的关键文件，
// 避免被 Dockerfile/示例 README 等低价值文件占满。
const HIGH_PRIORITY_NAMES = new Set([
    'package.json', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json',
    'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle',
    'index.js', 'main.js', 'server.js', 'app.js', 'index.ts', 'main.ts',
    'server.ts', 'app.ts', 'manage.py', 'app.py', 'wsgi.py', 'asgi.py',
    'vite.config.js', 'vite.config.ts', 'next.config.js', 'nuxt.config.js',
    'svelte.config.js', 'docker-compose.yml', 'Makefile', 'README.md',
]);

async function readFileSafe(fsAdapter, workspacePath, ref, filePath) {
    try {
        const content = await fsAdapter.fsRead(workspacePath, filePath, { runtimeRef: ref, encoding: 'utf8' });
        if (typeof content !== 'string' || !content.trim()) return null;
        return { path: filePath, content: content.slice(0, MAX_FILE_CHARS) };
    } catch {
        return null;
    }
}

async function collectProjectContext(fsAdapter, workspacePath, ref) {
    let treeText = '';
    let allFiles = [];
    try {
        const entries = await fsAdapter.fsList(workspacePath, '.', { runtimeRef: ref, depth: 'recursive', includeHidden: false });
        treeText = entries
            .filter((e) => !isSkippedPath(e.path))
            .map((e) => `${e.type === 'directory' ? 'dir ' : 'file'} ${e.path}`)
            .sort()
            .slice(0, 800)
            .join('\n');
        allFiles = entries
            .filter((e) => e.type !== 'directory')
            .map((e) => e.path)
            .filter((p) => {
                if (isSkippedPath(p)) return false;
                const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
                if (SKIP_EXTS.has(ext)) return false;
                return true;
            });
    } catch {
        treeText = '(unable to list)';
    }

    const prioritySet = new Set(PRIORITY_FILES);
    const configSet = new Set();
    allFiles.forEach((p) => {
        const name = p.split('/').pop() || '';
        if (CONFIG_PATTERNS.some((rx) => rx.test(name))) configSet.add(p);
        if (prioritySet.has(p) || prioritySet.has(name)) configSet.add(p);
    });

    // 读取名额优先排序（MAX_FILES_READ=30）：
    //  1. 高优先级关键文件 —— 依赖清单/后端入口/脚本说明（basename 命中
    //     HIGH_PRIORITY_NAMES，如 package.json、server.js、index.js、README），
    //     确保判断"如何启动全栈"的证据不会被 Dockerfile/示例 README 挤掉；
    //     同级内根目录（server/、根路径）优先。
    //  2. configSet（config 文件 + PRIORITY_FILES 命中）—— 依赖、构建、环境配置。
    //  3. 其余文件。
    const highSet = new Set();
    allFiles.forEach((p) => {
        const name = p.split('/').pop() || '';
        if (HIGH_PRIORITY_NAMES.has(name)) highSet.add(p);
    });
    const isRootish = (p) => {
        const seg = String(p || '').split('/')[0];
        return !seg || seg === 'server' || seg === 'api' || seg === 'backend' || seg === 'src';
    };
    const byPriority = (p) => (highSet.has(p) ? (isRootish(p) ? 0 : 1) : (configSet.has(p) ? 2 : 3));
    const sortedFiles = allFiles
        .sort((a, b) => byPriority(a) - byPriority(b) || a.localeCompare(b))
        .slice(0, MAX_FILES_READ);

    const fileContents = [];
    let totalChars = 0;
    for (const f of sortedFiles) {
        const result = await readFileSafe(fsAdapter, workspacePath, ref, f);
        if (!result) continue;
        if (totalChars + result.content.length > MAX_CONTEXT_CHARS) break;
        fileContents.push(`### ${result.path}\n${result.content}`);
        totalChars += result.content.length;
    }

    return {
        treeText,
        fileContentsText: fileContents.join('\n\n'),
        totalFiles: allFiles.length,
        readFiles: fileContents.length,
    };
}

function buildMessages(treeText, fileContentsText, feedback) {
    const system = [
        'You are a deployment expert. You have been given the COMPLETE project source (file tree + key file contents). Read and understand the ENTIRE project first, then produce a complete deploy plan that brings up the WHOLE project service — BOTH frontend AND backend together, fully integrated, with the dev server (and API server if separate) running concurrently so the final preview actually works end-to-end.',
        'The commands run inside the project workspace (a Linux sandbox VM with node/npm/pnpm/yarn, python3/pip, go, cargo, java/maven/gradle available).',
        'Respond with ONLY a JSON object: {"configFiles":[...],"steps":[...]}.',
        'STEP 1 — UNDERSTAND THE PROJECT (do this in your reasoning, do not output):',
        '- Read every file in the provided context. Understand the tech stack, monorepo layout (workspaces / lerna / nx / turbo / pnpm-workspaces), frontend vs backend split (web/, client/, server/, api/, apps/*, packages/*), package manager, build system, how the dev/preview server starts, what services run and on which ports.',
        '- CRITICAL — frontend AND backend (full-stack integration): The goal is to preview the WHOLE running app in a browser, not just a static page. The final app needs the backend API (auth, data, business logic) wired to the frontend. If the project has a separate backend (e.g. server/ or api/), you MUST start it as part of the serve step (via concurrently, turbo run dev, nx run-many, or a root npm run dev script that starts both). The frontend alone is NOT enough.',
        '- Detect frontend→backend wiring: next.config rewrites to localhost:PORT, vite proxy, hardcoded baseURL http://localhost:PORT, or a server/ dir with its own entry (Node, Go go.mod, Python, Java). When found, the serve step MUST start the backend first in the background, then the frontend in the foreground, e.g. `(cd server && nohup ./bin/server > /tmp/backend.log 2>&1 &) ; cd apps/web && npm start`. A frontend-only plan makes every API call 5xx (blank pages) and the platform health check (which probes API endpoints) will REJECT it.',
        '- Database: if the backend needs PostgreSQL/MySQL (DATABASE_URL / pgx / prisma / gorm / docker-compose db service), include prepare steps to ensure the DB runs locally at 127.0.0.1 (the platform usually pre-provisions PostgreSQL; else `apt-get install -y postgresql` + `service postgresql start`), create the user/database from DATABASE_URL if needed, and run migrations. Never point the app at a remote DB.',
        '- Runtime versions: check for pinned versions in the project files — package.json "engines.node", .nvmrc, .tool-versions (Node); pyproject.toml requires-python, .python-version (Python); go.mod go directive (Go); rust-toolchain.toml, Cargo.toml rust-version (Rust); pom.xml java.version, build.gradle toolchain (Java). The platform will PRE-INSTALL the required versions from CN mirrors (nvm/npmmirror for Node, apt backports for Python, rustup/rsproxy for Rust, adoptium for Java, npmmirror for Go) during provisioning. Your plan should assume the correct versions are already available — do NOT include steps to install runtimes unless the platform cannot satisfy them.',
        '- Identify ALL configuration files that need user input before deployment (.env, .env.example, config.*, application.*, settings.*, or any file with placeholders / YOUR_API_KEY / empty values / TODO). Include BOTH frontend and backend config files (e.g. web/.env AND server/.env).',
        'STEP 2 — OUTPUT configFiles FIRST, then steps:',
        'configFiles (return BEFORE steps): ALL configuration files (frontend + backend) the user MUST fill in before deployment. For each: {"path":".env","template":"<full file content>","description":"bullet-separated explanation of what to fill (newline-separated)","keys":["API_KEY","DB_URL"]} (keys is OPTIONAL list of placeholder key names to highlight).',
        '- template = the FULL file content (copy from .env.example verbatim if it exists; keep placeholders like YOUR_API_KEY or empty values for secrets).',
        '- Do NOT include real secrets in template; use placeholders or empty values.',
        '- Even if the project might not need config, ALWAYS return .env / .env.example / any config file you found in the project tree. The user will review and fill in placeholders.',
        'steps: ordered shell commands to deploy the FULL-STACK app. Each: {"id":"step_1","name":"...","command":"...","description":"...","kind":"prepare"|"serve"}.',
        '- kind="prepare": commands that finish on their own (install deps in root AND each subdir if needed, build, lint, generate, db migrate, prisma generate, etc.).',
        '- For monorepos: enumerate ALL sub-packages (root + every subdir with its own package.json / requirements.txt / go.mod / Cargo.toml / pyproject.toml). Detect by listing `ls <subdir>/package.json` etc. The root package.json having "workspaces" (or pnpm-workspace.yaml / yarn.lock workspaces config / lerna.json / nx.json / turbo.json) means ONE root install covers all. Otherwise EACH sub-package MUST have its own `cd <subdir> && <pm> install` step. A monorepo without workspaces config and missing per-subdir install is a guaranteed runtime failure (e.g. web/ missing katex → vite 500 → blank page). For Python monorepos enumerate each pyproject.toml / requirements.txt; for Go workspaces each go.mod; for Cargo workspaces each Cargo.toml. ALWAYS include an install step for every detected sub-package, even if the root has any install step.',
        '- If the project has native deps that need building (node-pty, sqlite3, bcrypt, sharp, prisma, etc.), the FIRST prepare step should be `apt-get update && apt-get install -y python3 build-essential` so node-gyp can compile them.',
        '- kind="serve": EXACTLY ONE final step that brings up the FULL STACK (frontend + backend) as a long-running process. Listen on the stack\'s default port or a free port, referenced as $PORT in the command (export PORT=<port> if the app reads it). Do not suffix with & or nohup.',
        '- Serve step: prefer a root script that starts BOTH frontend and backend (e.g. `npm run dev` at root if it uses concurrently / turbo / nx / pnpm -r to start all). The final command MUST bring up the full stack so the preview page can actually call the backend API end-to-end.',
        '- CRITICAL — no repeated `cd` or relative-path chaining: Each step runs in the SAME persistent bash shell, so `cd web` from a previous step PERSISTS. NEVER repeat `cd web` in a later step — you will get "No such file or directory". Either: (a) put ALL `cd` AND its commands in ONE step (e.g. `cd web && npm install`), or (b) use absolute paths (e.g. `npm --prefix web run dev`) or npm/pnpm workspace syntax. The same goes for any other directory-changing command — do it once at the start of the step that needs it.',
        '- .agents/preview.json is a platform default hint, NOT authoritative; the project root scripts take priority.',
        '- If a build is required before serving, add the build as a prepare step.',
        '- Keep steps minimal (2-4 max). Do not include steps for writing config files (those go in configFiles).',
        '- OPTIONAL: if the project needs PostgreSQL, add "needsPostgres": true. If it needs Redis, add "needsRedis": true. If it needs a specific Node version (engines/.nvmrc), add "needsNode": true. If it needs a specific Python version (requires-python/.python-version), add "needsPython": true. If it needs a specific Rust version (rust-toolchain/Cargo.toml), add "needsRust": true. If it needs a specific Java version (pom.xml/build.gradle), add "needsJava": true. If neither, omit or set to false.',
        'No markdown fences, no explanation, only the JSON object.',
    ].join(' ');

    const user = `Project file tree:\n${treeText}\n\nKey files:\n${fileContentsText || '(none found)'}`;
    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
    if (feedback) {
        messages.push({ role: 'user', content: `Self-check found issues in your previous output. Fix ALL of them and return the corrected JSON object: {"configFiles":[...],"steps":[...]}.\n\nIssues to fix:\n${feedback}` });
    }
    return messages;
}

function parseResponse(content) {
    let text = String(content || '').trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end === -1) return null;
        try {
            parsed = JSON.parse(text.slice(start, end + 1));
        } catch {
            return null;
        }
    }
    const steps = Array.isArray(parsed) ? parsed : parsed.steps;
    if (!Array.isArray(steps) || !steps.length) return null;
    const configFiles = Array.isArray(parsed.configFiles)
        ? parsed.configFiles.map((c) => ({
            path: String(c.path || '').slice(0, 200),
            template: String(c.template || '').slice(0, 10000),
            description: String(c.description || '').slice(0, 500),
        })).filter((c) => c.path)
        : [];
    return {
        steps: steps.map((s, i) => ({
            id: String(s.id || `step_${i + 1}`).slice(0, 40),
            name: String(s.name || '').slice(0, 100),
            command: String(s.command || '').slice(0, 500),
            description: String(s.description || '').slice(0, 300),
            kind: s.kind === 'serve' ? 'serve' : 'prepare',
        })),
        configFiles,
        needsPostgres: Boolean(parsed.needsPostgres),
        needsRedis: Boolean(parsed.needsRedis),
        needsNode: Boolean(parsed.needsNode),
        needsPython: Boolean(parsed.needsPython),
        needsRust: Boolean(parsed.needsRust),
        needsJava: Boolean(parsed.needsJava),
    };
}

function normalizeSteps(steps) {
    if (!steps.length) return steps;
    const serveIndices = steps
        .map((s, i) => (s.kind === 'serve' ? i : -1))
        .filter((i) => i >= 0);
    if (serveIndices.length === 0) {
        steps[steps.length - 1].kind = 'serve';
    } else {
        const lastServe = serveIndices[serveIndices.length - 1];
        steps.forEach((s, i) => {
            if (s.kind === 'serve' && i !== lastServe) s.kind = 'prepare';
        });
    }
    return steps;
}

function shellQuote(s) {
    return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// 对 AI 生成的步骤做"只读自查"：目录存在性、npm/pnpm/yarn script 存在性、cd 重复、
// 工具链可用性（用户明确要求"只有代码约束才是稳定的"）。
// 不实际安装/启动，只跑轻量只读命令，把问题反馈给 LLM 修正。
async function runSelfCheck({ steps, configFiles, runtimeRef, workspacePath, hostWorkspacePath }) {
    const runtime = getRuntime();
    const issues = [];
    const fatal = [];

    // 0) 工具链探测：步骤里如果直接调用了 go/cargo/python3/mvn/java，
    //    需要沙箱里装好。LLM 自报"有这些工具"不可信，所以走代码 `command -v` 探测。
    //    探测并行触发（4s 总预算），不阻塞下面 cd/script 检查。
    const toolchainPromise = detectRuntimeToolchain(runtimeRef, workspacePath)
        .catch(() => []);
    const toolchain = await toolchainPromise;
    const toolByName = Object.fromEntries(toolchain.map((t) => [t.command, t]));

    // 工具名 → 推测语言（用于反馈给 LLM 怎么装）
    const toolLang = {
        go: 'go', cargo: 'rust', rustc: 'rust', python3: 'python', pip: 'python',
        pip3: 'python', java: 'jvm', mvn: 'jvm', gradle: 'jvm',
        gcc: 'native', make: 'native', python: 'native',
    };
    const aptPkgForTool = {
        go: 'golang-go',
        cargo: 'cargo',
        rustc: 'rustc',
        python3: 'python3 python3-pip',
        pip: 'python3-pip',
        pip3: 'python3-pip',
        java: 'default-jdk',
        mvn: 'maven',
        gradle: 'gradle',
        gcc: 'build-essential',
        make: 'build-essential',
    };

    // 1) cd 目录提取 + 重复检测
    const cdDirs = [];
    for (let i = 0; i < steps.length; i++) {
        const cmd = steps[i].command || '';
        for (const m of cmd.matchAll(/\bcd\s+([^\s;&|()]+)/g)) {
            cdDirs.push({ stepIndex: i, stepName: steps[i].name, dir: m[1] });
        }
    }
    for (let i = 1; i < cdDirs.length; i++) {
        if (cdDirs[i].dir === cdDirs[i - 1].dir) {
            issues.push(`Step "${cdDirs[i].stepName}": repeated "cd ${cdDirs[i].dir}" from the previous step. The shell keeps its working directory, so remove the duplicate cd.`);
        }
    }
    // 2) cd 目录是否存在（只读 test -d）
    for (const c of cdDirs) {
        try {
            const r = await runtime.exec.exec('sh', ['-c', `test -d ${shellQuote(c.dir)} && echo EXISTS || echo MISSING`], {}, { runtimeRef, cwd: workspacePath });
            if (r.exitCode === 0 && !String(r.stdout || '').includes('EXISTS')) {
                issues.push(`Step "${c.stepName}": directory "${c.dir}" does not exist at the workspace root. Check the correct path.`);
            }
        } catch { /* ignore check errors */ }
    }

    // 3) npm/pnpm/yarn run script 是否存在（只读列出 scripts）
    const scriptRe = /\b(npm|pnpm|yarn)\s+run\s+([^\s;&|]+)/g;
    for (const step of steps) {
        const cmd = step.command || '';
        for (const m of cmd.matchAll(scriptRe)) {
            const pm = m[1];
            const script = m[2];
            const cdMatch = cmd.match(/\bcd\s+([^\s;&|()]+)/);
            const dir = cdMatch ? cdMatch[1] : '.';
            try {
                const r = await runtime.exec.exec('sh', ['-c', `cd ${shellQuote(dir)} 2>/dev/null && ${pm} run 2>&1 | head -80`], {}, { runtimeRef, cwd: workspacePath });
                const out = String(r.stdout || '') + String(r.stderr || '');
                const found = new RegExp(`^\\s+${script}\\s*$`, 'm').test(out);
                if (!found) {
                    const names = (out.match(/^\s{2,}(\S+)/gm) || []).map((s) => s.trim()).slice(0, 10).join(', ');
                    issues.push(`Step "${step.name}": script "${script}" not found via "${pm} run" in "${dir}". Available: ${names || '(none)'}.`);
                }
            } catch (e) {
                issues.push(`Step "${step.name}": could not verify script "${script}" in "${dir}" (${e.message}).`);
            }
        }
    }

    // 4) 工具链探测：步骤里如果调用了 go/cargo/python3/mvn/java 等，
    //    沙箱里必须装好。`command -v` 跑完再决定是报错还是自动补 prepare 步骤。
    //    用户明确要求"只有代码约束才是稳定的"，所以这是真实探测，不是 LLM 报。
    //
    //    行为:
    //    - 工具缺失 + 步骤已经是 apt-get install 自己 → OK
    //    - 工具缺失 + 某 prepare 步已经装了这个包 → OK
    //    - 工具缺失 + 整个 plan 都没装 → 自动在第一个 prepare 步前面插入
    //      `apt-get update && apt-get install -y <pkg>` 步骤（不靠 LLM 记得装）
    //
    //    工具名 token 匹配：避免 `golang-go` 误匹配 `go`，
    //    用 (?![A-Za-z0-9+\-]) 排除后接字母/数字/连字符的情况。
    const TOOLS_TO_CHECK = ['go', 'cargo', 'rustc', 'python3', 'pip', 'pip3', 'java', 'mvn', 'gradle', 'make', 'gcc'];
    const toolMatchRe = (tool) => new RegExp(`(^|[^A-Za-z0-9_+\\-])${tool}(?![A-Za-z0-9_+\\-])`);
    // Phase A: scan every apt-get install step and mark the installed
    // tool as "covered by the plan". A `golang-go` install step covers
    // the `go` tool because that's the package the boxlite base needs.
    const installedViaApt = new Set();
    for (const step of steps) {
        if (!/apt-get\s+install/.test(step.command || '')) continue;
        const m = (step.command || '').match(/apt-get\s+install[^\n]*?\s+([a-z0-9][a-z0-9+\-]*(?:\s+[a-z0-9][a-z0-9+\-]*)*)\s*$/i);
        if (m) {
            for (const pkg of m[1].split(/\s+/)) {
                if (!pkg) continue;
                if (/^golang-?/.test(pkg)) installedViaApt.add('go');
                if (/^cargo$/.test(pkg)) installedViaApt.add('cargo');
                if (/^rustc$/.test(pkg)) installedViaApt.add('rustc');
                if (/^python3?$/.test(pkg)) installedViaApt.add('python3');
                if (/^python3-pip$/.test(pkg)) { installedViaApt.add('pip'); installedViaApt.add('pip3'); }
                if (/^default-jdk$/.test(pkg)) installedViaApt.add('java');
                if (/^maven$/.test(pkg)) installedViaApt.add('mvn');
                if (/^gradle$/.test(pkg)) installedViaApt.add('gradle');
                if (/^build-essential$/.test(pkg)) { installedViaApt.add('make'); installedViaApt.add('gcc'); }
            }
        }
    }
    // Phase B: report missing tools (skip those already covered by apt-get).
    const insertBefore = new Map(); // stepIndex -> [{name, command, description, kind}]
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const cmd = step.command || '';
        for (const tool of TOOLS_TO_CHECK) {
            if (installedViaApt.has(tool)) continue;
            if (!toolMatchRe(tool).test(cmd)) continue;
            const info = toolByName[tool];
            if (info && !info.available) {
                const pkg = aptPkgForTool[tool] || tool;
                const lang = toolLang[tool] || 'unknown';
                issues.push(`Step "${step.name}": tool "${tool}" is not installed in the sandbox (${lang} toolchain). Auto-injected a prepare step to install it.`);
                const list = insertBefore.get(i) || [];
                list.push({
                    name: `Install ${lang} toolchain (${tool})`,
                    command: `apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${pkg}`,
                    description: `Install ${pkg} (auto-injected by self-check because "${tool}" was used in "${step.name}" but is not in the boxlite base image).`,
                    kind: 'prepare',
                });
                insertBefore.set(i, list);
                installedViaApt.add(tool); // mark this as covered now
            }
        }
    }

    // 把插入的 prepare 步骤反向 merge（同一 index 只插一次，包含多个 tool）
    if (insertBefore.size) {
        const sortedIndexes = [...insertBefore.keys()].sort((a, b) => b - a);
        for (const idx of sortedIndexes) {
            const inserts = insertBefore.get(idx).reverse();
            for (const inj of inserts) {
                steps.splice(idx, 0, { id: `step_inject_${idx}_${steps.length}`, ...inj });
            }
        }
    }

    // Fatal checks: if any of these fire, the plan CANNOT be salvaged
    // by self-check alone — analyzeProjectDeploy must reject the plan and
    // fall back to the detectStack-based plan. Auto-injecting a toolchain
    // step is fine; rewriting a "serve with npx serve" plan when the
    // project is a monorepo is not, because the static fallback would
    // hide the real app (Next.js, FastAPI, etc.) from the preview.
    //
    // We return `fatal: [...]` alongside `issues` so the caller can
    // decide whether to fall back vs warn-and-proceed.
    const STATIC_SERVE_RE = /(?:npx\s+(?:--yes\s+)?serve\b|python3?\s+-m\s+http\.server)/i;
    const monorepoMarkers = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json'];
    let isMonorepoProject = false;
    if (hostWorkspacePath) {
        try {
            const fs = require('fs');
            const path = require('path');
            isMonorepoProject = monorepoMarkers.some((m) => fs.existsSync(path.join(hostWorkspacePath, m)));
        } catch { /* host fs not available in tests; fall through */ }
    }
    if (!isMonorepoProject) {
        isMonorepoProject = steps.some((s) => /-r\s+dev\b|\bpnpm\s+-r\b|\bturbo\s+run\b|\bnx\s+run-many\b/.test(s.command || ''));
    }
    if (isMonorepoProject) {
        for (const step of steps) {
            if (step.kind !== 'serve') continue;
            if (STATIC_SERVE_RE.test(step.command || '')) {
                fatal.push(`Step "${step.name}" uses a static-serve command (npx serve / python3 -m http.server) but the project is a monorepo — this can never serve the real app. The plan must start the real frontend + backend (e.g. \`cd apps/web && pnpm dev\` or root \`pnpm dev\`).`);
            }
        }
    }

    // 后端签名一致性：确定性扫描发现后端证据，但计划没有任何 serve 步骤，
    // 或所有 serve 步骤都是静态托管 —— 后端永远不会被启动，属于结构性错误
    // （fatal → 调用方走 detectStack 兜底计划）。
    // 注意：serve 步骤存在但"看起来只是前端 dev server"不作 fatal ——
    // 根脚本（turbo dev / concurrently）可能同时启动前后端，误杀会破坏正常计划；
    // 这种情况降级为 issue 反馈给 LLM 修正。
    try {
        const backendSig = detectBackendSignature(hostWorkspacePath || workspacePath);
        if (backendSig.hasBackend) {
            const serveSteps = steps.filter((s) => s.kind === 'serve');
            const allStatic = serveSteps.length > 0 && serveSteps.every((s) => STATIC_SERVE_RE.test(s.command || ''));
            const ev = backendSig.evidence.join('; ');
            if (serveSteps.length === 0) {
                fatal.push(`Deterministic scan found backend evidence (${ev}) but the plan has NO serve step at all — the backend would never start. The plan MUST include a serve step starting it${backendSig.suggestCmd ? ` (e.g. \`${backendSig.suggestCmd}\`)` : ''}.`);
            } else if (allStatic) {
                fatal.push(`Deterministic scan found backend evidence (${ev}) but every serve step is static-serve (npx serve / python3 -m http.server), which cannot run a backend. Replace with a real backend start command${backendSig.suggestCmd ? ` (e.g. \`${backendSig.suggestCmd}\`)` : ''}.`);
            } else {
                const backendServed = serveSteps.some((s) => {
                    const cmd = String(s.command || '');
                    return backendSig.evidence.some((e) => {
                        const m = e.match(/in ([\w/.-]+)\/package\.json/);
                        return m && cmd.includes(m[1].split('/').pop());
                    }) || /gunicorn|uvicorn|manage\.py|go run|cargo run|nohup.*server|node .*server/i.test(cmd);
                });
                if (!backendServed) {
                    issues.push(`Deterministic scan found backend evidence (${ev}). If your serve steps only start the frontend, the backend will never run — make sure a serve step starts it${backendSig.suggestCmd ? ` (e.g. \`${backendSig.suggestCmd}\`)` : ''}.`);
                }
            }
        }
    } catch { /* 签名扫描失败不阻塞 self-check */ }

    return { passed: issues.length === 0, issues, fatal };
}

function fallbackSteps(fileContentsText) {
    const pm = fileContentsText.includes('pnpm-lock.yaml') ? 'pnpm'
        : fileContentsText.includes('yarn.lock') ? 'yarn' : 'npm';
    const hasPkg = fileContentsText.includes('### package.json\n');
    const steps = [];
    if (hasPkg) {
        steps.push({ id: 'step_1', name: 'Install dependencies', command: `${pm} install`, description: `Install packages with ${pm}`, kind: 'prepare' });
        steps.push({ id: 'step_2', name: 'Start dev server', command: `${pm} run dev`, description: 'Start dev server on $PORT', kind: 'serve' });
    } else if (fileContentsText.includes('### requirements.txt\n') || fileContentsText.includes('### pyproject.toml\n')) {
        steps.push({ id: 'step_1', name: 'Install dependencies', command: 'pip install -r requirements.txt', description: 'Install Python packages', kind: 'prepare' });
        steps.push({ id: 'step_2', name: 'Start server', command: 'python3 -m http.server $PORT', description: 'Serve on $PORT', kind: 'serve' });
    } else {
        steps.push({ id: 'step_1', name: 'Start preview', command: 'npx --yes serve . --listen $PORT --no-clipboard', description: 'Serve static files on $PORT', kind: 'serve' });
    }
    return steps;
}

// 对 LLM API 的瞬时故障（5xx / 429 / 网络错误）自动重试，避免一次网关抖动直接让部署失败。
// 不支持 thinking 参数的模型（如 glm-flash 连 { type: "disabled" } 都不收，直接 400）：
// 首次 400 且错误指向 thinking 时记录，本进程后续请求自动不带该参数（自愈降级）。
const noThinkingModels = new Set();
async function callLlm(messages) {
    const retries = 2;
    let lastWarning = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
        try {
            const bodyObj = { model: MODEL, messages, max_tokens: 16000, temperature: 0.2, response_format: { type: 'json_object' } };
            if (!noThinkingModels.has(MODEL)) bodyObj.thinking = { type: 'disabled' };
            const res = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
                body: JSON.stringify(bodyObj),
                signal: controller.signal,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                lastWarning = `LLM error ${res.status}: ${text.slice(0, 120)}`;
                if (res.status === 400 && /thinking/i.test(text) && !noThinkingModels.has(MODEL)) {
                    noThinkingModels.add(MODEL);
                    console.error(`[analyzeDeploy] model ${MODEL} rejected thinking param — retrying without it`);
                    clearTimeout(timer);
                    continue;
                }
                if ((res.status >= 500 || res.status === 429) && attempt < retries) {
                    console.error(`[analyzeDeploy] LLM error ${res.status}, retry ${attempt + 1}/${retries}`);
                    await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 4000));
                    continue;
                }
                return { ok: false, warning: lastWarning };
            }
            const data = await res.json();
            const choice = data.choices?.[0];
            const content = choice?.message?.content;
            console.error('[analyzeDeploy] finish_reason:', choice?.finish_reason, 'usage:', JSON.stringify(data.usage), 'content_len:', String(content || '').length, 'content:', String(content || '').slice(0, 500));
            return { ok: true, content };
        } catch (e) {
            lastWarning = `LLM unavailable: ${e.message}`;
            if (attempt < retries) {
                console.error(`[analyzeDeploy] LLM unavailable (${e.message}), retry ${attempt + 1}/${retries}`);
                await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 4000));
                continue;
            }
            return { ok: false, warning: lastWarning };
        } finally {
            clearTimeout(timer);
        }
    }
    return { ok: false, warning: lastWarning };
}

const MAX_AGENT_ROUNDS = 15;
const ALLOWED_RUN_CHECK_PREFIX = [
    'test -d', 'test -f', 'test -e', 'ls ', 'which ', 'find ', 'cat ',
    'npm view', 'npm run', 'npm ls', 'pnpm run', 'pnpm ls', 'yarn run',
    'node -v', 'npm -v', 'pnpm -v', 'yarn -v', 'node -p', 'node -e',
    'grep ', 'head ', 'wc -',
];

const AGENT_SYSTEM_PROMPT = [
    'You are a deployment analysis agent. Your job: explore a software project in a sandbox VM and produce a complete deploy plan.',
    'You have READ-ONLY tools. Call them to understand the project. Use them as much as you need — explore until you are confident.',
    'Tools (respond with exactly one tool call or the final answer, as valid JSON, no markdown fences):',
    '1. {"action":"tool","tool":"list_dir","args":{"path":"."}} — list a directory (path relative to project root; "." for root).',
    '2. {"action":"tool","tool":"read_file","args":{"path":"package.json"}} — read a file (relative path).',
    '3. {"action":"tool","tool":"run_check","args":{"cmd":"test -d web && echo web-exists"}} — run a READ-ONLY check (allowed: test -d/-f/-e, ls, cat, which, find, npm view, npm run, npm ls, node -e, echo, grep, head). NEVER install/build/mutate.',
    'You MUST understand: tech stack, monorepo layout (workspaces/lerna/nx/turbo/pnpm-workspaces), frontend vs backend split (web/ client/ server/ api/ apps/* packages/*), package manager, dev/preview scripts, ports, and ALL config files needing user input (.env, .env.example, config.*, application.*, settings.*, or files with placeholders).',
    'Critical tool-usage rules:',
    '- Call exactly ONE tool per response. Do NOT bundle multiple commands into one call.',
    '- Do NOT repeat the same tool call twice — if a call returned nothing useful, change approach (different path/tool) or finalize.',
    '- Explore efficiently: read the root package.json early, check for workspaces/monorepo, then dive into web/ and server/ package.json. Finalize as soon as you are confident — typically 4-10 tool calls for most projects, more for large monorepos. Do not over-explore.',
    'When confident, output your FINAL answer: {"action":"final","result":{"configFiles":[{"path":"...","template":"...","description":"...","keys":[...]}],"steps":[{"id":"step_1","name":"...","command":"...","description":"...","kind":"prepare"|"serve"}]}}',
    'Rules for the final answer:',
    '- configFiles: ALL files (frontend AND backend) the user must fill before deploy. template = full suggested content (copy from .env.example if exists; keep placeholders like YOUR_API_KEY). ALWAYS include the .env / .env.example files you find. Do NOT put real secrets.',
    '- steps: ordered commands to bring up the FULL STACK (frontend + backend together).',
    '- kind=prepare: one-shot commands (install deps, build, migrate, prisma generate). For monorepos, first step is root install (npm install at root installs workspaces). If native deps need building (node-pty/sqlite3/bcrypt/sharp/prisma), FIRST prepare step should be `apt-get update && apt-get install -y python3 build-essential`.',
    '- kind=serve: EXACTLY ONE final long-running command that brings up the full app. Use $PORT for the web port. Prefer root scripts that start everything (npm run dev / turbo dev / nx run-many / pnpm -r dev). No & or nohup.',
    '- FULL-STACK rule: if the frontend proxies /api to a local backend (next.config rewrites, vite proxy, hardcoded localhost:PORT baseURL, separate server/ entry incl. Go go.mod), the serve step MUST start the backend first in the background (nohup) then the frontend in the foreground, e.g. `(cd server && nohup ./bin/server > /tmp/backend.log 2>&1 &) ; cd apps/web && npm start`. If the backend needs a DB, add prepare steps: ensure local PostgreSQL/MySQL at 127.0.0.1, create user/db from DATABASE_URL, run migrations. A frontend-only plan will be REJECTED by the platform API health check.',
    '- CRITICAL: commands run in ONE persistent bash. NEVER repeat `cd <dir>` across steps (working dir persists). Use `cd X && cmd` in a single step, or --prefix. No duplicate cd.',
    '- Keep steps minimal (2-4). Do NOT add steps for writing config files (those go in configFiles).',
].join(' ');

async function runTool(tool, args, runtimeRef, workspacePath) {
    const runtime = getRuntime();
    if (tool === 'list_dir') {
        const path = String(args.path || '.');
        try {
            const r = await runtime.exec.exec('sh', ['-c', `ls -laF ${shellQuote(path)} 2>&1 | head -120`], {}, { runtimeRef, cwd: workspacePath });
            return (r.stdout || '(empty)').slice(0, 4000);
        } catch (e) { return `(list error: ${e.message})`; }
    }
    if (tool === 'read_file') {
        const path = String(args.path || '');
        if (!path) return '(no path)';
        try {
            const c = await runtime.fs.fsRead(workspacePath, path, { runtimeRef, encoding: 'utf8' });
            return String(c || '').slice(0, 4000);
        } catch (e) { return `(read error: ${e.message})`; }
    }
    if (tool === 'run_check') {
        const cmd = String(args.cmd || '').trim();
        if (!ALLOWED_RUN_CHECK_PREFIX.some((p) => cmd.startsWith(p))) {
            return '(command not allowed — only read-only checks are permitted)';
        }
        try {
            const r = await runtime.exec.exec('sh', ['-c', `${cmd} 2>&1 | head -80`], {}, { runtimeRef, cwd: workspacePath });
            return String(r.stdout || '').slice(0, 4000);
        } catch (e) { return `(check error: ${e.message})`; }
    }
    return '(unknown tool)';
}

function tryParseJson(text) {
    let s = String(text || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

// Mirror of the regex inside runSelfCheck() — referenced from
// analyzeProjectDeploy() when falling back to a detectStack-built plan
// after opencode produced a fatally-wrong one (e.g. monorepo served
// with npx serve). Kept in sync manually; if you change the inner
// check, update this too.
const STATIC_SERVE_RE = /(?:npx\s+(?:--yes\s+)?serve\b|python3?\s+-m\s+http\.server)/i;

/**
 * Build a fallback plan from detectStack + stackToPreviewContract.
 * Replaces a fatally-wrong opencode plan (e.g. static-serve on a
 * monorepo) with a plan that actually starts the real frontend /
 * backend. Two-step layout:
 *   - step_1 (prepare): install dependencies at the project root
 *     (monorepo: this is what fills every workspace)
  *   - step_2 (serve): the resolved start command from the contract,
  *     with $PORT substituted for the real port
  *
  * @param {object} stack - detectStack() result
  * @param {{command:string,args:string[],port:number}} contract - stackToPreviewContract()
  * @param {string} [hostWorkspacePath] - host 端 workspace 路径；用于轻量探测
  *   项目是否需要 PG/Redis（.env / docker-compose 关键字），让 fallback plan 也能
  *   携带 needsPostgres/needsRedis 走 twoStage 并行 provision
  * @returns {{steps: any[], configFiles: any[], needsPostgres?: boolean, needsRedis?: boolean} | null}
  */
function detectBackendFlags(hostWorkspacePath) {
    if (!hostWorkspacePath) return { needsPostgres: false, needsRedis: false };
    let needsPostgres = false;
    let needsRedis = false;
    try {
        const fs = require('fs');
        const path = require('path');
        const candidates = ['.env', '.env.example', 'docker-compose.yml', 'docker-compose.yaml', 'docker-compose.deploy.yml', 'docker-compose.selfhost.yml'];
        const PG_RE = /postgres(?:ql)?:\/\/|POSTGRES_(?:HOST|DB|USER|PASSWORD|PORT)|DATABASE_URL/;
        const REDIS_RE = /redis:\/\/|REDIS_(?:HOST|URL|PORT|PASSWORD)|SESSION_.*REDIS|REDIS_URL/;
        const seen = new Set();
        // 根 + 浅层子目录（与 detectStack 探测范围一致，毫秒级纯文件读取）
        const dirs = [hostWorkspacePath, ...['server', 'api', 'backend', 'app', 'src'].map((d) => path.join(hostWorkspacePath, d))];
        for (const d of dirs) {
            for (const f of candidates) {
                const p = path.join(d, f);
                if (seen.has(p)) continue;
                seen.add(p);
                let content = null;
                try { content = fs.readFileSync(p, 'utf8'); } catch { continue; }
                if (!needsPostgres && PG_RE.test(content)) needsPostgres = true;
                if (!needsRedis && REDIS_RE.test(content)) needsRedis = true;
                if (needsPostgres && needsRedis) return { needsPostgres, needsRedis };
            }
        }
    } catch { /* ignore: 探测失败保持 false（不影响 fallback 计划生成） */ }
    return { needsPostgres, needsRedis };
}

function buildPlanFromDetectStack(stack, contract, hostWorkspacePath) {
    if (!stack || !contract || !contract.command) return null;
    if (!contract.args || !contract.args.length) return null;
    const steps = [];
    // Install: always at the project root, with the resolved package
    // manager. For monorepos this is what populates every workspace.
    if (stack.installCmd) {
        steps.push({
            id: 'step_1',
            name: 'Install dependencies',
            command: stack.installCmd,
            description: `Install packages with ${stack.packageManager || 'the package manager'}`,
            kind: 'prepare',
        });
    }
    // Build: only if the stack has a build step (most dev servers don't
    // need it; production stacks like Next.js sometimes do).
    if (stack.buildCmd) {
        steps.push({
            id: 'step_2',
            name: 'Build',
            command: stack.buildCmd,
            description: 'Production build',
            kind: 'prepare',
        });
    }
    // Serve: the resolved start command with $PORT replaced.
    const serveId = steps.length === 0 ? 'step_1' : `step_${steps.length + 1}`;
    const port = String(contract.port || 3000);
    const serveArgs = contract.args.map((a) => a.replace(/\$PORT/g, port));
    steps.push({
        id: serveId,
        name: 'Start app',
        command: contract.command,
        args: serveArgs,
        description: `Run on port ${port} (auto-detected from detectStack)`,
        kind: 'serve',
    });
    // 兜底计划也带上 needsPostgres/needsRedis：LLM 输出被 reject/override 时
    // 走 detectStack fallback，原路径丢失这两个字段会导致 twoStage 并行 provision
    // 永远跳过 PG，verify 阶段后端无 DB 报错（xensemble 实测：fallback plan
    // → needsPg=false → POST /api/v1/auth/login 500）。
    const flags = detectBackendFlags(hostWorkspacePath);
    return { steps, configFiles: [], ...flags };
}

async function analyzeProjectDeploy({ workspacePath, hostWorkspacePath, runtimeRef, isAborted }) {
    // 优先用 opencode（真正的 agent：LLM 自主探索项目 + 输出 JSON），失败 fallback 轻量 ReAct
    // opencode 跑在 host，需要 host workspace path（boxlite 下 /workspace 是 guest 路径，xensemble host 看不到）
    if (isAborted?.()) return { ok: false, aborted: true };
    const opencodeWs = hostWorkspacePath || workspacePath;
    const opencodeResult = await analyzeProjectWithOpencode(opencodeWs, isAborted);
    if (opencodeResult && opencodeResult.ok && opencodeResult.steps && opencodeResult.steps.length) {
        const normalized = { steps: normalizeSteps(opencodeResult.steps), configFiles: opencodeResult.configFiles || [] };
        // 一次性并行跑：结构自查（决定 plan 是否 fatal）+ guest 文件树扫描（供 stage B 复用）。
        // detectStack + detectBackendSignature 纯文件读取（< 100ms），结果决定要不要走兜底，
        // 自查本身只查工具链 / script 存在性 / cd 重复（不依赖项目结构）。
        const [check, guestCtx, detected, backendSig] = await Promise.all([
            runSelfCheck({ ...normalized, runtimeRef, workspacePath, hostWorkspacePath }),
            collectProjectContext(getRuntime().fs, workspacePath, runtimeRef).catch(() => null),
            Promise.resolve().then(() => detectStack(hostWorkspacePath || workspacePath)),
            Promise.resolve().then(() => detectBackendSignature(hostWorkspacePath || workspacePath)),
        ]);

        // 用结构（detected.startCmd / backendSig）做权威判断：LLM 的 plan 是否在用
        // 真实入口（不靠 STATIC_SERVE_RE 黑名单匹配命令名）。
        const structuralCheck = validatePlanAgainstProject(normalized.steps, detected, backendSig);
        // 把 structural fatal 与 regex-style fatal 合并（两者都让 plan 不可信）
        const allFatal = [...(check.fatal || []), ...structuralCheck.fatal];
        // LLM 出的 serve 步骤是否与 detected.startCmd 语义一致（normalizeCmdForCompare
        // 剥掉前导 cd / setpriv / --port 等修饰做等价比较）—— 这是 LLM plan 唯一的"通过"路径。
        const llmPlanMatchesDetected = detected && detected.startCmd && normalized.steps.some((s) => {
            if (!s || s.kind !== 'serve' || !s.command) return false;
            const n = normalizeCmdForCompare(s.command);
            const t = normalizeCmdForCompare(detected.startCmd);
            return n === t || n.endsWith(' ' + t) || n.startsWith(t + ' ') || n.includes(t);
        });

        // 兜底条件：detectStack 真的能出可用 plan（有 startCmd；若无 startCmd 则
        // stackToPreviewContract 会回退成 npx serve 静态服务器——那种情况不叫"能出可用
        // plan"，不应覆盖 LLM 的正确输出）。
        const detectedContract = stackToPreviewContract(detected);
        const canUseDetected = detectedContract && detectedContract.command && detected && detected.startCmd;

        // 决策树（优先级从高到低）：
        // 1. LLM plan 完全匹配 detected.startCmd → 用 LLM plan（保留 LLM 价值）
        // 2. 有 fatal（regex 或 structural）→ 强制用 detectStack fallback
        // 3. LLM plan 跟 detected.startCmd 不匹配但 detectStack 有 startCmd → 用 detectStack fallback
        // 4. detectStack 没有可用 plan → 用 LLM plan（heuristic 无解，保留 LLM 决定）
        if (llmPlanMatchesDetected && allFatal.length === 0) {
            // 路径 1：LLM 与 detected 一致且无 fatal → 保留 LLM plan
            return { ...normalized, source: 'opencode', checked: check.passed, contextTree: guestCtx?.treeText || null, ...(check.passed ? {} : { warning: `opencode plan passed structural check but self-check found ${check.issues.length} issue(s)` }) };
        }
        // 路径 2/3：有 fatal，或 LLM 与 detected 不一致 → detectStack 兜底
        const fallbackSource = allFatal.length > 0 ? 'opencode-rejected-detectstack' : 'detectstack-override';
        if (canUseDetected) {
            const detectPlan = buildPlanFromDetectStack(detected, detectedContract, hostWorkspacePath);
            if (detectPlan) {
                const why = allFatal.length > 0
                    ? `opencode plan rejected: ${allFatal.join('; ')}`
                    : `opencode plan doesn't use detected startCmd ("${detected.startCmd}"); using detectStack fallback`;
                console.error(`[analyzeDeploy] ${why}; falling back to detectStack: ${detectPlan.steps.map((s) => s.command).join(' | ')}`);
                return { ...detectPlan, source: fallbackSource, checked: true, contextTree: guestCtx?.treeText || null, warning: why };
            }
        }
        // 路径 4：detectStack 也无解（startCmd=null），保留 LLM plan + 警告
        return { ...normalized, source: 'opencode', checked: check.passed && allFatal.length === 0, contextTree: guestCtx?.treeText || null, warning: allFatal.length > 0 ? `opencode plan has fatal issues and detectStack produced no fallback: ${allFatal.join('; ')}` : '' };
    }

    const fsAdapter = getRuntime().fs;
    const { treeText, fileContentsText } = await collectProjectContext(fsAdapter, workspacePath, runtimeRef);

    if (!API_KEY) {
        return { steps: normalizeSteps(fallbackSteps(fileContentsText)), configFiles: [], source: 'fallback', contextTree: treeText };
    }

    // 后端签名证据：喂给 agent，让它第一遍就把后端启动写进计划（self-check 会强制校验）
    let backendNote = '';
    try {
        const backendSig = detectBackendSignature(hostWorkspacePath || workspacePath);
        if (backendSig.hasBackend) {
            backendNote = `\n\nDETERMINISTIC BACKEND SCAN (authoritative — self-check enforces this):\n${backendSig.evidence.map((e) => `- ${e}`).join('\n')}\n${backendSig.suggestCmd ? `Suggested backend start: \`${backendSig.suggestCmd}\`\n` : ''}The plan MUST include a serve step starting this backend. A frontend-only or static-serve plan will be REJECTED.`;
        }
    } catch { /* ignore */ }

    const messages = [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        {
            role: 'user',
            content: `Project workspace: /workspace (project root). Here is a preliminary file tree and some key files to help you start. Use the tools to explore deeper and understand the project fully, then output the deploy plan.\n\nFile tree:\n${treeText.slice(0, 12000)}\n\nKey files:\n${fileContentsText.slice(0, 20000)}${backendNote}`,
        },
    ];

    let lastResult = null;
    let prevToolSig = '';
    let repeatCount = 0;
    for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
        if (isAborted?.()) return { ok: false, aborted: true };
        const llmResult = await callLlm(messages);
        if (!llmResult.ok) {
            if (round === 0) {
                return { steps: normalizeSteps(fallbackSteps(fileContentsText)), configFiles: [], source: 'fallback', warning: llmResult.warning };
            }
            break;
        }
        const parsed = tryParseJson(llmResult.content);
        if (!parsed) {
            messages.push({ role: 'user', content: 'Your previous response was not valid JSON. Respond with ONLY valid JSON: either a single tool call {"action":"tool","tool":"...","args":{...}} or the final answer {"action":"final","result":{...}}.' });
            continue;
        }
        if (parsed.action === 'tool') {
            const sig = `${parsed.tool}:${JSON.stringify(parsed.args || {})}`;
            if (sig === prevToolSig) {
                repeatCount++;
                if (repeatCount >= 2) {
                    messages.push({ role: 'user', content: 'You just repeated the exact same tool call. That is not helping. STOP repeating. Use a different tool / different path, or output your final answer now: {"action":"final","result":{...}}.' });
                    prevToolSig = '';
                    repeatCount = 0;
                    continue;
                }
            } else {
                prevToolSig = sig;
                repeatCount = 0;
            }
            const out = await runTool(parsed.tool, parsed.args || {}, runtimeRef, workspacePath);
            messages.push({ role: 'user', content: `Tool "${parsed.tool}" result:\n${out}` });
            continue;
        }
        if (parsed.action === 'final') {
            const result = parseResponse(JSON.stringify(parsed.result || {}));
            if (result && result.steps.length) {
                lastResult = { steps: normalizeSteps(result.steps), configFiles: result.configFiles };
                const check = await runSelfCheck({ ...lastResult, runtimeRef, workspacePath, hostWorkspacePath });
                if (check.passed) {
                    return { ...lastResult, source: 'ai', checked: true };
                }
                messages.push({ role: 'user', content: `Self-check found issues in your final answer. Fix them and re-output the final answer JSON. Issues:\n${check.issues.join('\n')}` });
                continue;
            }
            messages.push({ role: 'user', content: 'Your final answer result was not valid (need steps + configFiles). Re-output {"action":"final","result":{...}} with valid steps.' });
            continue;
        }
        messages.push({ role: 'user', content: 'Unknown action. Respond with a single tool call or the final answer JSON.' });
    }

    return {
        ...(lastResult || { steps: normalizeSteps(fallbackSteps(fileContentsText)), configFiles: [] }),
        source: 'ai',
        checked: false,
        contextTree: treeText,
        ...(lastResult ? { warning: 'Agent could not produce a fully validated plan (max rounds reached)' } : { warning: 'Agent did not produce a plan; used fallback' }),
    };
}

module.exports = { analyzeProjectDeploy, collectProjectContext, runSelfCheck };
