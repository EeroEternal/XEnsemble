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
const { signBlinkToken } = require('../preview/blinkToken');
const { resolveControlPlanePublicUrlSync } = require('../llm/publicUrl');
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
const DEPLOY_TOTAL_TIMEOUT_MS = Number(process.env.DEPLOY_TOTAL_TIMEOUT_MS) || 15 * 60 * 1000;

// 在 stage A 之前 fetch sandbox projectDir 的 origin/main，让 stage A LLM 看到最新代码。
// 不做 reset --hard：保留用户在工作目录的未提交改动（平台在 /var/lib/.../proj_xxx 上
// 有时存在 agentharness/xxx 之类的 session 分支上的 uncommitted 改动；reset 会丢）。
// 只读操作不会破坏用户工作区，但能保证 detectProjectType / collectProjectContext
// 读到的源码与 IDE pull 后的 main 一致。
async function syncProjectToLatestMain(project) {
    const hostPath = workspace.projectDir(project.userId, project.id);
    if (!fs.existsSync(path.join(hostPath, '.git'))) return;
    const baseBranch = project.repoDefaultBranch || 'main';
    try {
        const started = Date.now();
        execSync(
            `git fetch origin ${baseBranch} --no-tags --prune`,
            { cwd: hostPath, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 },
        );
        console.error(`[twoStage] fetched origin/${baseBranch} for ${project.id} in ${Date.now() - started}ms`);
    } catch (e) {
        // offline / no remote / 等情况非致命：fall back to whatever is in the working tree
        console.error(`[twoStage] fetch origin/${baseBranch} failed (non-fatal): ${e.message?.slice(0, 200)}`);
    }
}

// 给长耗时异步操作加总超时：超时返回 fallback（不阻塞调用方），并通过 onTimeout 通知真正中止底层工作，
// 避免只丢弃结果而底层 agent 继续跑（僵尸进程/资源泄漏）。
function withTimeout(promise, ms, fallback, onTimeout) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (onTimeout) {
                try { onTimeout(); } catch (e) { process.stderr.write(`[withTimeout] onTimeout error: ${e.message}\n`); }
            }
            process.stderr.write(`[twoStage] deploy total timeout (${Math.round(ms / 60000)}min), cancelling verify agent project\n`);
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

// 项目内容指纹：用户期望的 main HEAD（origin/<baseBranch>）+ 关键 manifest 哈希。
// 用 origin/<baseBranch> 而非 sandbox projectDir 的 active branch HEAD ——
// sandbox projectDir 可能卡在 agentharness/xxx 老 session 分支上（8.24 落后 main 13+ commit），
// 用 active branch 会让 cache 永远命中；用 origin/main 反映用户 IDE pull 后的内容。
// 改动 1：fingerprint 升级（多语言 manifests + origin/main）
function computeProjectFingerprint(hostWs, wsPath) {
    const base = (hostWs && fs.existsSync(hostWs)) ? hostWs : (wsPath || '');
    if (!base) return null;

    // 1) 读取 origin/<baseBranch> SHA（用户 IDE 拉到的 main）
    let mainSha = '';
    try {
        const baseBranch = execSync(
            'git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD',
            { cwd: base, stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 },
        ).toString().trim().replace(/^origin\//, '') || 'main';
        // 优先用项目配置里的默认分支
        const repoDefault = (() => {
            try {
                const cfg = fs.readFileSync(path.join(base, '.git', 'config'), 'utf8');
                const m = cfg.match(/\[branch "([^"]+)"\][^\[]*?remote = origin[^\[]*?merge = refs\/heads\/([^"\n]+)/);
                if (m && m[2]) return m[2].trim();
            } catch { /* ignore */ }
            return null;
        })();
        const effectiveBranch = repoDefault || baseBranch;
        mainSha = execSync(`git rev-parse origin/${effectiveBranch}`, { cwd: base, stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 })
            .toString().trim();
    } catch { /* 无 git / 无 remote / fetch 失败 —— 回退 manifest 哈希 */ }

    // 2) 多语言关键 manifest 哈希（任何一项变了 → fingerprint 变 → cache 失效）
    const manifests = [
        // node
        'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'package.json',
        // python
        'requirements.txt', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'Pipfile',
        'pyproject.toml', 'setup.py',
        // go / rust
        'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
        // ruby / php / .net / java
        'Gemfile', 'Gemfile.lock', 'composer.json', 'composer.lock',
        'packages.lock.json', 'pom.xml', 'build.gradle', 'build.gradle.kts',
    ];
    const h = crypto.createHash('sha256');
    let any = false;
    for (const m of manifests) {
        const p = path.join(base, m);
        try {
            if (fs.existsSync(p)) { h.update(`${m}:${fs.readFileSync(p, 'utf8')}\n`); any = true; }
        } catch { /* ignore */ }
    }
    const manifestHash = h.digest('hex').slice(0, 16);

    return mainSha
        ? `main:${mainSha.slice(0, 12)}:files:${manifestHash}`
        : `files:${manifestHash}`;
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
        // 无 fingerprint 的旧格式缓存也一律作废，让下次保存带上指纹（渐进升级）。
        // 注意不能用 `fingerprint &&` 短路：fingerprint 为 null 时旧缓存会永不过期，
        // 导致改了 analyze 逻辑后二次部署仍复用旧静态计划（boxlite 下 hostWs 可能 undefined）。
        if (!plan.context?.fingerprint || plan.context?.fingerprint !== fingerprint) {
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
    // Delegated to the shared detectStack module; this wrapper preserves
    // the twoStage-specific `devKind` / `devDir` fields (used by
    // startLiveDevServer to pick a sub-directory for monorepo frontends).
    const { detectStack } = require('./detectStack');
    const stack = detectStack(hostWorkspacePath);
    if (!hostWorkspacePath || !stack || stack.type === 'unknown') {
        return {
            type: stack?.type || 'unknown',
            defaultPort: stack?.defaultPort || 3000,
            installCmd: stack?.installCmd || null,
            buildCmd: stack?.buildCmd || null,
            startCmd: stack?.startCmd || null,
            devKind: null,
            devDir: '.',
        };
    }
    return enrichWithDevKind(stack, hostWorkspacePath);
}

