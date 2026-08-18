const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
const PROMPT_TIMEOUT_MS = Number(process.env.OPENCODE_ANALYZE_TIMEOUT_MS) || 480000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MARKER_START = '__DEPLOY_PLAN_START__';
const MARKER_END = '__DEPLOY_PLAN_END__';

function buildPrompt(workspacePath) {
    return [
        'You are a deployment analysis agent. Your job: analyze the project at the current working directory and produce a complete deploy plan that brings up the full stack (frontend + backend).',
        '',
        'Tasks:',
        '1. Explore the project (read package.json, monorepo config, .env* files, scripts, etc.) to understand the tech stack, monorepo layout (workspaces/lerna/nx/turbo/pnpm-workspaces), frontend vs backend split (web/ client/ server/ api/ apps/* packages/*), package manager, dev/preview scripts, ports, and ALL configuration files needing user input (.env, .env.example, config.*, application.*, settings.*).',
        '2. If there are native deps that need building (node-pty, sqlite3, bcrypt, sharp, prisma), the FIRST prepare step should be `apt-get update && apt-get install -y python3 build-essential`.',
        '3. The serve step must bring up the full app. Prefer root scripts (npm run dev / turbo run dev / nx run-many / pnpm -r dev). Use $PORT for the web port. Do not suffix with & or nohup.',
        '4. CRITICAL: commands run in ONE persistent bash. NEVER repeat `cd <dir>` across steps (working dir persists). Use `cd X && cmd` in ONE step, or --prefix.',
        '5. opencode.json in the project root is a tool config file — ignore it, do not analyze it or include it in configFiles.',
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
    return {
        provider: {
            xensemble: {
                npm: '@ai-sdk/openai-compatible',
                name: 'XEnsemble OpenAI-compatible',
                options: { baseURL: base, apiKey },
                models,
            },
        },
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

async function analyzeProjectWithOpencode(workspacePath) {
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
    const prompt = buildPrompt(workspacePath);
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let resolved = false;
        const child = spawn(OPENCODE_BIN, ['run', '--auto', '--model', `xensemble/${modelName}`, prompt], {
            cwd: workspacePath,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            cleanup();
            child.kill('SIGTERM');
            resolve({ ok: false, warning: 'opencode run timeout' });
        }, PROMPT_TIMEOUT_MS);
        child.stdout.on('data', (d) => {
            if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString();
        });
        child.stderr.on('data', (d) => {
            if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString();
        });
        child.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            cleanup();
            resolve({ ok: false, warning: `opencode spawn failed: ${err.message}` });
        });
        child.on('exit', (code) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            cleanup();
            const raw = extractPlan(stdout) || extractPlan(stderr);
            if (!raw) {
                return resolve({ ok: false, warning: `opencode exit ${code}, no markers in output (stdout tail: ${stdout.slice(-200)}, stderr tail: ${stderr.slice(-200)})` });
            }
            const parsed = parsePlan(raw);
            if (!parsed) {
                return resolve({ ok: false, warning: `opencode exit ${code}, failed to parse plan JSON` });
            }
            resolve({ ok: true, source: 'opencode', steps: parsed.steps, configFiles: parsed.configFiles });
        });
    });
}

module.exports = { analyzeProjectWithOpencode };
