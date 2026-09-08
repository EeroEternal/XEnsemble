const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { detectBackendSignature } = require('./detectStack');

function resolveOpencodeBin() {
    if (process.env.OPENCODE_BIN && fs.existsSync(process.env.OPENCODE_BIN)) return process.env.OPENCODE_BIN;
    const candidates = ['/snap/bin/opencode', '/usr/local/bin/opencode', '/usr/bin/opencode'];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    try {
        const r = spawnSync('which', ['opencode'], { stdio: ['ignore', 'pipe', 'ignore'] });
        if (r.status === 0 && r.stdout.toString().trim()) return r.stdout.toString().trim();
    } catch { /* ignore */ }
    return 'opencode';
}

const OPENCODE_BIN = resolveOpencodeBin();
// 超时：opencode 探索大项目 + LLM 调用可能较慢，但 fallback（analyzeDeploy 内置 ReAct）
// 数十秒内也能出计划，因此这里不需要长等——超时后快速 fallback，避免"分析项目"长时间
// 无进展（AgentHarness 实测 opencode 卡满 480s）。
const PROMPT_TIMEOUT_MS = Number(process.env.OPENCODE_ANALYZE_TIMEOUT_MS) || 240000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MARKER_START = '__DEPLOY_PLAN_START__';
const MARKER_END = '__DEPLOY_PLAN_END__';

function buildPrompt(workspacePath) {
    return [
        'You are a deployment analysis agent. Your job: analyze the project at the current working directory and produce a complete deploy plan that brings up the full stack (frontend + backend).',
        '',
        'Tasks:',
        '1. Explore the project (read package.json, monorepo config, .env* files, scripts, etc.) to understand the tech stack, monorepo layout (workspaces/lerna/nx/turbo/pnpm-workspaces), frontend vs backend split (web/ client/ server/ api/ apps/* packages/*), package manager, dev/preview scripts, ports, and ALL configuration files needing user input (.env, .env.example, config.*, application.*, settings.*).',
        '2. FULL-STACK integration is mandatory. Detect frontend→backend wiring: next.config.js rewrites/destination to localhost:PORT, vite.config proxy, hardcoded fetch/axios baseURL like http://localhost:8080, or a separate server/ / api/ dir (Node, Go go.mod, Python FastAPI/Flask, Java). If found, the plan MUST build AND start that backend — a frontend-only plan makes every browser page blank (API 5xx → white screen) and will be REJECTED by the platform health check, which probes API endpoints in addition to the root page.',
        '3. Serve step pattern (EXACTLY ONE serve step): start the backend in the background FIRST, then run the frontend in the foreground, e.g. `(cd server && nohup ./bin/server > /tmp/backend.log 2>&1 &) ; cd apps/web && npm start`. For root scripts that already start both (turbo run dev / pnpm -r dev / concurrently), just use them. The backend port must match what the frontend proxies to.',
        '4. Database: if the backend needs PostgreSQL/MySQL (DATABASE_URL, pgx, prisma,gorm, docker-compose db service), include a prepare step to ensure the DB is running locally (the platform usually pre-provisions PostgreSQL at 127.0.0.1:5432 — service postgresql start; else apt-get install -y postgresql) with host forced to 127.0.0.1, plus a migrate step (goose/migrate/prisma migrate/psql -f schema.sql). Never point the app at a remote DB.',
        '5. If there are native deps that need building (node-pty, sqlite3, bcrypt, sharp, prisma), the FIRST prepare step should be `apt-get update && apt-get install -y python3 build-essential`.',
        '6. The serve step must bring up the full app. Use $PORT for the web port. Do not suffix the FRONTEND with & or nohup.',
        '7. CRITICAL: commands run in ONE persistent bash. NEVER repeat `cd <dir>` across steps (working dir persists). Use `cd X && cmd` in ONE step, or --prefix.',
        '8. opencode.json in the project root is a tool config file — ignore it, do not analyze it or include it in configFiles.',
        '',
        `Project workspace: ${workspacePath}`,
        '',
        'Output STRICTLY in this format (NO other text outside markers, NO markdown fences, NO explanation):',
        '',
        MARKER_START,
        JSON.stringify({
            configFiles: [{ path: '.env', template: '<full file content>', description: '<bullet>', keys: ['K1'] }],
            steps: [{ id: 'step_1', name: '...', command: '...', description: '...', kind: 'prepare' }],
        }, null, 2),
        MARKER_END,
    ].join('\n');
}