function enrichWithDevKind(stack, hostWorkspacePath) {
    const fs = require('fs');
    const path = require('path');
    const has = (n) => { try { return fs.existsSync(path.join(hostWorkspacePath, n)); } catch { return false; } };
    const readJson = (n) => { try { return JSON.parse(fs.readFileSync(path.join(hostWorkspacePath, n), 'utf8')); } catch { return null; } };

    // live 模式专用：探测 monorepo 子前端（web/frontend/client/app），
    // 因为 monorepo 根 dev 常是 concurrently/electron 聚合，不是 web 前端。
    // 子目录优先级：vite > next > nuxt > 有 dev script 的 npm 项目。
    const detectSubDev = () => {
        const dirs = ['web', 'frontend', 'client', 'app'];
        for (const d of dirs) {
            if (!has(path.join(d, 'package.json'))) continue;
            const p = readJson(path.join(d, 'package.json')) || {};
            const deps = { ...(p.dependencies || {}), ...(p.devDependencies || {}) };
            const scripts = p.scripts || {};
            if (deps.vite) return { devKind: 'vite', dir: d };
            if (deps.next) return { devKind: 'next', dir: d };
            if (deps.nuxt) return { devKind: 'nuxt', dir: d };
            if (scripts.dev) return { devKind: 'npm', dir: d };
        }
        return null;
    };
    // devKind 仅在根目录能直接启动 dev server 时（vite/next/nuxt）赋值；
    // dev script 兜底留给 startLiveDevServer 自己根据 devKind==='npm' 走 PORT。
    let devKind = stack.framework;
    let devDir = '.';
    if (stack.type === 'monorepo' || !devKind) {
        const sub = detectSubDev();
        if (sub) { devKind = sub.devKind; devDir = sub.dir; }
    }
    return {
        type: stack.type,
        defaultPort: stack.defaultPort,
        installCmd: stack.installCmd,
        buildCmd: stack.buildCmd,
        startCmd: stack.startCmd,
        devKind,
        devDir,
    };
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

// 实时预览（live 模式）：在 guest 内常驻启动 dev server（HMR / 文件感知），
// 改文件后刷新即可见，无需重新 build。尽力而为：起不来返回 ok:false，由调用方回退静态 serve。
async function startLiveDevServer({ runtimeRef, workspacePath, devKind, devDir, defaultPort, base, onLog }) {
    const runtime = getRuntime();
    const livePort = (await getGuestFreePort(runtimeRef)) || Number(defaultPort) || 5173;
    const targetDir = devDir || '.';
    const startLog = '/tmp/live-dev.log';
    // vite 用显式 --port + --strictPort（export PORT 对 vite 无效，默认 5173 常被沙箱占位服务占用），
    // 并用 --base 让 vite 生成的所有资源/模块路径都带 /preview/<id>/ 前缀（否则绝对路径脱离前缀→白屏）；
    // VITE_API_BASE=/preview/<id>/ 让 dev 前端用带前缀的相对路径 /preview/<id>/api/...，经网关+隧道
    // 反代到沙箱后端（前后端都可用）。注意不能设成 /：那会让 API 丢前缀、直接打到宿主 8089 而 401。
    // next/nuxt 用各自 dev 命令；CRA/webpack 等通用 npm 项目用 PORT 环境变量。
    const baseArg = base ? ` --base ${base}` : '';
    const apiBaseArg = base ? `VITE_API_BASE=${base}` : '';
    let startCmd;
    if (devKind === 'vite') {
        startCmd = `cd ${targetDir} && ${apiBaseArg} npx vite --host 0.0.0.0 --port ${livePort} --strictPort${baseArg}`;
    } else if (devKind === 'next') {
        startCmd = `cd ${targetDir} && PORT=${livePort} npx next dev -H 0.0.0.0 -p ${livePort}`;
    } else if (devKind === 'nuxt') {
        startCmd = `cd ${targetDir} && PORT=${livePort} HOST=0.0.0.0 npx nuxt dev --port ${livePort}`;
    } else {
        startCmd = `cd ${targetDir} && PORT=${livePort} BROWSER=none npm run dev`;
    }
    try {
        await runtime.exec.exec('sh', ['-c', `(setsid nohup sh -c '${startCmd}' > ${startLog} 2>&1 &) && echo started`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
    } catch (e) {
        if (onLog) onLog(`live dev server spawn failed: ${e.message}`);
        return { ok: false, reason: e.message };
    }
    // 轮询探测 livePort，最多等 40s（vite 冷启动 + dep 预构建可能 10~30s）
    let code = '';
    for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
            const probe = await runtime.exec.exec(
                'sh', ['-c', `curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:${livePort}/`], {},
                { runtimeRef, cwd: workspacePath, timeoutMs: 8000 },
            );
            code = String(probe.stdout || '').trim();
            if (/^[23]\d\d$/.test(code)) break;
        } catch { /* keep waiting */ }
    }
    if (!/^[23]\d\d$/.test(code)) {
        const log = await runtime.exec.exec('sh', ['-c', `tail -n 30 ${startLog} 2>/dev/null`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 8000 });
        if (onLog) onLog(`live dev server not ready on :${livePort} (http ${code || '000'}) log=${String(log.stdout || '').slice(0, 400)}`);
        return { ok: false, reason: `live dev server not ready (http ${code || '000'})` };
    }
    if (onLog) onLog(`live dev server ready on :${livePort} (${devKind})`);
    return { ok: true, port: livePort };
}

// live 模式聚合代理：/api/* → 后端；其它 → vite dev server（实时预览，前后端都可用）。
// base 传给代理，转发 vite 请求时补回 /preview/<id>/ 前缀（vite 配了该 base，不带会 302 死循环）。
async function startViteAggregateProxy({ runtimeRef, workspacePath, devPort, backendPort, listenPort, base, onLog }) {
    const runtime = getRuntime();
    let proxyPath = null;
    try {
        const script = require('fs').readFileSync(path.join(__dirname, '../preview/previewProxyServer.js'), 'utf8');
        await runtime.fs.fsWrite(workspacePath, '.agents/previewProxyServer.cjs', script, { runtimeRef });
        proxyPath = '.agents/previewProxyServer.cjs';
    } catch (e) {
        if (onLog) onLog(`write live proxy script failed: ${e.message}`);
        return false;
    }
    try {
        await runtime.exec.spawn(
            'node',
            [proxyPath, '--live', String(devPort), String(backendPort), String(listenPort), base || ''],
            { HOME: process.env.HOME || '/root', PATH: process.env.PATH || '/usr/bin:/bin' },
            { runtimeRef, cwd: workspacePath },
        );
    } catch (e) {
        if (onLog) onLog(`spawn live proxy failed: ${e.message}`);
        return false;
    }
    for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 600));
        try {
            const check = await runtime.exec.exec(
                'sh', ['-c', `curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:${listenPort}/`],
                {},
                { runtimeRef, cwd: workspacePath, timeoutMs: 8000 },
            );
            if (String(check.stdout || '').startsWith('2')) return true;
        } catch { /* retry */ }
    }
    if (onLog) onLog(`live aggregate proxy did not come up on :${listenPort}`);
    return false;
}

