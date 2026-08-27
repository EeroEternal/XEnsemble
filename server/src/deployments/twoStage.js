// Two-stage auto-deploy orchestrator.
//   Stage 1: reuses analyzeProjectDeploy (opencode agent + LLM 1 = LLM_ANALYZE_MODEL).
//   Stage 2: analyzeProjectVerify (opencode agent + LLM 2 = LLM_VERIFY_MODEL). The agent runs
//            install + build in the sandbox and self-heals via edit_file + run_shell until both pass.
//   On success: reuses the existing tunnel-preview path inline (createTunnel + db.deployments +
//               issuePreviewToken + start serve in box) and returns the public URL.
//   On failure: returns the stage 2 finalStderr + plan for the front-end to show.

const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { eq, and, inArray } = require('drizzle-orm');
const { getRuntime } = require('../runtime/registry');
const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const { analyzeProjectDeploy, collectProjectContext } = require('./analyzeDeploy');
const { analyzeProjectVerify } = require('./analyzeVerify');
const { createTunnel, stopTunnel } = require('../preview/tunnelServer');
const deploymentService = require('./DeploymentService');
const workspace = require('../workspace');
const { registerDeploy, unregisterDeploy, isAborted, countByUser, listProjectIdsByUser, listByUser } = require('./activeDeploys');
const { ensureUserQuota, getUsage } = require('../auth/PolicyService');
const { broadcastSse } = require('../session/sseManager');
const { db } = require('../db');
const schema = require('../db/schema');

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const VERIFY_STATE_TTL_MS = 30 * 60 * 1000;
// 单次部署（阶段 1 分析 + 阶段 2 验证）整体超时：verify agent 可能因 run_shell 启动服务未正确
// 后台化（缺少 &/nohup）而挂起，必须有总超时自动中止，否则部署永不结束、前端一直显示 running。
const DEPLOY_TOTAL_TIMEOUT_MS = Number(process.env.DEPLOY_TOTAL_TIMEOUT_MS) || 25 * 60 * 1000;

// 给长耗时异步操作加总超时：超时返回 fallback（不阻塞调用方），并通过 onTimeout 通知真正中止底层工作，
// 避免只丢弃结果而底层 agent 继续跑（僵尸进程/资源泄漏）。
function withTimeout(promise, ms, fallback, onTimeout) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (onTimeout) onTimeout();
            resolve(fallback);
        }, ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            () => { clearTimeout(timer); resolve(fallback); },
        );
    });
}

// 并发超限时，返回"当前占用额度"的部署/预览（结构化，含 sessionId + projectName），
// 供前端在超限报错时展示"哪个 project 的哪个 session 正在部署/运行"。
async function buildConcurrencyOccupants(userId, getProjectForUser) {
    const items = [];
    const seen = new Set();
    const nameCache = new Map();
    const sessionNameCache = new Map();
    const getProjectName = async (projectId) => {
        if (nameCache.has(projectId)) return nameCache.get(projectId);
        let name = projectId;
        try { const p = await getProjectForUser(userId, projectId); if (p?.name) name = p.name; } catch { /* ignore */ }
        nameCache.set(projectId, name);
        return name;
    };
    const getSessionName = async (sessionId) => {
        if (!sessionId) return '';
        if (sessionNameCache.has(sessionId)) return sessionNameCache.get(sessionId);
        let name = sessionId;
        try {
            const rows = await db.select({ title: schema.sessions.title }).from(schema.sessions).where(eq(schema.sessions.id, sessionId));
            if (rows[0]?.title) name = rows[0].title;
        } catch { /* ignore */ }
        sessionNameCache.set(sessionId, name);
        return name;
    };
    try {
        // 进行中的部署（activeDeploys）
        for (const { projectId, sessionId } of listByUser(userId)) {
            const key = `deploy:${projectId}:${sessionId || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ sessionId: sessionId || null, projectId, projectName: await getProjectName(projectId), sessionName: await getSessionName(sessionId), kind: 'deploy', status: 'building' });
        }
        // 运行中 / building / pending 的 preview 与部署记录（与 previews 计数口径一致）
        const rows = await db.select({
            projectId: schema.deployments.projectId,
            sessionId: schema.deployments.sessionId,
            kind: schema.deployments.kind,
        }).from(schema.deployments)
            .where(and(
                eq(schema.deployments.userId, userId),
                inArray(schema.deployments.status, ['running', 'building', 'pending']),
            ));
        for (const r of rows) {
            const key = `${r.kind}:${r.projectId}:${r.sessionId || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ sessionId: r.sessionId || null, projectId: r.projectId, projectName: await getProjectName(r.projectId), sessionName: await getSessionName(r.sessionId), kind: r.kind, status: 'running' });
        }
    } catch (e) {
        console.error('[twoStage] buildConcurrencyOccupants error:', e?.message || e);
    }
    return items;
}

// 修复 host workspace 目录属主。
// 背景：server 以 root 运行，新建/拉取 git 项目时目录可能被写成 root:root，
// 而 guest 经 virtiofs 映射为非 root 用户（默认 uid 1000，同 test1 的 administrator:administrator），
// 导致 guest 无法写入 /workspace（npm install、preview 写 .agents/tunnelClient.js 全部失败）。
// 部署前把属主修正为映射用户，只改所有权不改内容，保证依赖安装与 preview 可写。
function repairHostWorkspaceOwnership(hostPath) {
    if (!hostPath || !fs.existsSync(hostPath)) return;
    const uid = Number(process.env.XENSEMBLE_WORKSPACE_UID || 1000);
    const gid = Number(process.env.XENSEMBLE_WORKSPACE_GID || 1000);
    try {
        const st = fs.statSync(hostPath);
        const wrongTop = st.uid !== uid || st.gid !== gid;
        const wrongDeep = wrongTop
            ? hostPath
            : execSync(`find ${JSON.stringify(hostPath)} -maxdepth 3 ! -user ${uid} -print -quit 2>/dev/null`).toString().trim();
        if (wrongDeep) {
            console.error(`[twoStage] fixing workspace ownership: ${hostPath} -> ${uid}:${gid}`);
            execSync(`chown -R ${uid}:${gid} ${JSON.stringify(hostPath)}`, { stdio: 'ignore', timeout: 180000 });
        }
        // opencode 等 agent 的 worktree 在 `proj_xxx.wt/<runtimeId>`（workspace.worktreeDir），
        // 是 server 以 root 创建（root:root），guest 无 idmapped 映射到 1000 时无法写入
        // （verify 被迫复制到 /tmp、脱离 git 仓库）。部署前置统一 chown 到 guest 映射用户。
        const worktreesRoot = `${hostPath}.wt`;
        if (fs.existsSync(worktreesRoot)) {
            for (const wt of fs.readdirSync(worktreesRoot)) {
                const wtPath = path.join(worktreesRoot, wt);
                try {
                    const wtSt = fs.statSync(wtPath);
                    if (wtSt.uid !== uid || wtSt.gid !== gid) {
                        console.error(`[twoStage] fixing worktree ownership: ${wtPath} -> ${uid}:${gid}`);
                        execSync(`chown -R ${uid}:${gid} ${JSON.stringify(wtPath)}`, { stdio: 'ignore', timeout: 180000 });
                    }
                } catch { /* ignore */ }
            }
        }
    } catch (e) {
        console.error(`[twoStage] repairHostWorkspaceOwnership: ${e.message}`);
    }
}

