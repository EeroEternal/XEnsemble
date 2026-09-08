const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const repositoryEnvironment = require('../repositories/RepositoryEnvironmentService');

const execFileAsync = promisify(execFile);

const AGENTS_DIR = '.agents';
const SETUP_SCRIPT = 'setup';
const SETUP_STATUS_FILE = 'setup-status.json';
const AGENTS_MD_FILE = 'AGENTS.md';
const AGENTS_MD_VERSION = 2;
const SETUP_TIMEOUT_MS = Number(process.env.AGENT_SETUP_TIMEOUT_MS || 600000);
const LOG_TAIL_MAX = 8000;

const DEFAULT_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Preview</title>
</head>
<body>
  <h1>Workspace ready</h1>
  <p>Edit files here, or run the two-stage deploy from the UI to bring up the full app stack.</p>
  <script>
  (function () {
    var params = new URLSearchParams(window.location.search);
    var token = params.get('preview_token');
    if (!token) return;
    function post(level, args) {
      fetch('__dev/console', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Preview-Token': token },
        body: JSON.stringify({ level: level, message: args.map(String).join(' ') })
      }).catch(function () {});
    }
    ['log', 'warn', 'error', 'info'].forEach(function (m) {
      var orig = console[m].bind(console);
      console[m] = function () {
        post(m, Array.prototype.slice.call(arguments));
        orig.apply(console, arguments);
      };
    });
  })();
  </script>
</body>
</html>
`;

const DEFAULT_SETUP_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
# XEnsemble workspace bootstrap — safe to re-run.
echo "[xensemble] workspace setup complete"
`;

function renderAgentsMd() {
    return `<!-- xensemble-agents-md v${AGENTS_MD_VERSION} -->
# XEnsemble workspace

This directory is managed by XEnsemble. Agents should not guess ports, login, setup state, or wake recovery.

## Sandbox

- Workspace root is your project files; \`.agents/\` holds platform hooks and metadata.
- Install extra tools with \`apt-get\` (BoxLite) or your stack's package manager when the runtime allows it.
- Session terminal I/O is persisted server-side as NDJSON under \`.transcript/\` (read-only from agent POV).

## Bootstrap (first run)

- Script: \`.agents/setup\` (idempotent)
- API: \`POST /api/v1/projects/:id/agents/setup\` — body \`{ "force": true }\` to re-run
- Status: \`.agents/setup-status.json\`

## Wake / resume (after idle-hibernate)

- Script: \`.agents/resume\` (idempotent) — runs automatically when a recoverable session wakes
- API: \`POST /api/v1/projects/:id/agents/resume\` — body \`{ "force": true }\` to re-run
- Status: \`.agents/resume-status.json\`
- Platform also calls ensure-preview server-side to restore dev preview

## Preflight

- \`GET /api/v1/projects/:id/preflight?agent_id=...\` — readiness JSON (secrets, gateway, LLM, preview, quotas, setup/resume)

## Preview

- Idempotent ensure: \`POST /api/v1/projects/:id/agents/ensure-preview\`
- Ports and URLs: \`.agents/ports.json\`
- Preview is delivered via the two-stage auto-deploy pipeline. The
  resolved start command is written to \`.agents/preview.json\` only
  after a successful deploy — there is no fallback \`npx serve\` stub.
  If you need a hand-written contract, write \`.agents/preview.json\`
  with \`{ command, args, port }\` and the LocalPreviewAdapter will use
  it as the lowest-priority override.

## Logs

- Aggregated dev logs: \`.agents/in/server.log\` — tags \`[preview]\`, \`[browser]\`
- Browser console: preview \`POST __dev/console\` (with preview token) or \`POST .../agents/log\`
`;
}

const DEFAULT_AGENTS_MD = renderAgentsMd();

function agentsDir(workspacePath) {
    return path.join(workspacePath, AGENTS_DIR);
}

function setupScriptPath(workspacePath) {
    return path.join(agentsDir(workspacePath), SETUP_SCRIPT);
}

function setupStatusPath(workspacePath) {
    return path.join(agentsDir(workspacePath), SETUP_STATUS_FILE);
}

function hashSetupContent(content) {
    return crypto.createHash('sha256').update(content || '').digest('hex');
}