// 将宿主编译好的 unigateway 二进制注入沙箱，使被部署应用的「网关」功能可用。
// 背景：被部署的 xensemble 后端启动时会自动拉起 unigateway（GatewaySettings auto_start 默认 true），
// 但只在默认路径 /workspace/gateway/target/release/xensemble-unigateway 存在二进制时才能成功；
// 沙箱部署时 verify 只 build 前端+起后端，不会编译 Rust 网关，导致「配网关」打不开。
// 11MB 二进制无法用单条 fsWrite（base64 单参数超过 argv 上限），故分块 gzip+base64 传输。
async function injectGatewayBinary(runtimeRef, workspacePath, onLog) {
    const runtime = getRuntime();
    const hostBinary = path.join(__dirname, '../../../gateway/target/release/xensemble-unigateway');
    let bin;
    try {
        bin = require('fs').readFileSync(hostBinary);
    } catch {
        if (onLog) onLog(`gateway binary not found at ${hostBinary}, skip injection`);
        return false;
    }
    const target = '/workspace/gateway/target/release/xensemble-unigateway';
    const tmpB64 = '/tmp/ug.b64.gz';
    const zlib = require('zlib');
    const b64 = zlib.gzipSync(bin, { level: 9 }).toString('base64');
    const CHUNK = 120000; // 低于 Linux 单参数上限 128KB，留安全余量
    try {
        await runtime.exec.exec('sh', ['-c', `: > ${tmpB64}`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 10000 });
        for (let i = 0; i < b64.length; i += CHUNK) {
            const piece = b64.slice(i, i + CHUNK);
            await runtime.exec.exec('sh', ['-c', `printf '%s' "$1" >> "$2"`, 'sh', piece, tmpB64], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 20000 });
        }
        await runtime.exec.exec(
            'sh',
            ['-c', `mkdir -p "$(dirname '${target}')" && base64 -d ${tmpB64} | gzip -d > ${target} && chmod +x ${target} && rm -f ${tmpB64}`],
            {},
            { runtimeRef, cwd: workspacePath, timeoutMs: 60000 },
        );
    } catch (e) {
        if (onLog) onLog(`gateway binary injection failed: ${e.message}`);
        return false;
    }
    if (onLog) onLog(`gateway binary injected to ${target}`);
    return true;
}

// 注入 blink 反向代理配置：写入沙箱 /workspace/server/.blink.env，
// 使被部署应用（xensemble 自身）经 /preview/<id>/__blink 访问宿主 blink-server，
// 从而在预览里创建 boxlite 隔离的 agent session（沙箱 guest 无 KVM，无法自身起 blink）。
async function injectBlinkEnv(runtimeRef, workspacePath, deploymentId, blinkApiUrl, blinkToken, onLog) {
    const runtime = getRuntime();
    const content = `BLINK_API_URL=${blinkApiUrl}\nBLINK_AUTH_TOKEN=${blinkToken}\nXENSEMBLE_DEPLOYMENT_ID=${deploymentId}\n`;
    try {
        await runtime.fs.fsWrite(workspacePath, 'server/.blink.env', content, { runtimeRef });
        if (onLog) onLog(`blink env injected: BLINK_API_URL=${blinkApiUrl}, deploymentId=${deploymentId}`);
        return true;
    } catch (e) {
        if (onLog) onLog(`blink env injection failed: ${e.message}`);
        return false;
    }
}

// 在沙箱内起 blink 转发器：监听 127.0.0.1:8787，转发到宿主 /preview/<id>/__blink 并注入 token。
// 被部署的 xensemble 后端可能是旧代码（无 token 头、无 .blink.env 支持），默认连 127.0.0.1:8787；
// 转发器让旧代码无需感知代理与鉴权即可经宿主 blink 创建 boxlite session。
async function startBlinkForwarder(runtimeRef, workspacePath, blinkApiUrl, blinkToken, onLog) {
    const runtime = getRuntime();
    try {
        const script = require('fs').readFileSync(path.join(__dirname, '../preview/blinkForwarder.cjs'), 'utf8');
        await runtime.fs.fsWrite(workspacePath, '.agents/blinkForwarder.cjs', script, { runtimeRef });
    } catch (e) {
        if (onLog) onLog(`write blink forwarder failed: ${e.message}`);
        return false;
    }
    try {
        // 先清理旧转发器（重新部署时残留，占着 8787 端口）；沙箱 guest 无 pkill，用 fuser 按端口杀。
        await runtime.exec.exec('sh', ['-c', 'fuser -k 8787/tcp 2>/dev/null; sleep 1; true'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 }).catch(() => {});
        // 用 spawn 起转发器（与 previewProxyServer 一致）：exec 方式起的 detached 进程会随 exec 会话
        // WS 关闭被 blink 清理，导致转发器在部署后悄悄挂掉（表现为创建 workspace 时 exec 超时）。
        await runtime.exec.spawn(
            'node',
            ['.agents/blinkForwarder.cjs'],
            {
                BLINK_UPSTREAM: blinkApiUrl,
                BLINK_TOKEN: blinkToken,
                HOME: process.env.HOME || '/root',
                PATH: process.env.PATH || '/usr/bin:/bin',
            },
            { runtimeRef, cwd: workspacePath },
        );
    } catch (e) {
        if (onLog) onLog(`spawn blink forwarder failed: ${e.message}`);
        return false;
    }
    // 等转发器就绪：对 8787 发起健康探测（转发到宿主 __blink/api/health，gateway 返回 blink health 200）。
    for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 600));
        try {
            const chk = await runtime.exec.exec(
                'sh', ['-c', 'curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/health'],
                {}, { runtimeRef, cwd: workspacePath, timeoutMs: 8000 },
            );
            if (String(chk.stdout || '').startsWith('2')) {
                if (onLog) onLog(`blink forwarder ready on 127.0.0.1:8787 -> ${blinkApiUrl}`);
                return true;
            }
        } catch { /* retry */ }
    }
    if (onLog) onLog('blink forwarder did not come up on 127.0.0.1:8787');
    return false;
}