// 部署通过后清理可续状态，并提取「成功执行轨迹」：既跑成功又能产生实际结果的命令，
// 供下次部署复用（去掉 ls/cat/grep 等纯探索命令和成功的 curl 健康检查）。
function extractSuccessCommands(trail) {
    const cmds = [];
    const seen = new Set();
    for (const t of (Array.isArray(trail) ? trail : [])) {
        if (t.action !== 'tool' || t.tool !== 'run_shell') continue;
        const cmd = String(t.cmd || (t.args && t.args.cmd) || '').trim();
        if (!cmd) continue;
        // 只保留 exit=0 的命令（out 前缀为 exit=0）
        if (!/^exit=0\b/.test(String(t.out || ''))) continue;
        // 跳过只读探索/健康检查命令，只留「产生实际结果」的命令
        if (/^(ls|cat|pwd|which|grep|head|tail|find|test|echo|curl|pgrep|ps)\b/i.test(cmd)) continue;
        if (seen.has(cmd)) continue;
        seen.add(cmd);
        if (cmds.length >= 12) break;
        cmds.push(cmd);
    }
    return cmds;
}

// 断点续修：verify 超轮数失败后把对话历史存库，resume 时接回继续修 ——
async function loadVerifyState(projectId) {
    try {
        const rows = await db.select().from(schema.deployVerifyStates).where(eq(schema.deployVerifyStates.projectId, projectId));
        if (!rows.length) return null;
        const row = rows[0];
        if (!Array.isArray(row.messages) || !row.messages.length) return null;
        if (Date.now() - Number(row.updatedAt || 0) > VERIFY_STATE_TTL_MS) return null; // 过期失效
        return {
            plan: row.plan || {},
            messages: row.messages,
            trail: row.trail || [],
            roundsUsed: Number(row.roundsUsed) || 0,
        };
    } catch (e) {
        console.error('[twoStage] loadVerifyState error:', e.message);
        return null;
    }
}

async function saveVerifyState(projectId, state) {
    const now = Date.now();
    const values = {
        projectId,
        plan: JSON.parse(JSON.stringify(state.plan || {})),
        messages: state.messages || [],
        trail: state.trail || [],
        roundsUsed: state.roundsUsed || 0,
        runtimeRef: state.runtimeRef || null,
        workspacePath: state.workspacePath || null,
        updatedAt: now,
    };
    await db.insert(schema.deployVerifyStates).values(values)
        .onConflictDoUpdate({ target: schema.deployVerifyStates.projectId, set: values });
}

async function clearVerifyState(projectId) {
    try {
        await db.delete(schema.deployVerifyStates).where(eq(schema.deployVerifyStates.projectId, projectId));
    } catch (e) {
        console.error('[twoStage] clearVerifyState error:', e.message);
    }
}

// —— 阶段 A 部署计划缓存：二次部署复用上次分析结果，跳过 opencode/LLM 探索 ——
const PLAN_CACHE_TTL_MS = Number(process.env.DEPLOY_PLAN_CACHE_TTL_MS) || 24 * 60 * 60 * 1000;

// 项目内容指纹：优先 git HEAD（host 上有 .git 时），否则回退关键 manifest 文件的哈希。
// 用于缓存失效判断——内容变了立即失效而非靠时间猜测，避免「项目已改仍用旧计划」。
function computeProjectFingerprint(hostWs, wsPath) {
    const base = (hostWs && fs.existsSync(hostWs)) ? hostWs : (wsPath || '');
    if (!base) return null;
    try {
        const sha = execSync('git rev-parse HEAD', { cwd: base, stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 })
            .toString().trim();
        if (sha) return `git:${sha}`;
    } catch { /* 无 git 仓库或失败，回退 manifest 哈希 */ }
    const manifests = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'package.json'];
    const h = crypto.createHash('sha256');
    let any = false;
    for (const m of manifests) {
        const p = path.join(base, m);
        try {
            if (fs.existsSync(p)) { h.update(`${m}:${fs.readFileSync(p, 'utf8')}\n`); any = true; }
        } catch { /* ignore */ }
    }
    return any ? `files:${h.digest('hex').slice(0, 16)}` : null;
}

async function loadPlanCache(projectId, fingerprint) {
    try {
        const rows = await db.select().from(schema.deployPlanCache).where(eq(schema.deployPlanCache.projectId, projectId));
        if (!rows.length) return null;
        const row = rows[0];
        const plan = row.plan || {};
        if (!Array.isArray(plan.steps) || !plan.steps.length) return null;
        if (Date.now() - Number(row.updatedAt || 0) > PLAN_CACHE_TTL_MS) return null; // 过期兜底
        // 指纹不匹配 → 项目内容已变，缓存作废（比 TTL 更精确的失效判断）。
        // 无 fingerprint 的旧格式缓存也一并作废，让下次保存带上指纹（渐进升级）。
        if (fingerprint && plan.context?.fingerprint !== fingerprint) {
            console.error(`[twoStage] plan cache stale (fingerprint ${plan.context?.fingerprint ? 'changed' : 'missing'}), re-analyzing`);
            return null;
        }
        return { steps: plan.steps, configFiles: plan.configFiles || [], source: row.source || 'cache', context: plan.context || {} };
    } catch (e) {
        console.error('[twoStage] loadPlanCache error:', e.message);
        return null;
    }
}

async function savePlanCache(projectId, plan) {
    try {
        const values = {
            projectId,
            plan: JSON.parse(JSON.stringify({
                steps: plan.steps || [],
                configFiles: plan.configFiles || [],
                context: plan.context || {},
            })),
            source: plan.source || null,
            updatedAt: Date.now(),
        };
        await db.insert(schema.deployPlanCache).values(values)
            .onConflictDoUpdate({ target: schema.deployPlanCache.projectId, set: values });
    } catch (e) {
        console.error('[twoStage] savePlanCache error:', e.message);
    }
}