// opencode 1.18.x ignores OPENAI_BASE_URL / OPENAI_MODEL env. The reliable way to point it at an
// OpenAI-compatible endpoint with a chosen model is a project-root opencode.json provider +
// `--model <provider>/<model>`. We generate that file here (restoring any pre-existing file after).
function buildOpencodeConfig() {
    const baseURL = process.env.LLM_ANALYZE_API_URL || process.env.OPENAI_BASE_URL;
    const apiKey = process.env.LLM_ANALYZE_API_KEY || process.env.OPENAI_API_KEY;
    const model = process.env.LLM_ANALYZE_MODEL || process.env.OPENAI_MODEL || 'deepseek-chat';
    if (!baseURL || !apiKey || !model) return null;
    const base = baseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
    const models = {};
    for (const m of new Set([model, process.env.LLM_VERIFY_MODEL, process.env.OPENAI_MODEL].filter(Boolean))) {
        models[m] = { name: m };
    }
    // 让 opencode 探索时跳过依赖/构建产物目录：agent 只需读源码生成计划，
    // node_modules/.pnpm-store 等动辄数百 MB、几万文件，遍历会让分析超时
    // （AgentHarness monorepo 实测：stage A opencode 卡满 480s 超时）。
    const ignore = [
        '**/node_modules/**', '**/.pnpm-store/**', '**/.git/**',
        '**/dist/**', '**/build/**', '**/.next/**', '**/out/**', '**/coverage/**',
        '**/target/**', '**/__pycache__/**', '**/.venv/**', '**/venv/**',
        '**/.cache/**', '**/.turbo/**', '**/.nx/**', '**/.yarn/**', '**/.pnp.*',
        '**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock',
    ];
    return {
        provider: {
            xensemble: {
                npm: '@ai-sdk/openai-compatible',
                name: 'XEnsemble OpenAI-compatible',
                options: { baseURL: base, apiKey },
                models,
            },
        },
        ignore,
    };
}