// 依赖缓存检测（改动 2：多语言 + monorepo-aware + per-subpackage 状态）。
// 返回 { overallCached, perPackage: { '<subdir>': 'CACHED'|'STALE'|'STALE_LOCK'|'STALE_PKG'|'MISSING'|'NO_LOCKFILE' } }
// 沙箱内按 stack.type 跑对应探测脚本（node / node-monorepo / python / go / rust / none），
// 整体缓存判断保留性能优化（deps 命中时跳过 install），但精确到子包 —— 避免 xensemble
// 这种 monorepo 把 server deps 命中当作整体 CACHED、漏装 web/katex。
async function detectDepsCached(runtimeRef, workspacePath, stack) {
    const runtime = getRuntime();
    const { buildDetectScript, parseDepsStatus } = require('./detectStack');
    const script = buildDetectScript(stack);
    try {
        const r = await runtime.exec.exec(
            'sh',
            ['-c', script],
            {},
            { runtimeRef, cwd: workspacePath, timeoutMs: 30000 },
        );
        const status = parseDepsStatus(r.stdout);
        if (Object.keys(status.perPackage).length === 0) {
            // 探测脚本没产出任何子包行（unknown / parse 失败）→ 保守按 STALE 处理
            return { overallCached: false, perPackage: {} };
        }
        return status;
    } catch (e) {
        console.error('[twoStage] detectDepsCached failed (non-fatal):', e.message?.slice(0, 200));
        return { overallCached: false, perPackage: {} };
    }
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

// 兜底：阶段 A 没产出含 DATABASE_URL 的 configFiles 时（如 Go 后端把连接串写死在
// start-server.sh / docker-compose.yml / main.go 里），直接扫 guest 文件提取连接信息，
// 让系统侧照样能幂等建库建用户，免去 agent 试错。
async function parseDbInfoFromGuest(runtimeRef, workspacePath) {
    const runtime = getRuntime();
    try {
        const r = await runtime.exec.exec('sh', ['-c',
            `grep -hoE 'postgres(ql)?://[A-Za-z_][A-Za-z0-9_]*:[^@[:space:]\"\\''@]+@[^[:space:]\"\\''/]+/[A-Za-z0-9_-]+' `
            + `start-server.sh .env .env.example server/.env server/.env.example apps/*/.env apps/*/.env.example docker-compose*.yml Makefile `
            + `cmd/*/*.go cmd/*/main.go internal/*/*.go server/cmd/*/*.go 2>/dev/null | head -3`,
        ], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
        const lines = String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
            const m = line.match(/postgres(?:ql)?:\/\/([^:\s@'\"\/]+):([^@\s'\"]+)@[^\/\s'\"]+\/([A-Za-z0-9_-]+)/);
            if (!m) continue;
            const [, user, pass, db] = m;
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(user) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(db)) {
                return { user, pass, db };
            }
        }
    } catch { /* scan failed — fall through */ }
    return null;
}

// 系统侧自动 provision PostgreSQL：检测项目是否需要 PG，需要则启动沙箱内 PG，
// 并尝试从配置解析出连接信息后直接建库建用户（幂等），使 verify agent 只需跑 migration。
async function provisionPostgresIfNeeded(runtimeRef, workspacePath, plan) {
    const runtime = getRuntime();
    let needs = false;
    try {
        // 检测面覆盖多语言后端：Node（package.json 里的 pg/pg-promise）、Go（pgx / postgres:// 连接串、
        // go.mod）、docker-compose（postgres 服务）、启动脚本/Makefile（DATABASE_URL 写死在
        // start-server.sh 这类文件里，如 AgentHarness 的 Go 后端）。
        const r = await runtime.exec.exec('sh', ['-c', `
            grep -lE '\\"(pg|postgres)\\"|pg-promise|pgx|postgres://' package.json server/package.json apps/*/package.json go.mod 2>/dev/null
            find . -maxdepth 3 \\( -name 'schema.sql' -o -name 'init.sql' \\) 2>/dev/null | grep -v node_modules | head -3
            grep -lE 'DATABASE_URL|POSTGRES_HOST|POSTGRES_DB|POSTGRES_USER' .env server/.env .env.example server/.env.example apps/*/.env apps/*/.env.example start-server.sh Makefile docker-compose.yml docker-compose.deploy.yml docker-compose.selfhost.yml 2>/dev/null
        `], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
        needs = Boolean(String(r.stdout || '').trim());
    } catch { needs = false; }
    if (!needs) return { ready: false };

    try {
        // base 镜像可能未装 PostgreSQL（Debian bookworm 默认无）→ 先 apt 安装。
        // 幂等：已装则跳过，避免重复 update/install 浪费时间。
        const install = `
            pkill -9 apt-get 2>/dev/null; pkill -9 dpkg 2>/dev/null; sleep 1
            rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock
            if ! command -v pg_isready >/dev/null 2>&1 && ! ls /etc/postgresql/*/main 2>/dev/null | grep -q .; then
              export DEBIAN_FRONTEND=noninteractive
              apt-get update -qq 2>/dev/null || true
              apt-get install -y -qq postgresql postgresql-contrib 2>&1 | tail -5
            fi
            (service postgresql start 2>/dev/null || pg_ctlcluster $(ls /etc/postgresql 2>/dev/null | head -1) main start 2>/dev/null) || true
        `;
        await runtime.exec.exec('sh', ['-c', install], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 240000 });
        // 等 PG 真正就绪（最多 30s，apt 安装后首次启动可能偏慢）
        let pgReady = false;
        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            try {
                const chk = await runtime.exec.exec('sh', ['-c', 'pg_isready -q 2>/dev/null && echo UP || echo DOWN'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 8000 });
                if (String(chk.stdout || '').trim() === 'UP') { pgReady = true; break; }
            } catch { /* retry */ }
        }
        if (!pgReady) {
            console.error('[twoStage] postgres start failed: pg_isready not UP after 30s (fallback to agent)');
            return { ready: false };
        }
        console.error('[twoStage] postgres provisioned and ready (pg_isready UP)');
    } catch (e) {
        console.error('[twoStage] postgres start failed (fallback to agent):', e.message);
        return { ready: false };
    }

    // PG 已运行后，若能从配置解析出连接信息则直接建库建用户（幂等），免去 agent 试错。
    // plan.configFiles 解析不到时（Go 后端等把连接串写死在脚本里），兜底扫 guest 文件。
    const info = parseDbInfoFromPlan(plan) || await parseDbInfoFromGuest(runtimeRef, workspacePath);
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

// 沙箱内确保 PostgreSQL 可用：base 镜像（Debian bookworm）默认无 PG，需 apt 安装后启动；
// 幂等：已装/已启动/已建库则跳过。返回 { ok }，供 verify agent 与 xensemble 后端拉起共用。
async function ensureSandboxPostgres(runtimeRef, workspacePath, { user, pass, db } = {}) {
    const runtime = getRuntime();
    const u = user || 'xensemble';
    const p = pass || u;
    const d = db || 'xensemble';
    try {
        const install = `
            pkill -9 apt-get 2>/dev/null; pkill -9 dpkg 2>/dev/null; sleep 1
            rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock
            if ! command -v pg_isready >/dev/null 2>&1 && ! ls /etc/postgresql/*/main 2>/dev/null | grep -q .; then
              export DEBIAN_FRONTEND=noninteractive
              apt-get update -qq 2>/dev/null || true
              apt-get install -y -qq postgresql postgresql-contrib 2>&1 | tail -5
            fi
            (service postgresql start 2>/dev/null || pg_ctlcluster $(ls /etc/postgresql 2>/dev/null | head -1) main start 2>/dev/null) || true
        `;
        await runtime.exec.exec('sh', ['-c', install], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 240000 });
        let ready = false;
        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            try {
                const chk = await runtime.exec.exec('sh', ['-c', 'pg_isready -q 2>/dev/null && echo UP || echo DOWN'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 8000 });
                if (String(chk.stdout || '').trim() === 'UP') { ready = true; break; }
            } catch { /* retry */ }
        }
        if (!ready) return { ok: false, reason: 'postgres not UP after 30s' };
        const pqPass = String(p).replace(/'/g, "''");
        const create = `
            su postgres -c "psql -tAc \\"SELECT 1 FROM pg_roles WHERE rolname='${u}'\\"" 2>/dev/null | grep -q 1 \\
              || su postgres -c "psql -c \\"CREATE USER ${u} WITH PASSWORD '${pqPass}'\\""
            su postgres -c "psql -tAc \\"SELECT 1 FROM pg_database WHERE datname='${d}'\\"" 2>/dev/null | grep -q 1 \\
              || su postgres -c "createdb -O ${u} ${d}"
        `;
        await runtime.exec.exec('sh', ['-c', create], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 60000 });
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

// 探测指定 guest 端口是否为 xensemble 后端（/api/v1/llm/health 返回 JSON，而非静态 HTML/404）。
async function probeBackendApi(runtimeRef, workspacePath, port) {
    const runtime = getRuntime();
    try {
        const r = await runtime.exec.exec(
            'sh', ['-c', `curl -s -m 3 http://127.0.0.1:${port}/api/v1/llm/health 2>/dev/null | head -c 300`],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 8000 },
        );
        // 必须是 JSON（以 { 或 [ 开头），排除静态服务器 404 的 HTML（<!DOCTYPE / <html，含 CSS 大括号 { 会误判）。
        const body = String(r.stdout || '').trim();
        return /^[{[]/.test(body) && !/^<!doctype/i.test(body) && !/^<html/i.test(body);
    } catch { return false; }
}

// 确定性拉起嵌套的 xensemble 后端：verify agent 常只 serve 前端 dist（web/dist）而漏起后端，
// 登录/注册 API 无人响应。此处系统侧强制：
//   - 若 verify.appPort 已是可用后端（/api 健康检查返回 JSON）则复用；
//   - 否则确保沙箱 PG（安装+启动+建库）→ db:migrate → node src/server.js（后端同时 serve
//     web/dist 前端与 /api，单端口全栈），轮询到健康。
// 返回实际后端端口（作为 tunnel 目标），保证登录/注册/API 全部可用。
// previewPublicUrl（如 http://IP:8099/preview/dep_x/）：注入后端 CONTROL_PLANE_PUBLIC_URL /
// ALLOWED_ORIGINS，使嵌套后端生成的预览/网关 URL 落在宿主预览端口，且前端 CORS 放行。
async function ensureXensembleBackend({ runtimeRef, workspacePath, preferredPort, previewPublicUrl, onLog }) {
    const runtime = getRuntime();
    // 1) 复用已就绪后端（verify 可能已起过，探测健康 API）
    const candidates = [...new Set([preferredPort, 3888, 3000, 8000, 8080].filter((x) => Number(x) > 0))];
    for (const p of candidates) {
        if (await probeBackendApi(runtimeRef, workspacePath, p)) {
            if (onLog) onLog(`reuse existing nested backend on :${p}`);
            return { ok: true, port: p };
        }
    }
    // 2) 确保 PG（幂等安装 + 启动 + 建库）
    const pg = await ensureSandboxPostgres(runtimeRef, workspacePath, { user: 'xensemble', pass: 'xensemble', db: 'xensemble' });
    if (!pg.ok) {
        if (onLog) onLog(`sandbox postgres provision failed: ${pg.reason}`);
        return { ok: false, reason: `postgres provision failed: ${pg.reason}` };
    }
    // 3) 读 server/.env（DATABASE_URL 等），spawn 后端时注入；无 .env 时用默认
    let envExtra = {};
    try {
        const envText = await runtime.fs.fsRead(workspacePath, 'server/.env', { runtimeRef, encoding: 'utf8' });
        for (const line of String(envText || '').split('\n')) {
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
            if (m) envExtra[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
        }
    } catch { /* no .env, use defaults */ }
    // 4) 构造运行环境（含 .env 的 DATABASE_URL 等），db:migrate 与后端 spawn 共用
    const backendPort = (await getGuestFreePort(runtimeRef)) || 3888;
    // 嵌套后端须指向宿主预览端口：CONTROL_PLANE_PUBLIC_URL 决定其生成的 preview/LLM 网关 URL，
    // ALLOWED_ORIGINS 需放行宿主预览端口（浏览器经 8099 访问，CORS 校验源）。覆盖 .env 里的
    // 127.0.0.1:3888（对嵌套部署无效），避免嵌套后端内部链接落到不可达地址。
    const previewUrl = String(previewPublicUrl || '').replace(/\/+$/, '');
    // 浏览器访问的是预览端口宿主（origin = scheme://host，无路径），CORS 需放行该 origin。
    let previewOrigin = '';
    try { previewOrigin = previewUrl ? new URL(previewUrl).origin : ''; } catch { /* ignore */ }
    const spawnEnv = {
        ...envExtra,
        PORT: String(backendPort),
        NODE_ENV: 'production',
        // 覆盖 .env 里的相对 WORKSPACE_ROOT：
        // 嵌套后端 cwd=/workspace/server，相对路径会解析成 /workspace/server/server/data/workspaces
        // （双重 server），把嵌套 workspace 数据写进宿主 git worktree → 宿主文件区出现大量变更，
        // 且嵌套文件区按错误路径读不到 → 变空。统一用宿主 control plane 的绝对路径（通常
        // /var/lib/xensemble/{workspaces,repos,unigateway}，由 install.sh 注入 xensemble.env），
        // 嵌套与宿主写到同一个 runtime 目录，宿主文件区永远干净、嵌套数据可读写。
        WORKSPACE_ROOT: process.env.WORKSPACE_ROOT || '/var/lib/xensemble/workspaces',
        BARE_REPO_ROOT: process.env.BARE_REPO_ROOT || '/var/lib/xensemble/repos',
        UNIGATEWAY_DATA_DIR: process.env.UNIGATEWAY_DATA_DIR || '/var/lib/xensemble/unigateway',
        // 生产模式后端默认不自动迁移；嵌套部署无外部 migrate 步骤，强制后端启动时执行迁移。
        RUN_DB_MIGRATE: '1',
        // 嵌套 .env 的 UNIGATEWAY_ADMIN_TOKEN 常为占位符，production 启动会抛错退出；
        // 注入真实 token（优先宿主值，缺失时随机生成），保证嵌套后端能拉起 unigateway。
        UNIGATEWAY_ADMIN_TOKEN: envExtra.UNIGATEWAY_ADMIN_TOKEN
            && envExtra.UNIGATEWAY_ADMIN_TOKEN !== 'change-me-to-a-long-random-admin-token'
            ? envExtra.UNIGATEWAY_ADMIN_TOKEN
            : (process.env.UNIGATEWAY_ADMIN_TOKEN || crypto.randomBytes(32).toString('hex')),
        ...(previewUrl ? {
            CONTROL_PLANE_PUBLIC_URL: previewUrl,
            ALLOWED_ORIGINS: [previewOrigin, previewUrl, 'http://localhost:3888', 'http://127.0.0.1:3888'].filter(Boolean).join(','),
        } : {}),
        HOME: process.env.HOME || '/root',
        PATH: process.env.PATH || '/usr/bin:/bin',
    };
    // db:migrate（幂等；失败不阻断，后端 RUN_DB_MIGRATE=1 启动时会再试）
    try {
        await runtime.exec.exec('sh', ['-c', 'cd server && npm run db:migrate'], spawnEnv, { runtimeRef, cwd: workspacePath, timeoutMs: 240000 });
    } catch (e) {
        if (onLog) onLog(`nested db:migrate failed (continuing): ${e.message}`);
    }
    try {
        await runtime.exec.spawn('node', ['src/server.js'], spawnEnv, { runtimeRef, cwd: `${workspacePath}/server` });
    } catch (e) {
        if (onLog) onLog(`nested backend spawn failed: ${e.message}`);
        return { ok: false, reason: `backend spawn failed: ${e.message}` };
    }
    // 修复沙箱内 git worktree 指针：worktree 的 .git 文件指向宿主绝对路径（沙箱内不可达），
    // 嵌套后端在沙箱内跑 git（status/list 等）会报 "not a git repository" → 嵌套文件区变空。
    // /workspace.git 是挂载进来的主仓库 .git，改指针指向其 worktrees/<wt> 即可让沙箱内 git 可用。
    try {
        await runtime.exec.exec('sh', ['-c',
            `if [ -f /workspace/.git ]; then ` +
            `GITDIR=$(cat /workspace/.git | sed 's/^gitdir: //'); ` +
            `if [ ! -d "$GITDIR" ] && [ -d /workspace.git/worktrees ]; then ` +
            `WTNAME=$(basename "$GITDIR"); ` +
            `if [ -d "/workspace.git/worktrees/$WTNAME" ]; then ` +
            `echo "gitdir: /workspace.git/worktrees/$WTNAME" > /workspace/.git; ` +
            `echo "/workspace/.git" > "/workspace.git/worktrees/$WTNAME/gitdir" 2>/dev/null || true; ` +
            `fi; fi; fi`,
        ], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
    } catch (e) {
        if (onLog) onLog(`nested worktree git pointer fix failed (non-fatal): ${e.message}`);
    }
    // 6) 轮询健康检查（后端冷启动 + 建表，最多 60s）
    for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await probeBackendApi(runtimeRef, workspacePath, backendPort)) {
            if (onLog) onLog(`nested xensemble backend ready on :${backendPort}`);
            return { ok: true, port: backendPort };
        }
    }
    if (onLog) onLog(`nested backend did not become healthy on :${backendPort}`);
    return { ok: false, reason: `backend not healthy on :${backendPort}` };
}

// 部署通过后，系统侧在沙箱内保持前后端服务，并起一个"单端口聚合服务器"
// （静态 serve 前端 dist + 反代 /api 到后端），保证 preview 稳定可连且前后端都可用，
// 不依赖 verify 期间 agent 起的短命进程。返回实际生效的端口（tunnel 连它）。
// 用空闲端口 + spawn 后主动验证，避免残留进程占端口导致聚合没起来却被误判成功。
async function ensureFrontendServed({ runtimeRef, workspacePath, port, base, onLog }) {
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
                    [proxyPath, distAbs, String(listenPort), String(backendOk ? backendPort : 0), '1', base || ''],
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
async function startRewriteProxy({ runtimeRef, workspacePath, upstreamPort, listenPort, base, onLog }) {
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
            [proxyPath, '--upstream', String(upstreamPort), String(listenPort), base || ''],
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
                .set({
                    status: finalStatus,
                    updatedAt: Date.now(),
                    // 超时中止落 last_error_*，前端据此区分"超时"与"用户中止"（均 status=stopped）
                    ...(result?.code === 'deploy_timeout' ? {
                        lastErrorCode: 'deploy_timeout',
                        lastErrorMessage: String(result.error || '部署验证超时').slice(0, 500),
                    } : {}),
                })
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

    // 让 sandbox projectDir 的 origin/main 跟上 IDE pull 的 main（让 stage A 看到最新代码）。
    // 不做 reset --hard —— 只 fetch，避免丢工作目录上的未提交改动。
    await syncProjectToLatestMain(project);

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
    // 被部署应用是否为 xensemble 自身（存在 server/src/gateway）：决定是否注入 unigateway 二进制
    // 与 blink 反向代理配置（预览里配网关 + 创建 boxlite session 均依赖）。
    const isXensemble = fs.existsSync(path.join(hostPath, 'server/src/gateway'));

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
    // 用真实 host 路径（hostPath）而非 hostWs/wsPath —— boxlite 下 hostWs 可能 undefined、
    // wsPath 是沙箱内路径（宿主上不存在），会导致 fingerprint 恒为 null、缓存永不失效。
    let planFingerprint = computeProjectFingerprint(hostPath, wsPath);
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
    // detected 用真实 host 路径（hostPath），而非 hostWs —— boxlite 下 hostWs 可能是 undefined，
    // 用 undefined 会退化成 unknown 类型，连带使依赖缓存判断、PG 预启动、plan 缓存校验全部失效。
    const detected = hostPath ? detectProjectType(hostPath) : { type: 'unknown', defaultPort: 3000 };
    if (isAborted()) {
        return { ok: false, aborted: true, error: '部署已中止', elapsedMs: Date.now() - startedAt };
    }
    // 项目树只扫一次：优先复用阶段 A 已收集的树（fallback 路径已收集；opencode 成功为 null 才在此补一次），
    // 并注入 verify 的 system prompt，避免 verify agent 重新 list_dir/read_file 探索。
    let depsCached = false;
    let depsStatus = null;
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
        // 改动 2：把 stack (detected) 传进去，让 detectDepsCached 选对应语言的探测脚本
        const depsRes = await detectDepsCached(ref, wsPath, detected);
        depsCached = depsRes.overallCached;
        depsStatus = depsRes.perPackage;
        if (Object.keys(depsStatus).length) {
            const stale = Object.entries(depsStatus).filter(([, v]) => v !== 'CACHED');
            if (stale.length) {
                console.error(`[twoStage] deps STALE: ${stale.map(([k, v]) => `${k}=${v}`).join(', ')}`);
            } else {
                console.error(`[twoStage] deps CACHED for all ${Object.keys(depsStatus).length} sub-package(s)`);
            }
        }
        // 系统侧预启动 PostgreSQL（检测到需要时），避免 verify agent 用 su/runuser/sudo 试错
        const dbProvision = await provisionPostgresIfNeeded(ref, wsPath, plan);
        // 注入 unigateway 二进制：仅对被部署应用是 xensemble 类（server/src/gateway 存在）时执行，
        // 使后端能自动拉起网关，预览里「配网关」可用。非此类项目跳过（避免无谓的 11MB 传输）。
        if (isXensemble) {
            await injectGatewayBinary(ref, wsPath, (m) => console.error(`[twoStage] ${m}`));
        }
        // 改动 2：plan.context 同时存 depsCached (boolean, 向后兼容) + depsStatus (per-subpackage)
        plan = { ...plan, context: { tree, depsCached, depsStatus, stack: { type: detected?.type, framework: detected?.framework }, dbReady: dbProvision.ready, dbUser: dbProvision.dbUser || null, dbName: dbProvision.dbName || null, successRun: plan._successRun || null } };
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
    // 阶段 B 子阶段心跳：长任务（单条 run_shell 可能跑几十秒）期间周期复报当前子阶段，
    // 让前端进度条保持"进行中"而非停在旧步骤。纯上报，不改 verify 逻辑。
    let currentSubstage = null;
    let lastSubstageAt = 0;
    const substageHeartbeat = setInterval(() => {
        if (!currentSubstage) return;
        // 子阶段近 10s 无新变化才复报，避免高频刷屏
        if (Date.now() - lastSubstageAt < 10000) return;
        lastSubstageAt = Date.now();
        report({ stage: 'B', substage: currentSubstage, message: `阶段 2 · ${currentSubstage}` });
    }, 5000);

    const verify = await withTimeout(
        analyzeProjectVerify({
            workspacePath: wsPath,
            hostWorkspacePath: hostWs,
            runtimeRef: ref,
            plan,
            projectType: detected,
            resume: resumeState ? { messages: resumeState.messages, trail: resumeState.trail, roundsUsed: resumeState.roundsUsed } : undefined,
            isAborted: () => isAborted(),
            // 阶段 B 子阶段透传：前端分步展示（prepare/build/serve/check/fix）。
            // 不改 verify 逻辑，仅把 verify 侧推断的子阶段转发为 SSE progress。
            onSubstage: (substage, hint) => {
                currentSubstage = substage;
                lastSubstageAt = Date.now();
                report({ stage: 'B', substage, message: hint || `阶段 2 · ${substage}` });
            },
        }),
        DEPLOY_TOTAL_TIMEOUT_MS,
        {
            ok: false,
            aborted: true,
            code: 'deploy_timeout',
            error: `部署验证超时（超过 ${Math.round(DEPLOY_TOTAL_TIMEOUT_MS / 60000)} 分钟）已自动中止`,
            warning: '部署验证卡住超时，已自动中止。常见原因是沙箱内启动服务的命令未后台化（缺少 & / nohup ... &），run_shell 一直等待。',
        },
        () => {
            // 超时真正中止：置 cancelled，让仍在跑的 verify agent 在下一轮检查时退出
            deployState.cancelled = true;
            console.error(`[twoStage] deploy total timeout (${Math.round(DEPLOY_TOTAL_TIMEOUT_MS / 60000)}min), cancelling verify agent project=${project.id}`);
        },
    );
    clearInterval(substageHeartbeat);
    if (verify.aborted) {
        return { ok: false, aborted: true, code: verify.code || undefined, error: verify.error || '部署已中止', elapsedMs: Date.now() - startedAt };
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
        let mode = 'static';
        const previewLog = (m) => console.error(`[twoStage] ${m}`);
        console.error(`[twoStage] preview: verify.ok=${verify.ok} verify.appPort=${verify?.appPort ?? 'null'} -> using port ${port}`);

        // xensemble 自身嵌套部署：verify agent 常只 serve 前端 dist（web/dist）而漏起后端，
        // 登录/注册 API 无人响应。系统侧确定性拉起后端（PG + db:migrate + node src/server.js）。
        // 成功后保留其端口供下方 live 聚合代理的 /api 反代使用（不再强制 mode=static，
        // 让 xensemble 也能走 vite dev server 实时预览；live 失败才回退到后端单端口全栈）。
        let xensBackend = null;
        if (isXensemble) {
            // 后端生成的预览 URL 落宿主预览端口（PREVIEW_PUBLIC_URL + deploymentId），
            // 未配置 preview 端口时回退控制面 URL 的 /preview/<id> 路径（与 createTunnel 一致）。
            const previewBase = (process.env.PREVIEW_PUBLIC_URL || '').trim()
                || resolveControlPlanePublicUrlSync();
            const previewPublicUrl = `${previewBase.replace(/\/+$/, '')}/preview/${deploymentId}/`;
            const be = await ensureXensembleBackend({
                runtimeRef: ref, workspacePath: wsPath,
                preferredPort: verify?.appPort || detected.defaultPort || 0,
                previewPublicUrl,
                onLog: previewLog,
            });
            if (be.ok) {
                xensBackend = be;
                console.error(`[twoStage] preview: xensemble backend ensured on :${be.port}`);
            } else {
                console.error(`[twoStage] preview: xensemble backend ensure failed (${be.reason}); falling back to verify port`);
            }
        }

        // 实时预览（live 模式）：项目有 dev server（vite/next/nuxt/npm）时，优先起常驻 dev server，
        // 改文件后 iframe 刷新即可见，无需重新 build。起不来回退到下面的静态/反代逻辑。
        if (detected.devKind) {
            // 清理上一轮部署残留的 live 进程（vite/聚合代理），避免端口污染导致 appPort 误判
            await runtime.exec.exec('sh', ['-c', 'pkill -f previewProxyServer 2>/dev/null; pkill -f "vite --host" 2>/dev/null; pkill -f "npx vite" 2>/dev/null; pkill -f "next dev" 2>/dev/null; pkill -f "nuxt dev" 2>/dev/null; sleep 1; true'], {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 15000 }).catch(() => {});
            const live = await startLiveDevServer({
                runtimeRef: ref, workspacePath: wsPath,
                devKind: detected.devKind, devDir: detected.devDir || '.', defaultPort: detected.defaultPort,
                base: `/preview/${deploymentId}/`,
                onLog: previewLog,
            });
            if (live.ok) {
                const aggPort = (await getGuestFreePort(ref)) || 0;
                // /api 反代目标：优先用系统侧拉起的真实后端端口（xensBackend），
                // 否则用 verify.appPort（可能是静态 serve 误报，但不阻塞 live 前端展示）。
                const backendForApi = xensBackend?.port || verify?.appPort || 0;
                const aggOk = aggPort ? await startViteAggregateProxy({
                    runtimeRef: ref, workspacePath: wsPath,
                    devPort: live.port, backendPort: backendForApi, listenPort: aggPort,
                    base: `/preview/${deploymentId}/`,
                    onLog: previewLog,
                }) : false;
                if (aggOk) {
                    port = aggPort;
                    mode = 'live';
                    console.error(`[twoStage] preview: LIVE dev server on :${live.port} -> aggregate :${aggPort} (mode=live, backend=:${backendForApi || 'none'})`);
                } else {
                    console.error(`[twoStage] preview: LIVE aggregate proxy failed, falling back to static`);
                }
            }
        }

        // 非 live 模式：
        // 1) xensemble 且 live 失败 → 直接用系统侧拉起的真实后端端口（单端口全栈，serve web/dist + /api）
        // 2) verify 有 appPort → 套"改写反代"保留完整应用（verify serve 的就是完整应用）
        // 3) 其余（纯静态）→ 聚合 serve dist 兜底
        // 非 live 模式的静态/上游代理都注入 /preview/<id>/ base（HTML <base> 标签），
        // 让前端相对 URL 自动带前缀，避免资源路径脱离 preview 子路径。
        const staticBase = `/preview/${deploymentId}/`;
        if (mode !== 'live' && xensBackend) {
            // xensemble 静态回退：后端单端口全栈（serve web/dist + /api）。dist 是 verify 阶段
            // 构建的，其 VITE_API_BASE 常被烘焙为沙箱内地址（如 http://127.0.0.1:3888）——
            // 浏览器访问时 127.0.0.1 解析为宿主本机 → 打到宿主后端 401。必须套 rewrite proxy
            // 注入 <base> + 运行时 URL 改写脚本，把这些绝对地址改写成 /preview/<id>/ 相对路径，
            // 否则直接隧道后端端口，嵌套前端所有 API 请求都会 401（新建 session 卡死）。
            const proxyPort = (await getGuestFreePort(ref)) || 0;
            if (proxyPort) {
                const proxyOk = await startRewriteProxy({
                    runtimeRef: ref, workspacePath: wsPath,
                    upstreamPort: xensBackend.port, listenPort: proxyPort,
                    base: staticBase,
                    onLog: (m) => console.error(`[twoStage] ${m}`),
                });
                if (proxyOk) {
                    port = proxyPort;
                    console.error(`[twoStage] preview: xensemble rewrite proxy :${proxyPort} -> backend :${xensBackend.port}`);
                } else {
                    port = xensBackend.port;
                    console.error(`[twoStage] preview: xensemble rewrite proxy failed, tunneling backend :${xensBackend.port} directly`);
                }
            } else {
                port = xensBackend.port;
                console.error(`[twoStage] preview: no free guest port for xensemble rewrite proxy, tunneling backend :${xensBackend.port} directly`);
            }
            served = { ok: true };
        } else if (mode !== 'live' && verify?.appPort) {
            const proxyPort = (await getGuestFreePort(ref)) || 0;
            if (proxyPort) {
                const proxyOk = await startRewriteProxy({
                    runtimeRef: ref, workspacePath: wsPath,
                    upstreamPort: verify.appPort, listenPort: proxyPort,
                    base: staticBase,
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
        } else if (mode !== 'live') {
            served = await ensureFrontendServed({ runtimeRef: ref, workspacePath: wsPath, port, base: staticBase, onLog: (m) => console.error(`[twoStage] ${m}`) });
            if (served.ok) port = served.port;
            console.error(`[twoStage] preview: verify had NO appPort, fell back to aggregate serve port ${port}`);
        }
        const tunnel = await createTunnel({ deploymentId, workspacePath: wsPath, runtimeRef: ref, vmPort: port, projectId: project.id });
        await db.insert(schema.deployments).values({
            id: deploymentId, userId, projectId: project.id, sessionId: sessionId || null, runtimeId,
            kind: 'preview', status: 'running', revision: 'live', mode,
            publicUrl: tunnel.publicUrl, internalRef: tunnel.internalRef,
            expiresAt: now + PREVIEW_TTL_MS, createdAt: now, updatedAt: now, createdBy: userId,
        });
        // 注入 blink 反向代理配置（仅 xensemble 自身部署）：沙箱后端据此经 /preview/<id>/__blink
        // 访问宿主 blink-server，在预览里创建 boxlite 隔离的 agent session。
        // 同时起本地转发器（监听 8787），兼容旧版被部署代码（无 token 头/.blink.env 支持）。
        if (isXensemble) {
            const blinkApiUrl = `${tunnel.publicUrl.replace(/\/+$/, '')}/__blink`;
            const blinkToken = signBlinkToken(deploymentId, now + PREVIEW_TTL_MS);
            await injectBlinkEnv(ref, wsPath, deploymentId, blinkApiUrl, blinkToken, (m) => console.error(`[twoStage] ${m}`));
            await startBlinkForwarder(ref, wsPath, blinkApiUrl, blinkToken, (m) => console.error(`[twoStage] ${m}`));
        }
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