function detectProjectType(hostWorkspacePath) {
    if (!hostWorkspacePath) {
        return { type: 'unknown', defaultPort: 3000, installCmd: null, buildCmd: null, startCmd: null };
    }
    const fs = require('fs');
    const path = require('path');
    const has = (n) => { try { return fs.existsSync(path.join(hostWorkspacePath, n)); } catch { return false; } };
    const readJson = (n) => { try { return JSON.parse(fs.readFileSync(path.join(hostWorkspacePath, n), 'utf8')); } catch { return null; } };
    if (has('package.json')) {
        const pkg = readJson('package.json') || {};
        const scripts = pkg.scripts || {};
        const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : 'npm';
        const installCmd = `${pm} install --no-audit --no-fund`;
        const buildCmd = scripts.build ? `${pm} run build` : null;
        const startCmd = scripts.start ? `${pm} run start` : (scripts.dev ? `${pm} run dev` : null);
        let defaultPort = 3000;
        if (pkg.dependencies?.next || pkg.dependencies?.nuxt) defaultPort = 3000;
        else if (pkg.dependencies?.vite) defaultPort = 5173;
        return { type: 'node', defaultPort, installCmd, buildCmd, startCmd };
    }
    if (has('requirements.txt')) {
        return { type: 'python', defaultPort: 8000, installCmd: 'pip install -r requirements.txt', buildCmd: null, startCmd: 'python3 -m http.server 8000 --bind 0.0.0.0' };
    }
    if (has('pyproject.toml')) {
        return { type: 'python', defaultPort: 8000, installCmd: 'pip install -e .', buildCmd: null, startCmd: 'python3 -m http.server 8000 --bind 0.0.0.0' };
    }
    if (has('go.mod')) {
        return { type: 'go', defaultPort: 8080, installCmd: 'go mod download', buildCmd: 'go build ./...', startCmd: 'go run .' };
    }
    if (has('Cargo.toml')) {
        return { type: 'rust', defaultPort: 8080, installCmd: 'cargo fetch', buildCmd: 'cargo build --release', startCmd: 'cargo run --release' };
    }
    if (has('index.html')) {
        return { type: 'static', defaultPort: 8000, installCmd: null, buildCmd: null, startCmd: 'python3 -m http.server 8000 --bind 0.0.0.0' };
    }
    return { type: 'unknown', defaultPort: 3000, installCmd: null, buildCmd: null, startCmd: null };
}