function stripAnsi(s) {
    return String(s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

function extractPlan(stdout) {
    const clean = stripAnsi(stdout);
    const m = clean.match(new RegExp(MARKER_START + '\\s*([\\s\\S]*?)\\s*' + MARKER_END));
    if (!m) return null;
    let raw = m[1].trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    return raw;
}

function parsePlan(raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
        const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
        if (s === -1 || e === -1) return null;
        try { parsed = JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
    }
    const steps = Array.isArray(parsed) ? parsed : parsed.steps;
    if (!Array.isArray(steps) || !steps.length) return null;
    const configFiles = Array.isArray(parsed.configFiles)
        ? parsed.configFiles.map((c) => ({
            path: String(c.path || '').slice(0, 200),
            template: String(c.template || '').slice(0, 10000),
            description: String(c.description || '').slice(0, 500),
            keys: Array.isArray(c.keys) ? c.keys.map((k) => String(k).slice(0, 100)) : undefined,
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
    };
}

async function analyzeProjectWithOpencode(workspacePath, isAborted) {
    if (!workspacePath) return null;
    const cfg = buildOpencodeConfig();
    if (!cfg) {
        return { ok: false, warning: 'opencode LLM config missing (need LLM_ANALYZE_API_URL + LLM_ANALYZE_API_KEY + LLM_ANALYZE_MODEL)' };
    }
    const modelName = process.env.LLM_ANALYZE_MODEL || process.env.OPENAI_MODEL || 'deepseek-chat';
    const cfgPath = path.join(workspacePath, 'opencode.json');
    let prevCfg = null;
    let cfgWritten = false;
    try {
        if (fs.existsSync(cfgPath)) prevCfg = fs.readFileSync(cfgPath, 'utf8');
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        cfgWritten = true;
    } catch (e) {
        return { ok: false, warning: `could not write opencode config: ${e.message}` };
    }
    const cleanup = () => {
        if (!cfgWritten) return;
        try {
            if (prevCfg != null) fs.writeFileSync(cfgPath, prevCfg);
            else fs.rmSync(cfgPath, { force: true });
        } catch { /* ignore */ }
    };
    const env = {
        ...process.env,
        // opencode is node-based; give it lots of heap so V8 does not OOM exploring big repos
        NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --max-old-space-size=6144',
        NO_COLOR: '1',
        TERM: 'dumb',
    };
    // 后端签名证据注入：确定性扫描的结果作为权威上下文喂给 LLM，
    // 让它第一遍就把"启动后端"写进计划（否则 self-check 会拒掉重来，多花一轮）。
    let prompt = buildPrompt(workspacePath);
    try {
        const backendSig = detectBackendSignature(workspacePath);
        if (backendSig.hasBackend) {
            prompt += `\n\nDETERMINISTIC BACKEND SCAN (authoritative — the platform self-check enforces this):\n${backendSig.evidence.map((e) => `- ${e}`).join('\n')}\n${backendSig.suggestCmd ? `Suggested backend start: \`${backendSig.suggestCmd}\`\n` : ''}Your plan MUST include a serve step starting this backend (start it in the background, then run the frontend in the foreground). A frontend-only plan or a static-serve plan (npx serve / python3 -m http.server) will be REJECTED and replaced by a heuristic plan.`;
        }
    } catch { /* 扫描失败不影响分析流程 */ }
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let resolved = false;
        const child = spawn(OPENCODE_BIN, ['run', '--auto', '--model', `xensemble/${modelName}`, prompt], {
            cwd: workspacePath,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const finish = (payload) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            clearInterval(abortTimer);
            cleanup();
            resolve(payload);
        };
        const timer = setTimeout(() => {
            console.error(`[analyzeOpencode] TIMEOUT after ${PROMPT_TIMEOUT_MS}ms (stdout tail: ${stripAnsi(stdout).slice(-400)}, stderr tail: ${stripAnsi(stderr).slice(-400)})`);
            finish({ ok: false, warning: 'opencode run timeout' });
            child.kill('SIGTERM');
        }, PROMPT_TIMEOUT_MS);
        // 中止部署：定期检查 isAborted，立即 kill opencode（阶段 1 也能中止）
        const abortTimer = setInterval(() => {
            if (resolved || !isAborted?.()) return;
            finish({ ok: false, aborted: true });
            child.kill('SIGKILL');
        }, 800);
        child.stdout.on('data', (d) => {
            if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString();
        });
        child.stderr.on('data', (d) => {
            if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString();
        });
        child.on('error', (err) => {
            finish({ ok: false, warning: `opencode spawn failed: ${err.message}` });
        });
        child.on('exit', (code) => {
            const raw = extractPlan(stdout) || extractPlan(stderr);
            if (!raw) {
                return finish({ ok: false, warning: `opencode exit ${code}, no markers in output (stdout tail: ${stdout.slice(-200)}, stderr tail: ${stderr.slice(-200)})` });
            }
            const parsed = parsePlan(raw);
            if (!parsed) {
                return finish({ ok: false, warning: `opencode exit ${code}, failed to parse plan JSON` });
            }
            finish({ ok: true, source: 'opencode', steps: parsed.steps, configFiles: parsed.configFiles });
        });
    });
}

module.exports = { analyzeProjectWithOpencode };
