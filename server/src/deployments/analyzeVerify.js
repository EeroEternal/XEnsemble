// Stage-2 verification agent (two-stage auto-deploy).
//   The plan from stage 1 is executed for REAL inside the sandbox VM (guest), and a
//   ReAct agent (LLM = LLM_VERIFY_MODEL, same endpoint as stage 1) drives install /
//   build / serve / health-check, self-healing via edit_file + run_shell until tests pass.
//   Uses runtime.exec / runtime.fs so every command runs in the guest, not on the host.
//   Returns { ok, source, tested, finalStderr, warning } for twoStage.js to consume.

const { getRuntime } = require('../runtime/registry');

const API_KEY = process.env.LLM_ANALYZE_API_KEY;
const API_URL = process.env.LLM_ANALYZE_API_URL || 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.LLM_VERIFY_MODEL || process.env.LLM_ANALYZE_MODEL || 'deepseek-chat';
const LLM_TIMEOUT_MS = 240000;
const MAX_AGENT_ROUNDS = Number(process.env.OPENCODE_VERIFY_MAX_ROUNDS) || 60;
const MAX_TOOL_OUTPUT = 6000;
const SHELL_TIMEOUT_MS = 240000;

const LLM_RETRIES = 2;

// 对 LLM API 的瞬时故障（5xx / 429 / 网络错误）自动重试，避免一次网关抖动直接让部署失败。
async function callLlm(messages) {
    let lastWarning = '';
    for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
        try {
            const res = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
                body: JSON.stringify({ model: MODEL, messages, max_tokens: 16000, temperature: 0.2, response_format: { type: 'json_object' } }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                lastWarning = `LLM error ${res.status}: ${text.slice(0, 160)}`;
                if ((res.status >= 500 || res.status === 429) && attempt < LLM_RETRIES) {
                    console.error(`[analyzeVerify] LLM error ${res.status}, retry ${attempt + 1}/${LLM_RETRIES}`);
                    await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 4000));
                    continue;
                }
                return { ok: false, warning: lastWarning };
            }
            const data = await res.json();
            const choice = data.choices?.[0];
            const content = choice?.message?.content;
            console.error('[analyzeVerify] model:', MODEL, 'finish_reason:', choice?.finish_reason, 'usage:', JSON.stringify(data.usage), 'content_len:', String(content || '').length);
            return { ok: true, content, finishReason: choice?.finish_reason };
        } catch (e) {
            lastWarning = `LLM unavailable: ${e.message}`;
            if (attempt < LLM_RETRIES) {
                console.error(`[analyzeVerify] LLM unavailable (${e.message}), retry ${attempt + 1}/${LLM_RETRIES}`);
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

function summarizeArgs(args) {
    const out = {};
    for (const [k, v] of Object.entries(args || {})) {
        out[k] = typeof v === 'string' ? (v.length > 80 ? `${v.slice(0, 80)}…` : v) : v;
    }
    return out;
}

function summarize(s, max = 160) {
    const t = String(s || '');
    return t.length > max ? `${t.slice(0, max)}…(+${t.length - max} chars)` : t;
}

// 控制上下文体积：消息过多时只保留 system + 最近的 N 条，中间的超长工具输出压缩为摘要，
// 防止上下文无限膨胀导致模型输出失控（超长截断）。
function trimContext(messages, keep = 40) {
    if (messages.length <= keep + 2) return messages;
    const head = [messages[0]];
    const recent = messages.slice(-keep);
    const middle = messages.slice(1, -keep).map((m) => {
        if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Tool ')) {
            return { role: 'user', content: `${m.content.slice(0, 300)}…(summarized)` };
        }
        return m;
    });
    return [...head, ...middle, ...recent];
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

function shellQuote(s) {
    return `'${String(s).replace(/'/g, "'\\''")}'`;
}

async function runTool(tool, args, runtimeRef, workspacePath) {
    const runtime = getRuntime();
    try {
        if (tool === 'list_dir') {
            const path = String(args.path || '.');
            const r = await runtime.exec.exec('sh', ['-c', `ls -laF ${shellQuote(path)} 2>&1 | head -120`], {}, { runtimeRef, cwd: workspacePath });
            return (r.stdout || '(empty)').slice(0, MAX_TOOL_OUTPUT);
        }
        if (tool === 'read_file') {
            const path = String(args.path || '');
            if (!path) return '(no path)';
            const c = await runtime.fs.fsRead(workspacePath, path, { runtimeRef, encoding: 'utf8' });
            return String(c || '').slice(0, MAX_TOOL_OUTPUT);
        }
        if (tool === 'edit_file') {
            const path = String(args.path || '');
            const content = String(args.content == null ? '' : args.content);
            if (!path) return '(no path)';
            if (path.includes('..')) return '(invalid path)';
            if (content.length > 200000) return '(content too large, max 200000 bytes)';
            await runtime.fs.fsWrite(workspacePath, path, content, { runtimeRef });
            return `wrote ${content.length} bytes to ${path}`;
        }
        if (tool === 'run_shell') {
            const cmd = String(args.cmd || '').trim();
            if (!cmd) return '(no command)';
            if (cmd.length > 4000) return '(command too long, max 4000 chars)';
            // Capture the REAL exit code: piping through head would otherwise mask it with head's own status.
            const wrapped = `${cmd} > /tmp/_vt.log 2>&1; ec=$?; head -200 /tmp/_vt.log; echo "__EXIT_CODE__=\${ec}"`;
            const r = await runtime.exec.exec('sh', ['-c', wrapped], {}, {
                runtimeRef, cwd: workspacePath, maxBuffer: 4 * 1024 * 1024, timeoutMs: SHELL_TIMEOUT_MS,
            });
            let out = String(r.stdout || '');
            let ec = r.exitCode;
            const m = out.match(/__EXIT_CODE__=(-?\d+)/);
            if (m) {
                ec = parseInt(m[1], 10);
                out = out.replace(/__EXIT_CODE__=-?\d+\s*$/, '').replace(/__EXIT_CODE__=-?\d+\s*/g, '');
            }
            return `exit=${ec}\n${(out || '(no output)').slice(0, MAX_TOOL_OUTPUT)}`;
        }
        return '(unknown tool)';
    } catch (e) {
        return `(tool error: ${e.message})`;
    }
}

// 目录列表/源码树页面特征（python http.server 的 "Directory listing for"，及 serve 等的 "Index of"）。
function isDirectoryListing(body) {
    return /<title>\s*Index of\b/i.test(body)
        || /<title>\s*Directory listing for\b/i.test(body)
        || /\bIndex of \//.test(body)
        || /\bDirectory listing for \//.test(body);
}

// box 沙箱默认预览页特征（guest 常驻的 "Workspace ready" 页，不是用户应用）。
function isBoxDefaultPage(body) {
    return /Workspace ready/.test(body) && /Edit files here/.test(body);
}

// 单端口探测：curl 一个端口，判定是否为"真实应用内容"。
// boxDefaultPorts: box 沙箱常驻默认预览端口的集合（[3000, 5173]）。其中：
//   - 5173 是 box 的默认 preview 服务（preview.json 的 serve . --listen 5173），常驻且
//     verify 的 pkill npx serve 杀不掉，应用几乎不可能监听它 → 无条件排除，避免误选
//     box 默认页/workspace 根内容为 appPort；
//   - 3000 是 box 欢迎页常驻端口，但 agent 也可能把应用 serve 到 3000，因此仅当内容
//     确为默认欢迎页时才排除。
async function probePort({ runtimeRef, workspacePath, port, boxDefaultPorts }) {
    const runtime = getRuntime();
    try {
        const r = await runtime.exec.exec(
            'sh',
            ['-c', `curl -s -m 2 -w "\\n__HTTPCODE__:%{http_code}" http://127.0.0.1:${port}/ | head -c 3000`],
            {},
            { runtimeRef, cwd: workspacePath, timeoutMs: 6000 },
        );
        const out = String(r.stdout || '');
        const codeMatch = out.match(/__HTTPCODE__:(\d{3})/);
        const httpCode = codeMatch ? codeMatch[1] : '000';
        const body = out.replace(/__HTTPCODE__:\d{3}/, '').trim();
        if (httpCode === '000') {
            return { ok: false, listen: false, reason: `端口 ${port} 连不上` };
        }
        if (!httpCode.startsWith('2') && !httpCode.startsWith('3')) {
            return { ok: false, listen: true, reason: `端口 ${port} HTTP ${httpCode}` };
        }
        if (isDirectoryListing(body)) {
            return { ok: false, listen: true, reason: `端口 ${port} 是目录列表` };
        }
        if (port === 5173 || (boxDefaultPorts.includes(port) && isBoxDefaultPage(body))) {
            return { ok: false, listen: true, reason: `端口 ${port} 是沙箱默认页` };
        }
        if (!body) {
            return { ok: false, listen: true, reason: `端口 ${port} 空响应` };
        }
        return { ok: true, httpCode, snippet: body.slice(0, 120) };
    } catch (e) {
        return { ok: false, listen: false, reason: `端口 ${port} 探测失败: ${e.message}` };
    }
}

// 系统侧独立健康检查（多端口）：verify agent 声称 ok 后，扫描 guest 实际监听端口，
// 找到"真正 serve 应用内容"的端口（排除目录列表 / 空页 / box 默认页 / 源码树），
// 并返回该端口供 preview tunnel 使用。agent 用哪个端口运行不写死，灵活处理端口占用。
async function assertAppIsServed({ runtimeRef, workspacePath, preferredPort }) {
    const runtime = getRuntime();
    const preferred = Number(preferredPort) || 0;
    let listenPorts = [];
    // 优先用 ss；blink guest 里 ss 常不可用，退回 /proc/net/tcp（不依赖 ss）。
    try {
        const r = await runtime.exec.exec(
            'sh',
            ['-c', 'ss -tln 2>/dev/null | awk \'{print $4}\' | grep -oE \":[0-9]+$\" | cut -d: -f2 | sort -un | head -60'],
            {},
            { runtimeRef, cwd: workspacePath, timeoutMs: 10000 },
        );
        listenPorts = (r.stdout || '').split('\n').map((s) => Number(s)).filter((n) => n > 0 && n < 65535);
    } catch { /* ss unavailable */ }
    if (!listenPorts.length) {
        try {
            // /proc/net/tcp: st=0A 是 LISTEN；local_address 端口为十六进制（如 0F30 = 3888）。
            const r = await runtime.exec.exec(
                'sh',
                ['-c', 'awk \'function h2d(h,i,c,v,r){r=0;for(i=1;i<=length(h);i++){c=tolower(substr(h,i,1));v=(c~/[0-9]/)?c:index("abcdef",c)+9;r=r*16+v;}return r;} NR>1 && $4=="0A" {split($2,a,":"); print h2d(a[2])}\' /proc/net/tcp 2>/dev/null | sort -un | head -60'],
                {},
                { runtimeRef, cwd: workspacePath, timeoutMs: 10000 },
            );
            listenPorts = (r.stdout || '').split('\n').map((s) => Number(s)).filter((n) => n > 0 && n < 65535);
        } catch { /* ignore */ }
    }
    // 常见应用端口，用于给真实监听端口的探测排序（preferred 排最前，其余常见端口次之）。
    const commonPorts = [3000, 3888, 3889, 5173, 4173, 8080, 8000, 9000, 5000, 3001, 4000, 8081];
    // box 沙箱常驻默认预览端口：3000（欢迎页）与 5173（preview.json serve . --listen 5173）。
    const boxDefaultPorts = [Number(process.env.BOXLITE_DEFAULT_PREVIEW_PORT || 3000), 5173];
    const errors = [];
    const probeDetail = [];

    const probeLoop = async (ports) => {
        for (const port of ports) {
            const res = await probePort({ runtimeRef, workspacePath, port, boxDefaultPorts });
            probeDetail.push(`${port}=${res.httpCode || (res.listen ? 'listen' : 'down')}${res.ok ? '(app)' : ''}`);
            if (res.ok) {
                return { ok: true, port, httpCode: res.httpCode, snippet: res.snippet };
            }
            if (res.listen) errors.push(res.reason);
        }
        return null;
    };

    // 收敛：优先只探测真实监听的端口（避免对 down 端口空 curl 等待），
    // 顺序 preferred → 监听中的常见端口 → 其余监听端口。
    if (listenPorts.length) {
        const listened = new Set(listenPorts);
        const ordered = [];
        if (preferred && listened.has(preferred)) ordered.push(preferred);
        for (const p of commonPorts) {
            if (p !== preferred && listened.has(p)) ordered.push(p);
        }
        for (const p of [...listenPorts].sort((a, b) => a - b)) {
            if (!ordered.includes(p)) ordered.push(p);
        }
        const hit = await probeLoop(ordered);
        if (hit) return hit;
    } else {
        // 保底：ss + /proc/net/tcp 都拿不到监听端口时，回退全量 base 探测（curl 已收窄 2s）。
        const base = [...new Set([preferred, ...commonPorts])];
        const hit = await probeLoop(base);
        if (hit) return hit;
    }
    console.error(`[analyzeVerify] app port discovery failed. listenPorts=${JSON.stringify(listenPorts)} probes=${probeDetail.join(', ')} errors=${errors.join('; ')}`);
    return { ok: false, reason: errors.length ? `未发现真实应用端口（${errors.join('；')}）` : '未发现监听的应用端口' };
}

function buildSystemPrompt(plan) {
    const stepsJson = JSON.stringify(plan?.steps || [], null, 2);
    return [
        'You are a deployment verification agent running inside a sandbox Linux VM. Your job: execute a deploy plan for a project at /workspace, make the app actually pass a health check, and fix problems yourself until it works.',
        'Environment: Linux sandbox with node/npm/pnpm/yarn, python3/pip, go, cargo, curl. The project root is /workspace.',
        'Tools (respond with EXACTLY ONE tool call or the final answer, as valid JSON, no markdown fences):',
        '1. {"action":"tool","tool":"list_dir","args":{"path":"."}} — list a directory (relative to /workspace; "." for root).',
        '2. {"action":"tool","tool":"read_file","args":{"path":"package.json"}} — read a file.',
        '3. {"action":"tool","tool":"edit_file","args":{"path":"server/.env","content":"<full new file content>"}} — overwrite a file (creates missing dirs). Used to fix configs, scripts, missing files.',
        '4. {"action":"tool","tool":"run_shell","args":{"cmd":"npm install"}} — run a shell command in /workspace and see exit code + output. Use for install/build/start/test/curl.',
        'CRITICAL execution rules:',
        '- Every run_shell call is a FRESH shell (working dir resets to /workspace each time). Use `cd <dir> && <cmd>` inside ONE call when you need a subdirectory. Background processes started with `&` keep running in the VM.',
        '- The serve command must start the app in the background and stay running. Use e.g. `export PORT=<port>; (cd server && npm start) > /tmp/serve.log 2>&1 & sleep 5; cat /tmp/serve.log`, then health-check with curl.',
        '- Keep the serve process alive even after your shell exits: start it with nohup / setsid and disown. Pick any free port (export PORT=<port> if the app reads it; prefer the default port when free) — the platform auto-detects the real app port for the preview, so do not waste rounds fighting over one specific port.',
        '- Verify with an actual HTTP request, not just "process started": `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/`. A 2xx/3xx/expected response means success.',
        '- When a command fails, DO NOT just rerun it. Read the error, inspect files (read_file/list_dir), fix the root cause (edit_file), then retry.',
        'Deploy plan to execute:',
        JSON.stringify(plan?.steps || [], null, 2),
        '',
        'Config files to create/verify (from analysis; create/overwrite with edit_file as needed):',
        JSON.stringify(plan?.configFiles || [], null, 2),
        '',
        'Project structure (from analysis — DO NOT re-explore):',
        (plan?.context?.tree || '(none)'),
        '',
        'DEPENDENCY CACHE:',
        (plan?.context?.depsCached
            ? '- The workspace already has node_modules installed and its package-manager lockfile is unchanged from the previous deploy. SKIP the install step and go straight to build/serve. Only reinstall if a later step actually fails with a missing-dependency error.'
            : '- Dependencies are NOT cached — run the install step normally.'
        ),
        '',
        'IMPORTANT: The project has already been analyzed — structure, configs, the plan, and the project tree above are all provided. DO NOT call list_dir / read_file to explore the project or re-read files already covered (package.json, README, configs, server files). Execute the plan steps directly. Read a specific file ONLY if a step fails and you need its exact contents to fix it — never to re-discover what is already described above.',
        '',
        'Workflow:',
        '1. Run the prepare steps one by one (install deps, build, migrate, prisma generate, etc.). If the project needs native build deps, `apt-get update && apt-get install -y python3 build-essential` first.',
        '2. Start the full app (frontend + backend) on a port, then CONFIRM it is actually up with ONE curl: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/`. If it is 2xx/3xx, output your final answer IMMEDIATELY — do NOT curl the same port again.',
        '3. If you also see a `npm test` / test script that is quick, run it too and count it as tested.',
        '4. When a health check fails, READ the app log / error output to find the ROOT CAUSE (port in use, missing env/config, build or startup error) and fix it with edit_file / correct command — do not blindly rerun the same thing or keep checking the process. Iterate until the health check passes.',
        'OUTPUT SIZE RULE (MANDATORY): a TOOL CALL must be ONE compact JSON under 800 characters. NEVER paste file contents, logs or commands into your JSON — use read_file / edit_file / run_shell tools for that. If you were about to write a long reply, STOP and output the short JSON tool call instead. The FINAL answer may be up to 4000 characters so you can include the key error output in finalStderr.',
        'HEALTH CHECK (MANDATORY):',
        '- Confirm the app is up with ONE successful curl (2xx/3xx). Then IMMEDIATELY output your final answer.',
        '- Never curl / pgrep / ps the same port repeatedly. Repeating curls wastes rounds — once a single 2xx/3xx curl succeeds, the platform performs the final port discovery and health verification itself.',
        '- If a curl fails, do NOT just curl again — read the log, fix the root cause, restart if needed, then curl ONCE to confirm.',
        'SERVING RULES (MANDATORY):',
        '- Exception for plain static sites: IF the project really is a static site — its root has a NON-EMPTY index.html and there is NO package.json / build tooling / backend — then serving that directory is CORRECT (e.g. `python3 -m http.server` or `npx serve .`). This is the ONLY case where serving a workspace dir is allowed.',
        '- In EVERY other case: NEVER serve the raw workspace root or source directories (no `npx serve .`, `serve -s .`, `python3 -m http.server`, `caddy file-server` at /workspace or inside src/). That would expose source code and is a FAILURE. Serve ONLY a built artifact directory (e.g. `web/dist`, `build/`, `out/`) or the real app entry; for a monorepo, build and serve the frontend app under the correct subdir, and start the backend too when present.',
        '- The sandbox may already run its OWN placeholder services on ports 3000 and 5173 — they are NOT your app. Start your app on a free port and confirm YOUR process is the one answering (pgrep -af "<serve cmd>" + curl its port several times).',
        '- A "directory listing" page (titles like "Index of /" or "Directory listing for /") or an EMPTY index.html is NOT a valid app — treat it as FAILURE. Never fake a pass with a static file server.',
        '- Health check must return the REAL application content (HTML with a <title> and app markup, or the backend API JSON). A 200 on a file listing or an empty page is NOT success.',
        '- If you cannot install deps / build / start the app for real, report ok:false with the real reason. Do NOT fake success to satisfy the check.',
        'DATABASE SETUP (MANDATORY when the backend needs a database):',
        (plan?.context?.dbReady
            ? (plan?.context?.dbName
                ? `- PostgreSQL is ALREADY installed, run, and the database \`${plan.context.dbName}\` (user \`${plan.context.dbUser}\`) has ALREADY been created by the platform. SKIP installing PG / creating user / creating database. Point the app at 127.0.0.1 and run migrations directly — do NOT run any CREATE USER / CREATE DATABASE.`
                : '- PostgreSQL is ALREADY installed and started by the platform inside this sandbox. SKIP installing/starting it. Create the user/database only if the app config requires names that do not exist yet, then run migrations.')
            : '- Detect it: the backend uses pg/postgres (server/package.json deps, a db/ dir, or DATABASE_URL / POSTGRES_* in .env files). A backend whose DB-dependent endpoints hang or error is NOT a passing app.'),
        ...(plan?.context?.dbReady ? [] : [
            '- BEFORE apt install, clear stale apt/dpkg locks left by previous runs: `pkill -9 apt-get; pkill -9 dpkg; sleep 1; rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock; sleep 1`. Then `apt-get update -qq && apt-get install -y postgresql postgresql-contrib`. If a lock error still appears, retry the clear+install once.',
            '- Install and start PostgreSQL INSIDE the sandbox: after install run `service postgresql start` (or `pg_ctlcluster <ver> main start`).',
        ]),
        '- Create a user + database matching the app config. Run psql as the postgres user via `su postgres -c "psql -c \\"...\\""` — in this sandbox `su postgres -c` is the CORRECT way; do NOT waste rounds trying `sudo -u postgres` / `runuser -u postgres` variants. Create the user, then `CREATE DATABASE mydb OWNER myuser;`, and run each CREATE only ONCE.',
        '- MIGRATIONS / PRE-START SCRIPTS RUN EXACTLY ONCE: `alembic upgrade`, `npm run db:migrate`, `prestart.sh`, `prisma migrate` etc. are typically idempotent or only need ONE successful run. Before running one, check whether it has already succeeded (table exists / previous exit=0 with no error in output / `alembic current` already up to date); if yes, SKIP it. NEVER re-run the same migration/prestart command just because a later step failed for an unrelated reason.',
        '- Create the tables: look for schema.sql / init.sql / migrations / README "Database Schema" section / the SQL in code (db/*.db.js), and run the DDL so real queries work.',
        '- Point the app at the LOCAL database: edit server/.env (and client env if needed) so POSTGRES_HOST/DATABASE_URL use 127.0.0.1 (or localhost), with the user/password/database you created.',
        '- SECURITY (MANDATORY) — the sandbox shares a network with the HOST machine. NEVER point the app at a database on the host or anywhere outside the sandbox: no host / LAN IP (e.g. 172.28.x.x, 10.x.x.x, 192.168.x.x), no cloud hostname. The database MUST run INSIDE the sandbox at 127.0.0.1. If a repo .env already contains a DATABASE_URL / POSTGRES_HOST, always re-point its host to 127.0.0.1 and start local PostgreSQL. Using the host database is a hard FAILURE: it breaks isolation and lets the preview authenticate with host accounts.',
        '- Then start the backend and verify a DB-backed endpoint actually returns rows (e.g. GET /api/... that reads from the DB), not just an empty 200 from the root.',
        'FRONTEND API BASE (MANDATORY): if the frontend calls its backend through an env like VITE_API_URL / REACT_APP_API_URL / NEXT_PUBLIC_API_URL / axios baseURL, set it to a RELATIVE path so it works under the preview sub-path (e.g. build with VITE_API_URL=./api, or use /api if the backend routes are under /api). NEVER leave it as an absolute http://localhost:... address — the user browser cannot reach the sandbox localhost. Check the frontend config (.env / axios.config / build script) and REBUILD the frontend with the correct relative API base if the current dist has no/absolute baseURL. In the sandbox, verify the frontend-to-backend path works: curl -s http://127.0.0.1:<frontendPort>/api/... returns the backend JSON, not an HTML page.',
        'SELF-CONTAINED FULLSTACK SERVERS: some backends also serve their own built frontend, so a single port answers both HTML and API. If the project works that way:',
        '- Detect: the backend reads a built frontend dir (dist / public / build) and serves it, and there is no separate frontend dev server needed for the app to be usable.',
        '- Build the frontend into the location the server expects (check its config / README for the expected output dir), then start the backend WITH the config it needs — many servers do NOT auto-load their .env, so source it or export the required DATABASE_URL etc. (e.g. `cd server && set -a && . ./.env && set +a && npm start`).',
        '- The app answers on the backend port: verify it returns real HTML for / and JSON for an API endpoint. That port IS the app — do not start a second static file server on top of it.',
        'When the app responds correctly, output your final answer:',
        '{"action":"final","result":{"ok":true,"tested":["npm install","npm run build","curl /"],"finalStderr":"","summary":"<1-2 sentences>"}}',
        'If you cannot make it pass after exhaustive fixes, output:',
        '{"action":"final","result":{"ok":false,"tested":["..."],"finalStderr":"<the latest error output>","summary":"<what you tried and why it failed>"}}',
    ].join('\n');
}

// 断点续修提示：把上次会话的进度浓缩成一条 user 消息，指导新轮次跳过已成功的步骤、直击失败点。
function buildResumeHint(trail) {
    const t = Array.isArray(trail) ? trail : [];
    const successes = t.filter((x) => x.action === 'tool' && /^exit=0\b/.test(String(x.out || ''))).slice(-5)
        .map((s) => `${s.tool} ${JSON.stringify(s.args || {})}`);
    const lastTool = [...t].reverse().find((x) => x.action === 'tool');
    const lastInvalid = [...t].reverse().find((x) => x.action === 'invalid_json');
    const lines = [
        'CONTINUING a previous repair session. Do NOT repeat steps that already succeeded — go straight for the failing point.',
        ...(successes.length ? [`Already succeeded (skip these): ${successes.join('; ')}`] : []),
        ...(lastTool ? [`Last action before stopping: ${lastTool.tool} ${JSON.stringify(lastTool.args || {})} → ${String(lastTool.out || '').slice(0, 300)}`] : []),
        ...(lastInvalid ? ['Some of your earlier replies were too long and got truncated — keep tool-call JSON short (<800 chars).'] : []),
        'Inspect the latest error, fix it, verify with curl, then output your final answer.',
    ];
    return lines.filter(Boolean).join('\n');
}

async function runVerifyWithAgent({ workspacePath, runtimeRef, plan, projectType, onRound, resume, isAborted }) {
    const defaultPort = projectType?.defaultPort || 3000;
    let messages;
    let roundStart = 0;
    if (resume && Array.isArray(resume.messages) && resume.messages.length > 0) {
        // 断点续修：接回上次的对话历史，注入进度提示后从上次轮数继续，不从头重跑。
        messages = resume.messages.slice();
        roundStart = Math.min(Number(resume.roundsUsed) || 0, MAX_AGENT_ROUNDS - 1);
        messages.push({ role: 'user', content: buildResumeHint(resume.trail) });
    } else {
        const initialUser = [
            `Project root: /workspace. Detected type: ${projectType?.type || 'unknown'}, default port: ${defaultPort}.`,
            'Start executing the plan now. Report what you run. Work until the health check passes.',
        ].join('\n');
        messages = [
            { role: 'system', content: buildSystemPrompt(plan) },
            { role: 'user', content: initialUser },
        ];
    }

    let lastResult = null;
    let prevToolSig = '';
    let repeatCount = 0;
    const trail = [];

    for (let round = roundStart; round < MAX_AGENT_ROUNDS; round++) {
        if (isAborted?.()) {
            return { ok: false, source: 'ai', aborted: true, warning: '部署已中止', finalStderr: '', tested: [], trail, messages: trimContext(messages), roundsUsed: round };
        }
        if (onRound) onRound(round);
        const llmResult = await callLlm(messages);
        if (!llmResult.ok) {
            return { ok: false, source: 'ai', warning: llmResult.warning, finalStderr: '', tested: [], trail, messages: trimContext(messages) };
        }
        const truncated = llmResult.finishReason === 'length';
        let parsed = tryParseJson(llmResult.content);
        if (!parsed) {
            const len = String(llmResult.content || '').length;
            trail.push({ round, action: 'invalid_json', truncated, len });
            console.error(`[analyzeVerify] round ${round}: INVALID JSON (truncated=${truncated}, len=${len}, finish=${llmResult.finishReason})`);
            messages.push({
                role: 'user',
                content: 'Your previous response was NOT valid JSON (it was likely truncated because it was too long). Respond with ONLY ONE valid JSON object — no thinking, no analysis text, no markdown fences. A TOOL CALL must be under 800 characters: {"action":"tool","tool":"...","args":{...}}. The FINAL answer may be up to 4000 characters: {"action":"final","result":{...}}.',
            });
            continue;
        }
        if (parsed.action === 'tool') {
            const sig = `${parsed.tool}:${JSON.stringify(parsed.args || {})}`;
            if (sig === prevToolSig) {
                repeatCount++;
                if (repeatCount >= 2) {
                    trail.push({ round, action: 'repeat', tool: parsed.tool });
                    messages.push({ role: 'user', content: 'You repeated the exact same tool call. STOP. Try a different fix or output your final answer now.' });
                    prevToolSig = '';
                    repeatCount = 0;
                    continue;
                }
            } else {
                prevToolSig = sig;
                repeatCount = 0;
            }
            const out = await runTool(parsed.tool, parsed.args || {}, runtimeRef, workspacePath);
            trail.push({ round, action: 'tool', tool: parsed.tool, args: summarizeArgs(parsed.args), out: summarize(out) });
            console.error(`[analyzeVerify] round ${round}: tool=${parsed.tool} args=${JSON.stringify(summarizeArgs(parsed.args))} out_len=${String(out).length}`);
            messages.push({ role: 'user', content: `Tool "${parsed.tool}" result:\n${out}` });
            messages = trimContext(messages);
            continue;
        }
        if (parsed.action === 'final') {
            const r = parsed.result || {};
            const ok = Boolean(r.ok);
            lastResult = {
                ok,
                tested: Array.isArray(r.tested) ? r.tested.map((t) => String(t).slice(0, 200)) : [],
                finalStderr: String(r.finalStderr || '').slice(0, 4000),
                summary: String(r.summary || '').slice(0, 500),
            };
            trail.push({ round, action: 'final', ok });
            let appPort = null;
            if (ok) {
                const probe = await assertAppIsServed({ runtimeRef, workspacePath, preferredPort: defaultPort });
                if (!probe.ok) {
                    trail.push({ round, action: 'app_check_failed', reason: probe.reason });
                    const failedResult = {
                        ...lastResult,
                        ok: false,
                        warning: probe.reason,
                        finalStderr: `${probe.reason}\n${lastResult.finalStderr || ''}`.slice(0, 4000),
                    };
                    return { ...failedResult, source: 'ai', trail, messages: trimContext(messages), roundsUsed: round + 1 };
                }
                appPort = probe.port;
            }
            return { ...lastResult, appPort, source: 'ai', warning: ok ? '' : 'verify agent reported failure', trail, messages: trimContext(messages), roundsUsed: round + 1 };
        }
        trail.push({ round, action: 'unknown', name: String(parsed.action).slice(0, 50) });
        messages.push({ role: 'user', content: 'Unknown action. Respond with a single tool call or the final answer JSON.' });
    }

    // 超轮数且没有 final 答案：记录完整活动轨迹，并做一次"按计划直跑"兜底，
    // 拿到真实失败步骤 + stderr（或确认服务其实可用），而不是只给一句笼统的报错。
    const fallbackResult = await runVerifyWithoutLlm({ workspacePath, runtimeRef, plan, projectType }).catch(() => null);
    let fallbackOk = !!fallbackResult?.ok;
    let fallbackFailed = fallbackResult && !fallbackResult.ok;
    let concreteStderr = fallbackFailed
        ? fallbackResult.finalStderr
        : (lastResult?.finalStderr || '');
    let appPort = fallbackResult?.appPort || null;
    if (fallbackOk) {
        const probe = await assertAppIsServed({ runtimeRef, workspacePath, preferredPort: defaultPort });
        if (!probe.ok) {
            fallbackOk = false;
            fallbackFailed = true;
            concreteStderr = probe.reason;
        } else {
            appPort = probe.port;
        }
    }
    const ok = lastResult ? lastResult.ok : fallbackOk;
    console.error('[analyzeVerify] MAX ROUNDS reached; fallback ok=', fallbackOk, 'appPort=', appPort, 'trail=', JSON.stringify(trail.slice(-24)));
    return {
        ...(lastResult || { ok, tested: [], finalStderr: '', summary: '' }),
        ok,
        appPort,
        source: 'ai',
        warning: fallbackOk
            ? `AI 自动修复达到轮数上限（${MAX_AGENT_ROUNDS} 轮），但按计划直接执行确认服务可用`
            : (fallbackFailed
                ? `AI 自动修复达到轮数上限（${MAX_AGENT_ROUNDS} 轮），已按计划直跑定位到失败步骤`
                : `AI 自动修复达到轮数上限（${MAX_AGENT_ROUNDS} 轮），未能给出最终结论`),
        finalStderr: concreteStderr,
        fallback: fallbackResult || null,
        trail: trail.slice(-40),
        messages: trimContext(messages),
        roundsUsed: MAX_AGENT_ROUNDS,
    };
}

// Fallback when no LLM is configured: execute the plan's prepare steps directly via
// runtime.exec, then try to serve + curl-probe. No self-healing.
async function runVerifyWithoutLlm({ workspacePath, runtimeRef, plan, projectType }) {
    const runtime = getRuntime();
    const tested = [];
    const port = projectType?.defaultPort || 3000;
    try {
        const steps = (plan?.steps || []).filter((s) => s.kind !== 'serve');
        for (const step of steps) {
            if (!step.command) continue;
            const r = await runtime.exec.exec('sh', ['-c', `${step.command} > /tmp/_vt.log 2>&1; ec=$?; cat /tmp/_vt.log | head -120; echo "__EXIT_CODE__=\${ec}"`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: SHELL_TIMEOUT_MS });
            let ec = r.exitCode;
            const out = String(r.stdout || '');
            const m = out.match(/__EXIT_CODE__=(-?\d+)/);
            if (m) ec = parseInt(m[1], 10);
            tested.push(`${step.name || step.id}: exit=${ec}`);
            if (ec !== 0) {
                return { ok: false, source: 'shell', tested, finalStderr: out.replace(/__EXIT_CODE__=-?\d+\s*/g, '').slice(0, 4000), warning: `step "${step.name}" failed` };
            }
        }
        const serveStep = (plan?.steps || []).find((s) => s.kind === 'serve');
        if (serveStep?.command) {
            const cmd = `export PORT=${port}; ${serveStep.command} > /tmp/serve.log 2>&1 & sleep 6; curl -s -m 8 -w "\\n__HTTPCODE__:%{http_code}" http://127.0.0.1:${port}/ | head -c 1500 || true`;
            const r = await runtime.exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 });
            const out = String(r.stdout || '');
            const codeMatch = out.match(/__HTTPCODE__:(\d{3})/);
            const code = codeMatch ? codeMatch[1] : '000';
            const body = out.replace(/__HTTPCODE__:\d{3}/, '').trim();
            tested.push(`serve probe: http=${code}`);
            const ok2xx = code.startsWith('2') || code.startsWith('3');
            const boxDefaultPorts = [Number(process.env.BOXLITE_DEFAULT_PREVIEW_PORT || 3000), 5173];
            const isBoxDefaultPort = port === 5173 || (boxDefaultPorts.includes(port) && isBoxDefaultPage(body));
            if (ok2xx && (isDirectoryListing(body) || isBoxDefaultPort || !body)) {
                const log = await runtime.exec.exec('sh', ['-c', `cat /tmp/serve.log 2>&1 | tail -60`], {}, { runtimeRef, cwd: workspacePath });
                return { ok: false, source: 'shell', tested, finalStderr: String(log.stdout || '').slice(0, 4000), warning: 'served directory listing / box default page / empty, not the app' };
            }
            if (ok2xx) {
                return { ok: true, source: 'shell', tested, finalStderr: '', warning: '', appPort: port };
            }
            const log = await runtime.exec.exec('sh', ['-c', `cat /tmp/serve.log 2>&1 | tail -60`], {}, { runtimeRef, cwd: workspacePath });
            return { ok: false, source: 'shell', tested, finalStderr: String(log.stdout || '').slice(0, 4000), warning: 'app did not respond to health check' };
        }
        return { ok: true, source: 'shell', tested, finalStderr: '', warning: '' };
    } catch (e) {
        return { ok: false, source: 'shell', tested, finalStderr: `verify error: ${e.message}`, warning: e.message };
    }
}

async function analyzeProjectVerify({ workspacePath, runtimeRef, plan, projectType, onRound, resume, isAborted }) {
    if (!API_KEY || !API_URL) {
        return runVerifyWithoutLlm({ workspacePath, runtimeRef, plan, projectType });
    }
    return runVerifyWithAgent({ workspacePath, runtimeRef, plan, projectType, onRound, resume, isAborted });
}

module.exports = { analyzeProjectVerify, assertAppIsServed };