// 在沙箱内探测一个空闲端口（避免 verify 残留进程占用默认端口导致聚合 EADDRINUSE）。
async function getGuestFreePort(runtimeRef) {
    const runtime = getRuntime();
    try {
        const r = await runtime.exec.exec('node', ['-e', 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'], {}, { runtimeRef, cwd: '/workspace', timeoutMs: 10000 });
        const p = Number((r.stdout || '').trim().split('\n')[0]);
        return p > 0 && p < 65535 ? p : 0;
    } catch { return 0; }
}

// 依赖缓存检测：node_modules 存在且比 lockfile 新，说明上次安装的依赖仍匹配当前 lockfile，
// 可跳过 install 直接 build/serve（否则重装走全新下载，耗时长）。
// 无 lockfile 或 node_modules 缺失时保守返回 false（不跳过）。
async function detectDepsCached(runtimeRef, workspacePath) {
    const runtime = getRuntime();
    try {
        const r = await runtime.exec.exec(
            'sh',
            ['-c', 'test -d node_modules && (test node_modules -nt package-lock.json 2>/dev/null || test node_modules -nt pnpm-lock.yaml 2>/dev/null || test node_modules -nt yarn.lock 2>/dev/null || test node_modules -nt requirements.txt 2>/dev/null) && echo CACHED || echo STALE'],
            {},
            { runtimeRef, cwd: workspacePath, timeoutMs: 15000 },
        );
        return String(r.stdout || '').includes('CACHED');
    } catch { return false; }
}

// 从阶段 A 产出的 configFiles（.env 模板）里解析 PostgreSQL 连接信息，供系统侧直接建库建用户，
// 避免 verify agent 用 su/runuser/sudo 变体反复试错（历史 3 轮≈60s 的浪费点）。
// 只接受安全字符（user/db 为字母数字下划线），host 一律由 agent 强制 127.0.0.1。
function parseDbInfoFromPlan(plan) {
    const cfs = Array.isArray(plan?.configFiles) ? plan.configFiles : [];
    const haystacks = cfs.map((c) => `${c.path || ''}\n${c.template || ''}`).join('\n');
    if (!haystacks) return null;

    // DATABASE_URL=postgres://user:password@host:port/db
    const urlMatch = haystacks.match(/DATABASE_URL\s*=\s*['\"]?(?:postgres(?:ql)?:\/\/)([^:\s@'\"\/]+):([^@\s'\"]+)@[^\/\s'\"]+\/([A-Za-z0-9_-]+)/);
    if (urlMatch) {
        const [, user, pass, db] = urlMatch;
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(user) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(db)) {
            return { user, pass, db };
        }
        return null;
    }
    // POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB（或 DB_USER / DB_PASSWORD / DB_NAME 等变体）
    const pick = (keys) => keys.map((k) => haystacks.match(new RegExp(`${k}\\s*=\\s*['\\\"]?([^\\s'\\\"]+)`))?.[1]).find(Boolean) || null;
    const user = pick(['POSTGRES_USER', 'DB_USER', 'PGUSER']);
    const pass = pick(['POSTGRES_PASSWORD', 'DB_PASSWORD', 'PGPASSWORD']);
    const db = pick(['POSTGRES_DB', 'DB_NAME', 'PGDATABASE']);
    if (user && /^[A-Za-z_][A-Za-z0-9_]*$/.test(user) && db && /^[A-Za-z_][A-Za-z0-9_]*$/.test(db)) {
        return { user, pass: pass || user, db };
    }
    return null;
}

// 系统侧自动 provision PostgreSQL：检测项目是否需要 PG，需要则启动沙箱内 PG，
// 并尝试从配置解析出连接信息后直接建库建用户（幂等），使 verify agent 只需跑 migration。
async function provisionPostgresIfNeeded(runtimeRef, workspacePath, plan) {
    const runtime = getRuntime();
    let needs = false;
    try {
        const r = await runtime.exec.exec('sh', ['-c', `
            grep -lE '\\"(pg|postgres)\\"|pg-promise|pgx' package.json server/package.json 2>/dev/null
            find . -maxdepth 3 \\( -name 'schema.sql' -o -name 'init.sql' \\) 2>/dev/null | grep -v node_modules | head -3
            grep -lE 'DATABASE_URL|POSTGRES_HOST|POSTGRES_DB|POSTGRES_USER' .env server/.env .env.example server/.env.example 2>/dev/null
        `], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
        needs = Boolean(String(r.stdout || '').trim());
    } catch { needs = false; }
    if (!needs) return { ready: false };

    try {
        await runtime.exec.exec('sh', ['-c', `
            pkill -9 apt-get 2>/dev/null; pkill -9 dpkg 2>/dev/null; sleep 1
            rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock
            (service postgresql start 2>/dev/null || pg_ctlcluster $(ls /etc/postgresql 2>/dev/null | head -1) main start 2>/dev/null) || true
            sleep 2
            pg_lsclusters 2>/dev/null || true
        `], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 60000 });
    } catch (e) {
        console.error('[twoStage] postgres start failed (fallback to agent):', e.message);
        return { ready: false };
    }

    // PG 已运行后，若能从配置解析出连接信息则直接建库建用户（幂等），免去 agent 试错。
    const info = parseDbInfoFromPlan(plan);
    if (info) {
        const pqPass = String(info.pass || '').replace(/'/g, "''"); // SQL 单引号转义
        const create = `
            su postgres -c "psql -tAc \\"SELECT 1 FROM pg_roles WHERE rolname='${info.user}'\\"" 2>/dev/null | grep -q 1 \\
              || su postgres -c "psql -c \\"CREATE USER ${info.user} WITH PASSWORD '${pqPass}'\\""
            su postgres -c "psql -tAc \\"SELECT 1 FROM pg_database WHERE datname='${info.db}'\\"" 2>/dev/null | grep -q 1 \\
              || su postgres -c "createdb -O ${info.user} ${info.db}"
        `;
        try {
            await runtime.exec.exec('sh', ['-c', create], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 60000 });
            console.error(`[twoStage] postgres db provisioned user=${info.user} db=${info.db}`);
            return { ready: true, dbUser: info.user, dbName: info.db };
        } catch (e) {
            console.error('[twoStage] postgres db create failed (fallback to agent):', e.message);
            return { ready: true }; // PG 已运行，建库失败则让 agent 兜底
        }
    }
    return { ready: true };
}

// 部署通过后，系统侧在沙箱内保持前后端服务，并起一个"单端口聚合服务器"
// （静态 serve 前端 dist + 反代 /api 到后端），保证 preview 稳定可连且前后端都可用，
// 不依赖 verify 期间 agent 起的短命进程。返回实际生效的端口（tunnel 连它）。
// 用空闲端口 + spawn 后主动验证，避免残留进程占端口导致聚合没起来却被误判成功。
async function ensureFrontendServed({ runtimeRef, workspacePath, port, onLog }) {
    const runtime = getRuntime();
    let dist = null;
    try {
        // 常见前端构建产物位置：web/dist、frontend/dist、client/dist、dist，
        // 以及由后端 serve 的 frontend 产物（如 fastapi 模板的 backend/app/frontend）。
        const probe = await runtime.exec.exec(
            'sh',
            ['-c', 'ls -d web/dist frontend/dist client/dist apps/web/dist apps/cli/dist dist backend/app/frontend backend/templates/frontend app/frontend 2>/dev/null | head -1'],
            {},
            { runtimeRef, cwd: workspacePath, timeoutMs: 15000 },
        );
        dist = (probe.stdout || '').trim();
    } catch { /* keep null */ }
    if (!dist) {
        if (onLog) onLog('no frontend build artifact found, keeping verify port');
        return { ok: false, reason: 'no frontend build artifact (client/dist, web/dist, dist) found' };
    }

    // 用空闲端口（规避 verify 残留进程占用的 3000/5173/8080/9000 等）。
    const listenPort = (await getGuestFreePort(runtimeRef)) || Number(port) || 3000;
    let backendPort = (await getGuestFreePort(runtimeRef)) || 9000;
    let backendOk = false;

    // 1) 探测后端（server/ 目录 + 入口文件）。
    let backendEntry = null;
    try {
        const probe = await runtime.exec.exec(
            'sh',
            ['-c', 'test -d server && (grep -m1 "\\"main\\"" server/package.json 2>/dev/null | grep -oE ": *\\"[^\\"]+\\"" | head -1 || echo index.js) || echo none'],
            {},
            { runtimeRef, cwd: workspacePath, timeoutMs: 15000 },
        );
        const raw = (probe.stdout || '').trim();
        if (raw && raw !== 'none') {
            const m = raw.match(/"([^"]+)"/);
            backendEntry = m ? m[1] : raw;
        }
    } catch { /* ignore */ }

    if (backendEntry) {
        await runtime.exec.exec('sh', ['-c', `pkill -f "server/index.js" 2>/dev/null; sleep 1; true`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 20000 }).catch(() => {});
        try {
            await runtime.exec.spawn(
                'node',
                [backendEntry],
                { PORT: String(backendPort), NODE_ENV: 'production', HOME: process.env.HOME || '/root', PATH: process.env.PATH || '/usr/bin:/bin' },
                { runtimeRef, cwd: `${workspacePath}/server` },
            );
            backendOk = true;
            if (onLog) onLog(`backend spawned: server/${backendEntry} on :${backendPort}`);
        } catch (e) {
            if (onLog) onLog(`backend spawn failed (frontend only): ${e.message}`);
        }
    } else {
        // 非 Node 后端（如 fastapi 的 backend/ + uvicorn，或其它自托管后端）：
        // 扫描 guest 监听端口，自动发现 verify 阶段已经跑起来的后端（能对 /api 返回 JSON 的端口），
        // 聚合服务器的 /api 反代指向它，避免 502。
        try {
            const scan = await runtime.exec.exec(
                'sh',
                ['-c', `
for p in $(awk 'NR>1 && $4=="0A" {split($2,a,":"); h=a[2]; n=0; for(i=1;i<=length(h);i++){c=tolower(substr(h,i,1)); v=(c~/[0-9]/)?c:index("abcdef",c)+9; n=n*16+v;} print n}' /proc/net/tcp 2>/dev/null | sort -un); do
  ct=$(curl -s -m 2 -o /dev/null -w "%{content_type}" http://127.0.0.1:$p/api/ 2>/dev/null);
  case "$ct" in application/json*|text/json*|application/problem+json*) echo $p; break;; esac
done
`],
                {},
                { runtimeRef, cwd: workspacePath, timeoutMs: 25000 },
            );
            const found = Number(String(scan.stdout || '').trim().split('\n')[0]);
            if (found > 0 && found < 65535) {
                backendPort = found;
                backendOk = true;
                if (onLog) onLog(`detected existing backend on :${found}`);
            } else {
                if (onLog) onLog('no existing backend detected (frontend only)');
            }
        } catch (e) {
            if (onLog) onLog(`backend scan failed (frontend only): ${e.message}`);
        }
    }

    // 2) 把聚合服务器脚本写入沙箱。
    let proxyPath = null;
    try {
        const script = require('fs').readFileSync(path.join(__dirname, '../preview/previewProxyServer.js'), 'utf8');
        // .cjs 强制 CommonJS，避免项目 package.json "type":"module" 导致 require 崩溃
        await runtime.fs.fsWrite(workspacePath, '.agents/previewProxyServer.cjs', script, { runtimeRef });
        proxyPath = '.agents/previewProxyServer.cjs';
    } catch (e) {
        if (onLog) onLog(`write proxy script failed: ${e.message}`);
    }

    const distAbs = dist.startsWith('/') ? dist : `${workspacePath}/${dist}`;
    let servedOk = false;
    for (let attempt = 0; attempt < 2 && !servedOk; attempt++) {
        await runtime.exec.exec('sh', ['-c', `pkill -f previewProxyServer 2>/dev/null; fuser -k ${listenPort}/tcp 2>/dev/null; sleep 1; true`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 20000 }).catch(() => {});
        try {
            if (proxyPath) {
                await runtime.exec.spawn(
                    'node',
                    [proxyPath, distAbs, String(listenPort), String(backendOk ? backendPort : 0)],
                    { HOME: process.env.HOME || '/root', PATH: process.env.PATH || '/usr/bin:/bin' },
                    { runtimeRef, cwd: workspacePath },
                );
            } else {
                await runtime.exec.spawn(
                    'npx',
                    ['--yes', 'serve', distAbs, '-l', String(listenPort), '--no-clipboard'],
                    { HOME: process.env.HOME || '/root', PATH: process.env.PATH || '/usr/bin:/bin' },
                    { runtimeRef, cwd: workspacePath },
                );
            }
        } catch (e) {
            if (onLog) onLog(`spawn preview server failed: ${e.message}`);
        }
        // 验证端口确实由聚合服务响应（/ 返回前端 HTML；/api 不是 serve 的 404 页）。
        for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 600));
            try {
                const check = await runtime.exec.exec(
                    'sh',
                    ['-c', `curl -s -m 2 http://127.0.0.1:${listenPort}/ | head -c 120; echo; curl -s -m 2 http://127.0.0.1:${listenPort}/api/__xensemble_probe__ | head -c 200`],
                    {},
                    { runtimeRef, cwd: workspacePath, timeoutMs: 8000 },
                );
                const out = String(check.stdout || '');
                // serve 的 /api 404 页含 "could not be found"；聚合是 "Backend unavailable" 或后端响应。
                if (/<html|<head|<!doctype/i.test(out) && !/could not be found/i.test(out)) {
                    servedOk = true;
                    break;
                }
            } catch { /* retry */ }
        }
    }

    if (!servedOk) {
        if (onLog) onLog(`preview server did not come up on :${listenPort}`);
        return { ok: false, reason: `preview server did not come up on :${listenPort}` };
    }
    if (onLog) onLog(`preview server on :${listenPort} (dist=${dist}${backendOk ? `, backend=:${backendPort}` : ''})`);
    return { ok: true, port: listenPort, dist, backendOk, backendPort };
}