function readSetupStatus(workspacePath) {
    const filePath = setupStatusPath(workspacePath);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function writeSetupStatus(workspacePath, payload) {
    const dir = agentsDir(workspacePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(setupStatusPath(workspacePath), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
}

function tailLog(text) {
    if (!text) return '';
    const s = String(text);
    return s.length <= LOG_TAIL_MAX ? s : s.slice(-LOG_TAIL_MAX);
}

function refreshAgentsMd(workspacePath) {
    const agentsMdPath = path.join(agentsDir(workspacePath), AGENTS_MD_FILE);
    if (!fs.existsSync(agentsMdPath)) {
        fs.writeFileSync(agentsMdPath, DEFAULT_AGENTS_MD, 'utf8');
        return;
    }
    const content = fs.readFileSync(agentsMdPath, 'utf8');
    const match = content.match(/<!-- xensemble-agents-md v(\d+) -->/);
    const currentVersion = match ? Number(match[1]) : 0;
    if (currentVersion < AGENTS_MD_VERSION) {
        fs.writeFileSync(agentsMdPath, DEFAULT_AGENTS_MD, 'utf8');
    }
}

/**
 * 0030：解析 git 排除文件路径（.git/info/exclude）。
 * - `.git` 是目录（普通仓库）→ `<git>/info/exclude`
 * - `.git` 是指针文件（worktree，内容 `gitdir: <path>`）→ 主仓库 `<path>/info/exclude`
 * - 无 `.git` → null（非 git 仓库，无污染顾虑）
 * 用 info/exclude 而非 .gitignore：它是仓库本地、永不提交、git status 永不显示，
 * 平台隐藏自有目录时不修改用户受跟踪的 .gitignore。
 */
function resolveGitExcludePath(workspacePath) {
    const gitPath = path.join(workspacePath, '.git');
    try {
        const st = fs.statSync(gitPath);
        if (st.isDirectory()) {
            return path.join(gitPath, 'info', 'exclude');
        }
        const content = fs.readFileSync(gitPath, 'utf8');
        const m = content.match(/^gitdir:\s*(.+)$/m);
        if (m) {
            const gitDir = path.resolve(workspacePath, m[1].trim());
            return path.join(gitDir, 'info', 'exclude');
        }
    } catch { /* no .git */ }
    return null;
}

/**
 * Idempotent: ensure workspace git ignore excludes platform-managed dirs.
 * Appends missing entries without removing existing content.
 *
 * 0030：优先写 `.git/info/exclude`（本地排除，不污染受跟踪的 .gitignore）；
 * 非 git 仓库回落 `.gitignore`（此时无 git 污染顾虑）。
 *
 * 0025（方案 B）：除 .agents/ 与 .xensemble/ 外，把全部 Agent 原生技能目录也加入忽略——
 * 技能落盘不污染用户 git changes（claude/qwen/codebuddy/kimi/pi/opencode/openclaw 等）。
 * 与 skillInjector 的 DEFAULT_AGENT_NATIVE_DIRS 保持同步。
 */
function ensureGitignoreEntries(workspacePath) {
    const entries = [
        '.agents/',
        '.xensemble/',
        // Agent 原生技能目录（平台注入，勿提交）
        '.claude/skills/',
        '.qwen/skills/',
        '.codebuddy/skills/',
        '.kimi-code/skills/',
        '.pi/skills/',
        '.opencode/skills/',
        '.agents/skills/',
        'skills/',
    ];

    // 0030：优先 .git/info/exclude（本地、不提交），避免改用户 .gitignore
    const excludePath = resolveGitExcludePath(workspacePath);
    const targetPath = excludePath || path.join(workspacePath, '.gitignore');

    let content = '';
    if (fs.existsSync(targetPath)) {
        content = fs.readFileSync(targetPath, 'utf8');
    }

    const existingLines = new Set(content.split('\n').map((l) => l.trim()));
    const missing = entries.filter((e) => !existingLines.has(e));
    if (missing.length === 0) return;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const block = `\n# XEnsemble platform metadata - do not commit\n${missing.join('\n')}\n`;
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(targetPath, content + prefix + block, 'utf8');
}

/**
 * Idempotent: seed `.agents/setup`, `AGENTS.md`, resume script, and preview contract files.
 */
function seedAgentWorkspaceFiles(workspacePath) {
    const dir = agentsDir(workspacePath);
    fs.mkdirSync(dir, { recursive: true });

    const setupPath = setupScriptPath(workspacePath);
    if (!fs.existsSync(setupPath)) {
        fs.writeFileSync(setupPath, DEFAULT_SETUP_SCRIPT, { mode: 0o755 });
    }

    refreshAgentsMd(workspacePath);

    const { seedResumeScript } = require('./agentResumeHook');
    seedResumeScript(workspacePath);
    // .agents/preview.json is NOT seeded here. Preview startup goes through
    // the two-stage auto-deploy pipeline (detectStack → LLM analysis →
    // start command), and writes the resolved contract as a side effect
    // of a successful deploy. Seeding an npx-serve fallback would mask
    // real project layout and produce a broken preview for monorepos.

    // Seed a starter index.html for empty workspaces so the preview
    // iframe isn't completely blank before the user has written any code.
    // Previously this lived in ensurePreviewContractFile(); moved here
    // because we no longer call that from bootstrap.
    const indexPath = path.join(workspacePath, 'index.html');
    if (!fs.existsSync(indexPath)) {
        const existingFiles = fs.readdirSync(workspacePath)
            .filter((n) => ![AGENTS_DIR, '.xensemble', '.git', '.gitignore'].includes(n));
        if (existingFiles.length === 0) {
            fs.writeFileSync(indexPath, DEFAULT_INDEX_HTML, 'utf8');
        }
    }
}

function shouldRunSetup(workspacePath, { force = false } = {}) {
    if (force) return true;
    const scriptPath = setupScriptPath(workspacePath);
    if (!fs.existsSync(scriptPath)) return false;

    const scriptHash = hashSetupContent(fs.readFileSync(scriptPath, 'utf8'));
    const prev = readSetupStatus(workspacePath);
    if (!prev) return true;
    if (prev.status !== 'completed' && prev.status !== 'skipped') return true;
    if (prev.setup_hash !== scriptHash) return true;
    return false;
}

async function runSetupScript(workspacePath, project) {
    const scriptPath = setupScriptPath(workspacePath);
    if (!fs.existsSync(scriptPath)) {
        return {
            status: 'skipped',
            exit_code: 0,
            setup_hash: null,
            log_tail: '',
            reason: 'no_setup_script',
        };
    }

    const setupHash = hashSetupContent(fs.readFileSync(scriptPath, 'utf8'));
    try {
        fs.chmodSync(scriptPath, 0o755);
    } catch {
        // best effort
    }

    const startedAt = Date.now();
    try {
        const { stdout, stderr } = await execFileAsync('/bin/bash', [scriptPath], {
            cwd: workspacePath,
            timeout: SETUP_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            env: {
                ...process.env,
                XENSEMBLE_WORKSPACE: workspacePath,
                XENSEMBLE_PROJECT_ID: project.id,
                XENSEMBLE_USER_ID: project.userId,
            },
        });
        return {
            status: 'completed',
            exit_code: 0,
            setup_hash: setupHash,
            log_tail: tailLog(`${stdout || ''}${stderr || ''}`),
            started_at: startedAt,
            finished_at: Date.now(),
        };
    } catch (err) {
        const stdout = err.stdout ? String(err.stdout) : '';
        const stderr = err.stderr ? String(err.stderr) : '';
        return {
            status: 'failed',
            exit_code: typeof err.code === 'number' ? err.code : 1,
            setup_hash: setupHash,
            log_tail: tailLog(`${stdout}${stderr}${err.message || ''}`),
            started_at: startedAt,
            finished_at: Date.now(),
        };
    }
}

/**
 * Run `.agents/setup` when needed and record snapshot metadata on success.
 * @returns {Promise<object>} setup-status payload
 */
async function ensureAgentBootstrap(project, workspacePath, options = {}) {
    seedAgentWorkspaceFiles(workspacePath);
    ensureGitignoreEntries(workspacePath);

    if (!shouldRunSetup(workspacePath, options)) {
        return readSetupStatus(workspacePath);
    }

    const result = await runSetupScript(workspacePath, project);
    let snapshotId = null;

    if (result.status === 'completed' || result.status === 'skipped') {
        const snap = await repositoryEnvironment.createSnapshot(project, {
            status: 'ready',
            storage_ref: `local:${workspacePath}`,
            build_log: result.log_tail || null,
        });
        snapshotId = snap.id;
    }

    return writeSetupStatus(workspacePath, {
        version: 1,
        status: result.status,
        exit_code: result.exit_code,
        setup_hash: result.setup_hash,
        snapshot_id: snapshotId,
        reason: result.reason || null,
        log_tail: result.log_tail || '',
        started_at: result.started_at || Date.now(),
        finished_at: result.finished_at || Date.now(),
    });
}

module.exports = {
    AGENTS_DIR,
    SETUP_SCRIPT,
    SETUP_STATUS_FILE,
    seedAgentWorkspaceFiles,
    ensureGitignoreEntries,
    shouldRunSetup,
    ensureAgentBootstrap,
    readSetupStatus,
    hashSetupContent,
};