// 在 guest 里给 verify 已 serve 的"完整应用"（upstream，如 bin.js web / uvicorn）起一个改写反代：
// 原样反代全部请求（保留 /plugins、后端 API 等运行时资源），仅把 upstream 返回的 HTML 里的
// 绝对资源路径改写为相对路径（/assets/… → ./assets/…），适配 /preview/<id>/ 子路径，
// 避免绝对路径泄漏到宿主源（否则 /assets 落到宿主 SPA fallback 变 text-html、/api 落宿主接口 401）。
async function startRewriteProxy({ runtimeRef, workspacePath, upstreamPort, listenPort, onLog }) {
    const runtime = getRuntime();
    let proxyPath = null;
    try {
        const script = require('fs').readFileSync(path.join(__dirname, '../preview/previewProxyServer.js'), 'utf8');
        // .cjs 强制 CommonJS，避免项目 package.json "type":"module" 导致 require 崩溃
        await runtime.fs.fsWrite(workspacePath, '.agents/previewProxyServer.cjs', script, { runtimeRef });
        proxyPath = '.agents/previewProxyServer.cjs';
    } catch (e) {
        if (onLog) onLog(`write rewrite proxy script failed: ${e.message}`);
        return false;
    }
    try {
        await runtime.exec.spawn(
            'node',
            [proxyPath, '--upstream', String(upstreamPort), String(listenPort)],
            { HOME: process.env.HOME || '/root', PATH: process.env.PATH || '/usr/bin:/bin' },
            { runtimeRef, cwd: workspacePath },
        );
    } catch (e) {
        if (onLog) onLog(`spawn rewrite proxy failed: ${e.message}`);
        return false;
    }
    // 等改写反代真正就绪（能对 / 返回 2xx）。端口被占用时 previewProxyServer 会 exit(1)，超时判失败。
    for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 600));
        try {
            const check = await runtime.exec.exec(
                'sh',
                ['-c', `curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:${listenPort}/`],
                {},
                { runtimeRef, cwd: workspacePath, timeoutMs: 8000 },
            );
            if (String(check.stdout || '').startsWith('2')) return true;
        } catch { /* retry */ }
    }
    if (onLog) onLog(`rewrite proxy did not come up on :${listenPort}`);
    return false;
}

async function runAutoTwoStageDeploy({ projectId, userId, role, getProjectForUser, onProgress, resume, sessionId }) {
    const project = await getProjectForUser(userId, projectId);
    if (!project) return { ok: false, error: 'Project not found' };
    if (!process.env.LLM_ANALYZE_API_KEY && !process.env.LLM_ANALYZE_API_URL) {
        return { ok: false, error: 'LLM_ANALYZE_* env not configured.' };
    }
    // per-user 并发闸门：进行中的部署 + 运行中的预览 ≤ 该用户个人配额（admin 同普通用户，
    // 均在用户管理/个人配额里配置，避免无限制并发部署同时跑多个 VM 耗尽沙箱资源）。
    // 先注册（内存计数原子）再校验，避免多个并发请求同时通过；超限则注销并拒绝。
    registerDeploy(project.id, userId, sessionId);
    // 真正的中止通道：用户中止（activeDeploys.aborted）或部署总超时（deployState.cancelled）
    // 都使该函数返回 true，让阶段 A/B 的 agent 循环在下一轮退出，而不是只丢弃结果继续跑。
    const deployState = { cancelled: false };
    const aborted = () => deployState.cancelled || isAborted(project.id, sessionId);
    try {
        const limit = Number((await ensureUserQuota(userId)).maxPreviews ?? 0);
        const usage = await getUsage(userId);
        const current = countByUser(userId) + usage.previews;
        if (current > limit) {
            unregisterDeploy(project.id, sessionId);
            const occupants = await buildConcurrencyOccupants(userId, getProjectForUser);
            console.error(`[twoStage] quota_exceeded user=${userId} current=${current} limit=${limit} countByUser=${countByUser(userId)} previews=${usage.previews} listByUser=${JSON.stringify(listByUser(userId))} occupants=${JSON.stringify(occupants)}`);
            return {
                ok: false,
                error: `已达并发部署上限（${current}/${limit}），请到对应会话停止预览或等待部署完成后再试`,
                code: 'quota_exceeded',
                dimension: 'max_previews',
                limit,
                current,
                occupants,
            };
        }
    } catch (e) {
        console.error('[twoStage] concurrency gate error:', e?.message || e);
        // 并发检查失败时保守拒绝：绝不因检查异常放行（否则限额失效、多个部署同时跑）
        unregisterDeploy(project.id, sessionId);
        return {
            ok: false,
            error: '并发检查异常，请稍后重试',
            code: 'quota_gate_error',
            dimension: 'max_previews',
        };
    }
    const startedAt = Date.now();
    // 持久化"进行中部署"记录（kind='deploy'）的 id；report 用它实时更新阶段
    const deployRef = { id: null };
    // onProgress 包装：实时把阶段写进 deployment（跨 session 可恢复），再透传前端。
    // 用 promise 队列串行写库，避免阶段 A/B 的异步 update 乱序完成导致 DB stage 回退
    // （否则部署已到阶段 2，刷新后却恢复显示阶段 1）。
    let reportQueue = Promise.resolve();
    // 阶段级耗时打点：记录每次 stage 切换的耗时并打印日志 + 随 SSE 透传 elapsedMs，
    // 让运维/前端能定位 A（分析）/B（验证）/preview 各自的时间消耗。
    let lastStage = null;
    let lastStageAt = startedAt;
    const report = (p) => {
        const now = Date.now();
        if (p?.stage && p.stage !== lastStage) {
            if (lastStage) console.error(`[twoStage] project=${projectId} stage ${lastStage} took ${now - lastStageAt}ms`);
            lastStage = p.stage;
            lastStageAt = now;
        }
        const payload = { ...p, elapsedMs: now - startedAt };
        if (p?.stage && deployRef.id) {
            const status = p.stage === 'done' ? 'running' : 'building';
            const stageVal = p.stage === 'done' ? null : p.stage;
            const msg = p.message || null;
            reportQueue = reportQueue
                .then(() => db.update(schema.deployments)
                    .set({ stage: stageVal, stageMessage: msg, status, updatedAt: Date.now() })
                    .where(eq(schema.deployments.id, deployRef.id)))
                .catch(() => {});
        }
        if (onProgress) onProgress(payload);
    };
    let result;
    try {
        result = await runDeployInner({ project, userId, projectId, sessionId, resume, report, startedAt, deployRef, isAborted: aborted, deployState });
        return result;
    } finally {
        unregisterDeploy(project.id, sessionId);
        if (deployRef.id) {
            const finalStatus = result?.ok ? 'running' : (result?.aborted ? 'stopped' : 'failed');
            // 先等阶段写库完成（串行队列），再落终态，避免终态与阶段乱序
            await reportQueue.catch(() => {});
            db.update(schema.deployments)
                .set({ status: finalStatus, updatedAt: Date.now() })
                .where(eq(schema.deployments.id, deployRef.id))
                .catch((e) => console.error('[twoStage] persist deploy final:', e.message));
        }
        // 部署完成跨 session 提示：前端全局 EventSource 监听，即使不在该 session 页也能看到。
        // 带上 workspace（project）名与 session 名，前端 toast 能显示"哪个 workspace 的哪个 session"。
        try {
            let projectName = project.id;
            try { const p = await getProjectForUser(userId, project.id); if (p?.name) projectName = p.name; } catch { /* ignore */ }
            let sessionName = sessionId || '';
            if (sessionId) {
                try {
                    const rows = await db.select({ title: schema.sessions.title }).from(schema.sessions).where(eq(schema.sessions.id, sessionId));
                    if (rows[0]?.title) sessionName = rows[0].title;
                } catch { /* ignore */ }
            }
            broadcastSse({
                type: 'deploy_finished',
                sessionId: sessionId || null,
                projectId: project.id,
                userId,
                projectName,
                sessionName,
                ok: !!result?.ok,
                aborted: !!result?.aborted,
            });
        } catch (e) { /* ignore */ }
    }
}

// 实际的两阶段部署逻辑（编排层负责并发闸门 + 注册表 + 持久化终态）
async function runDeployInner({ project, userId, projectId, sessionId, resume, report, startedAt, deployRef, isAborted, deployState }) {

    // A new deploy attempt supersedes any existing 'running' deployment for
    // this project. Mark them 'stopped' so a failed retry doesn't leave a
    // stale 'running' record that misleads the UI into showing RUNNING.
    // The old tunnel process is left alone: it will be stopped on verify
    // success (stopByProjectId below) or expire by TTL; only the DB status
    // is corrected here so the preview badge reflects the latest attempt.
    try {
        const oldConds = [eq(schema.deployments.projectId, projectId), eq(schema.deployments.status, 'running')];
        if (sessionId) oldConds.push(eq(schema.deployments.sessionId, sessionId));
        await db.update(schema.deployments)
            .set({ status: 'stopped', updatedAt: Date.now() })
            .where(and(...oldConds));
    } catch (e) {
        console.error('[twoStage] failed to mark old deployments stopped:', e.message);
    }

    // Resolve runtimeId from session_id so deploy targets the correct worktree
    let ensureOpts = {};
    if (sessionId) {
        try {
            const sessRows = await db.select().from(schema.sessions)
                .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)))
                .limit(1);
            if (sessRows.length > 0 && sessRows[0].runtimeId) {
                ensureOpts = { runtimeId: sessRows[0].runtimeId };
            }
        } catch (e) {
            console.error('[twoStage] failed to resolve runtimeId from session:', e.message);
        }
    }

    const ready = await ensureProjectRuntime(project, ensureOpts);
    const runtime = getRuntime();
    const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
    const runtimeId = ready.runtime ? ready.runtime.id : undefined;
    const hostWs = ready.hostWorkspacePath;
    const wsPath = ready.workspacePath;

    // 持久化"进行中部署"记录（kind='deploy'，绑定 session）：前端跨 session 据此恢复，避免重复部署
    const now0 = Date.now();
    const deployId = `dep_${crypto.randomBytes(8).toString('hex')}`;
    try {
        await db.insert(schema.deployments).values({
            id: deployId, userId, projectId: project.id, sessionId: sessionId || null,
            runtimeId, kind: 'deploy', status: 'building', stage: 'A',
            createdAt: now0, updatedAt: now0, createdBy: userId,
        });
        deployRef.id = deployId;
    } catch (e) {
        console.error('[twoStage] failed to persist deploy record:', e.message);
    }

    // 部署前置：确保 host workspace 对 guest 可写（修复 root 属主导致的 write failed）。
    // 注意：boxlite 下 ensureProjectRuntime 返回的 hostWorkspacePath 可能是 undefined，
    // 必须用 workspace.projectDir(userId, projectId) 计算真实的 host 路径。
    const hostPath = (hostWs && fs.existsSync(hostWs)) ? hostWs : workspace.projectDir(project.userId, project.id);
    repairHostWorkspaceOwnership(hostPath);

    // 断点续修：resume=true 时优先复用上次保存的 plan + 对话，跳过阶段 1 重新分析。
    let plan = null;
    let planFresh = false; // 本次是否真正执行了阶段 A 分析（决定是否需要回写 plan 缓存）
    let resumeState = null;
    if (resume) {
        resumeState = await loadVerifyState(project.id);
        if (resumeState && Array.isArray(resumeState.plan?.steps) && resumeState.plan.steps.length) {
            plan = {
                steps: resumeState.plan.steps,
                configFiles: resumeState.plan.configFiles || [],
                source: resumeState.plan.source || 'resume',
                warning: resumeState.plan.warning,
                _tree: resumeState.plan.context?.tree || null,
            };
            report({ stage: 'A', message: `断点续修：复用上次分析计划（${plan.steps.length} 步）` });
        } else {
            resumeState = null;
        }
    }

    // 先查跨次部署的计划缓存：命中则跳过 opencode/LLM 探索分析（二次部署省 1~4 分钟）。
    // 用项目内容指纹做失效判断：内容变了即使 TTL 内也会重新分析。
    let planFingerprint = computeProjectFingerprint(hostWs, wsPath);
    if (!plan) {
        const cached = await loadPlanCache(project.id, planFingerprint);
        if (cached) {
            plan = {
                steps: cached.steps,
                configFiles: cached.configFiles || [],
                source: cached.source || 'cache',
                _tree: cached.context?.tree || null,
                _successRun: cached.context?.successRun || null,
            };
            report({ stage: 'A', message: `复用部署计划缓存（${plan.steps.length} 步）` });
        }
    }

    if (!plan) {
        report({ stage: 'A', message: '阶段 1：调用 LLM 1 出部署计划' });
        const planResult = await analyzeProjectDeploy({ workspacePath: wsPath, hostWorkspacePath: hostWs, runtimeRef: ref, isAborted: () => isAborted() });
        if (planResult?.aborted) {
            return { ok: false, aborted: true, error: '部署已中止', elapsedMs: Date.now() - startedAt };
        }
        if (!planResult || !planResult.steps?.length) {
            return { ok: false, error: '阶段 1 失败：未生成计划', planResult };
        }
        plan = { steps: planResult.steps, configFiles: planResult.configFiles || [], source: planResult.source, warning: planResult.warning, _tree: planResult.contextTree || null };
        planFresh = true;
        report({ stage: 'A', message: `阶段 1 完成: ${plan.steps.length} 步, ${plan.configFiles.length} configs (${planResult.source || 'fallback'})` });
    }

    report({ stage: 'B', message: resumeState ? '阶段 2：续修（接回上次对话继续修复）' : '阶段 2：调用 LLM 2（agent）准备环境 + 测试 + 自动修复' });
    const detected = hostWs ? detectProjectType(hostWs) : { type: 'unknown', defaultPort: 3000 };
    if (isAborted()) {
        return { ok: false, aborted: true, error: '部署已中止', elapsedMs: Date.now() - startedAt };
    }
    // 项目树只扫一次：优先复用阶段 A 已收集的树（fallback 路径已收集；opencode 成功为 null 才在此补一次），
    // 并注入 verify 的 system prompt，避免 verify agent 重新 list_dir/read_file 探索。
    let depsCached = false;
    {
        let tree = plan._tree || null;
        if (!tree) {
            try {
                const fsAdapter = getRuntime().fs;
                const ctx = await collectProjectContext(fsAdapter, wsPath, ref);
                tree = String(ctx.treeText || '').slice(0, 12000);
            } catch (e) {
                console.error('[twoStage] collect project context for verify failed (ignored):', e.message);
                tree = null;
            }
        }
        delete plan._tree;
        depsCached = await detectDepsCached(ref, wsPath);
        // 系统侧预启动 PostgreSQL（检测到需要时），避免 verify agent 用 su/runuser/sudo 试错
        const dbProvision = await provisionPostgresIfNeeded(ref, wsPath, plan);
        plan = { ...plan, context: { tree, depsCached, dbReady: dbProvision.ready, dbUser: dbProvision.dbUser || null, dbName: dbProvision.dbName || null, successRun: plan._successRun || null } };
        delete plan._successRun;
        // 新分析出的计划回写缓存，供二次部署跳过阶段 A（depsCached 是本次检测结果，不固化）。
        // 防护：若阶段 A 把项目误判为“纯静态”（serve 根目录），但 host 检测出真实应用类型
        // （node/python/unknown 且有后端目录），则此 plan 可疑，不写缓存，避免污染二次部署。
        const serveStep = plan.steps?.find((s) => s.kind === 'serve');
        const staticServe = serveStep && /(npx\s+(--yes\s+)?serve\s*\.|python3?\s+-m\s+http\.server|serve\s+-s\s*\.)/i.test(serveStep.command || '');
        if (planFresh && staticServe && detected.type !== 'static') {
            console.error(`[twoStage] skip caching suspicious static-serve plan (project type=${detected.type})`);
        } else if (planFresh) {
            await savePlanCache(project.id, { steps: plan.steps, configFiles: plan.configFiles, source: plan.source, context: { tree, fingerprint: planFingerprint } });
        }
    }
    const verify = await withTimeout(
        analyzeProjectVerify({
            workspacePath: wsPath,
            hostWorkspacePath: hostWs,
            runtimeRef: ref,
            plan,
            projectType: detected,
            resume: resumeState ? { messages: resumeState.messages, trail: resumeState.trail, roundsUsed: resumeState.roundsUsed } : undefined,
            isAborted: () => isAborted(),
        }),
        DEPLOY_TOTAL_TIMEOUT_MS,
        {
            ok: false,
            aborted: true,
            error: `部署验证超时（超过 ${Math.round(DEPLOY_TOTAL_TIMEOUT_MS / 60000)} 分钟）已自动中止`,
            warning: '部署验证卡住超时，已自动中止。常见原因是沙箱内启动服务的命令未后台化（缺少 & / nohup ... &），run_shell 一直等待。',
        },
        () => {
            // 超时真正中止：置 cancelled，让仍在跑的 verify agent 在下一轮检查时退出
            deployState.cancelled = true;
            console.error(`[twoStage] deploy total timeout (${Math.round(DEPLOY_TOTAL_TIMEOUT_MS / 60000)}min), cancelling verify agent project=${project.id}`);
        },
    );
    if (verify.aborted) {
        return { ok: false, aborted: true, error: verify.error || '部署已中止', elapsedMs: Date.now() - startedAt };
    }
    report({
        stage: 'B',
        message: `阶段 2 ${verify.ok ? '✓ 通过' : '✗ 失败'}（agent: ${verify.source || 'opencode'}）`,
    });
    if (!verify.ok) {
        // 超轮数/无 final：保存对话历史，前端可"从上次继续修复"。
        if (Array.isArray(verify.messages) && verify.messages.length) {
            try {
                await saveVerifyState(project.id, { plan, messages: verify.messages, trail: verify.trail, roundsUsed: verify.roundsUsed, runtimeRef: ref, workspacePath: wsPath });
                verify.resumeReady = true;
            } catch (e) {
                console.error('[twoStage] saveVerifyState error:', e.message);
            }
        }
        return { ok: false, stage: 'verify', plan, verify, error: verify.warning || '阶段 2 验证失败', finalStderr: verify.finalStderr, elapsedMs: Date.now() - startedAt };
    }

    // 通过 → 清理可续状态
    await clearVerifyState(project.id);
    // 提取并回写「成功执行轨迹」，供二次部署直接把成功命令注入 verify agent 快速复现
    try {
        const successRun = extractSuccessCommands(verify.trail);
        if (successRun.length) {
            await savePlanCache(project.id, {
                steps: plan.steps,
                configFiles: plan.configFiles || [],
                source: plan.source,
                context: { tree: plan.context?.tree || null, fingerprint: planFingerprint, successRun },
            });
            console.error(`[twoStage] success run cached (${successRun.length} commands)`);
        }
    } catch (e) {
        console.error('[twoStage] save success run error:', e.message);
    }

    report({ stage: 'preview', message: '阶段 2 通过，创建预览隧道' });
    let preview = null;
    try {
        // 只停"该 session"的旧 preview 隧道（多 session 并发部署互不干扰，不误停其它 session）
        try {
            const oldConds = [eq(schema.deployments.projectId, project.id), eq(schema.deployments.status, 'running')];
            if (sessionId) oldConds.push(eq(schema.deployments.sessionId, sessionId));
            const oldRows = await db.select({ id: schema.deployments.id }).from(schema.deployments).where(and(...oldConds));
            for (const r of oldRows) { try { stopTunnel(r.id); } catch { /* ignore */ } }
        } catch { /* ignore */ }
        const now = Date.now();
        const deploymentId = `dep_${crypto.randomBytes(8).toString('hex')}`;
        // 用 verify 探测到的真实应用端口（agent 可能在非默认端口上 serve），兜底回退 defaultPort。
        let port = verify?.appPort || detected.defaultPort || 3000;
        let served = null;
        console.error(`[twoStage] preview: verify.ok=${verify.ok} verify.appPort=${verify?.appPort ?? 'null'} -> using port ${port}`);
        // verify 已通过健康检查且有 appPort：verify serve 的就是完整应用（自包含，如 deepseek 的
        // bin.js web、fastapi 的 uvicorn 都是 serve 前端+后端）。tunnel 前先套一层"改写反代"：
        // 保留完整应用（含 /plugins、后端 API），只把 HTML 里的绝对资源路径改写为相对路径，
        // 适配 /preview/<id>/ 子路径，避免 /assets、/api 泄漏到宿主源（否则 401 / MIME text-html）。
        // 若改写反代起不来（端口竞争等）再退化为直接 tunnel verify 端口。
        // 仅当 verify 无 appPort（纯静态或 verify 未真正起服务）时才用聚合 serve dist 兜底。
        if (verify?.appPort) {
            const proxyPort = (await getGuestFreePort(ref)) || 0;
            if (proxyPort) {
                const proxyOk = await startRewriteProxy({
                    runtimeRef: ref, workspacePath: wsPath,
                    upstreamPort: verify.appPort, listenPort: proxyPort,
                    onLog: (m) => console.error(`[twoStage] ${m}`),
                });
                if (proxyOk) {
                    port = proxyPort;
                    console.error(`[twoStage] preview: rewrite proxy :${proxyPort} -> verify app :${verify.appPort}`);
                } else {
                    console.error(`[twoStage] preview: rewrite proxy failed on :${proxyPort}, tunneling verify port ${verify.appPort} directly`);
                }
            } else {
                console.error(`[twoStage] preview: no free guest port for rewrite proxy, tunneling verify port ${verify.appPort} directly`);
            }
        } else {
            served = await ensureFrontendServed({ runtimeRef: ref, workspacePath: wsPath, port, onLog: (m) => console.error(`[twoStage] ${m}`) });
            if (served.ok) port = served.port;
            console.error(`[twoStage] preview: verify had NO appPort, fell back to aggregate serve port ${port}`);
        }
        const tunnel = await createTunnel({ deploymentId, workspacePath: wsPath, runtimeRef: ref, vmPort: port, projectId: project.id });
        await db.insert(schema.deployments).values({
            id: deploymentId, userId, projectId: project.id, sessionId: sessionId || null, runtimeId,
            kind: 'preview', status: 'running', revision: 'live',
            publicUrl: tunnel.publicUrl, internalRef: tunnel.internalRef,
            expiresAt: now + PREVIEW_TTL_MS, createdAt: now, updatedAt: now, createdBy: userId,
        });
        // The verify agent already started the app in the background (guest) and health-checked it,
        // so we do NOT re-launch the serve command here — re-running it would hit a port conflict.
        const previewToken = await deploymentService.issuePreviewToken(deploymentId);
        preview = { deploymentId, publicUrl: tunnel.publicUrl, previewToken };
    } catch (e) {
        return { ok: false, stage: 'preview', plan, verify, error: `preview failed: ${e.message}`, elapsedMs: Date.now() - startedAt };
    }

    report({ stage: 'done', message: '✓ 两阶段通过，preview ready' });
    return {
        ok: true, plan, verify,
        previewUrl: preview.publicUrl, deploymentId: preview.deploymentId, previewToken: preview.previewToken,
        elapsedMs: Date.now() - startedAt,
    };
}

function registerAutoDeployRoutes(fastify, { getProjectForUser }) {
    fastify.post('/api/v1/projects/:projectId/auto-deploy', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
        // SSE 流式返回：实时推送部署阶段（stage A 分析 / B 部署 / preview），
        // 让前端分阶段展示（阶段 1 结束有明确提示）。最终结果作为最后一个事件。
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        reply.raw.write(': ok\n\n');
        const send = (payload) => {
            try { reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* client closed */ }
        };
        try {
            const result = await runAutoTwoStageDeploy({
                projectId: request.params.projectId,
                userId: request.user.id,
                role: request.user.role,
                getProjectForUser,
                resume: Boolean(request.body?.resume),
                sessionId: request.query?.session_id || request.body?.session_id,
                onProgress: (p) => send({ type: 'progress', ...p }),
            });
            send({ type: 'result', result });
        } catch (err) {
            request.log.error(err);
            send({ type: 'error', error: err.message || String(err) });
        } finally {
            try { reply.raw.end(); } catch (_) {}
        }
    });
}

module.exports = { registerAutoDeployRoutes, runAutoTwoStageDeploy, detectProjectType };
