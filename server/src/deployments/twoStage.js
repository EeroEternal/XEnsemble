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
const { eq, and } = require('drizzle-orm');
const { getRuntime } = require('../runtime/registry');
const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const { analyzeProjectDeploy } = require('./analyzeDeploy');
const { analyzeProjectVerify } = require('./analyzeVerify');
const { createTunnel, stopByProjectId } = require('../preview/tunnelServer');
const deploymentService = require('./DeploymentService');
const workspace = require('../workspace');
const { db } = require('../db');
const schema = require('../db/schema');

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const VERIFY_STATE_TTL_MS = 30 * 60 * 1000;

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
        if (!wrongDeep) return;
        console.error(`[twoStage] fixing workspace ownership: ${hostPath} -> ${uid}:${gid}`);
        execSync(`chown -R ${uid}:${gid} ${JSON.stringify(hostPath)}`, { stdio: 'ignore', timeout: 180000 });
    } catch (e) {
        console.error(`[twoStage] repairHostWorkspaceOwnership: ${e.message}`);
    }
}

// —— 断点续修：verify 超轮数失败后把对话历史存库，resume 时接回继续修 ——
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

// 部署通过后，系统侧在沙箱内保持前后端服务，并起一个"单端口聚合服务器"
// （静态 serve 前端 dist + 反代 /api 到后端），保证 preview 稳定可连且前后端都可用，
// 不依赖 verify 期间 agent 起的短命进程。返回实际生效的端口（tunnel 连它）。
// 用空闲端口 + spawn 后主动验证，避免残留进程占端口导致聚合没起来却被误判成功。
async function ensureFrontendServed({ runtimeRef, workspacePath, port, onLog }) {
    const runtime = getRuntime();
    let dist = null;
    try {
        const probe = await runtime.exec.exec(
            'sh',
            ['-c', 'ls -d client/dist web/dist frontend/dist dist 2>/dev/null | head -1'],
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
    const backendPort = (await getGuestFreePort(runtimeRef)) || 9000;
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
    }

    // 2) 把聚合服务器脚本写入沙箱。
    let proxyPath = null;
    try {
        const script = require('fs').readFileSync(path.join(__dirname, '../preview/previewProxyServer.js'), 'utf8');
        await runtime.fs.fsWrite(workspacePath, '.agents/previewProxyServer.js', script, { runtimeRef });
        proxyPath = '.agents/previewProxyServer.js';
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

async function runAutoTwoStageDeploy({ projectId, userId, getProjectForUser, onProgress, resume, sessionId }) {
    const project = await getProjectForUser(userId, projectId);
    if (!project) return { ok: false, error: 'Project not found' };
    if (!process.env.LLM_ANALYZE_API_KEY && !process.env.LLM_ANALYZE_API_URL) {
        return { ok: false, error: 'LLM_ANALYZE_* env not configured.' };
    }
    const startedAt = Date.now();

    // A new deploy attempt supersedes any existing 'running' deployment for
    // this project. Mark them 'stopped' so a failed retry doesn't leave a
    // stale 'running' record that misleads the UI into showing RUNNING.
    // The old tunnel process is left alone: it will be stopped on verify
    // success (stopByProjectId below) or expire by TTL; only the DB status
    // is corrected here so the preview badge reflects the latest attempt.
    try {
        await db.update(schema.deployments)
            .set({ status: 'stopped', updatedAt: Date.now() })
            .where(and(eq(schema.deployments.projectId, projectId), eq(schema.deployments.status, 'running')));
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

    // 部署前置：确保 host workspace 对 guest 可写（修复 root 属主导致的 write failed）。
    // 注意：boxlite 下 ensureProjectRuntime 返回的 hostWorkspacePath 可能是 undefined，
    // 必须用 workspace.projectDir(userId, projectId) 计算真实的 host 路径。
    const hostPath = (hostWs && fs.existsSync(hostWs)) ? hostWs : workspace.projectDir(project.userId, project.id);
    repairHostWorkspaceOwnership(hostPath);

    // 断点续修：resume=true 时优先复用上次保存的 plan + 对话，跳过阶段 1 重新分析。
    let plan = null;
    let resumeState = null;
    if (resume) {
        resumeState = await loadVerifyState(project.id);
        if (resumeState && Array.isArray(resumeState.plan?.steps) && resumeState.plan.steps.length) {
            plan = {
                steps: resumeState.plan.steps,
                configFiles: resumeState.plan.configFiles || [],
                source: resumeState.plan.source || 'resume',
                warning: resumeState.plan.warning,
            };
            if (onProgress) onProgress({ stage: 'A', message: `断点续修：复用上次分析计划（${plan.steps.length} 步）` });
        } else {
            resumeState = null;
        }
    }

    if (!plan) {
        if (onProgress) onProgress({ stage: 'A', message: '阶段 1：调用 LLM 1 出部署计划' });
        const planResult = await analyzeProjectDeploy({ workspacePath: wsPath, hostWorkspacePath: hostWs, runtimeRef: ref });
        if (!planResult || !planResult.steps?.length) {
            return { ok: false, error: '阶段 1 失败：未生成计划', planResult };
        }
        plan = { steps: planResult.steps, configFiles: planResult.configFiles || [], source: planResult.source, warning: planResult.warning };
        if (onProgress) onProgress({ stage: 'A', message: `阶段 1 完成: ${plan.steps.length} 步, ${plan.configFiles.length} configs (${planResult.source || 'fallback'})` });
    }

    if (onProgress) onProgress({ stage: 'B', message: resumeState ? '阶段 2：续修（接回上次对话继续修复）' : '阶段 2：调用 LLM 2（agent）准备环境 + 测试 + 自动修复' });
    const detected = hostWs ? detectProjectType(hostWs) : { type: 'unknown', defaultPort: 3000 };
    const verify = await analyzeProjectVerify({
        workspacePath: wsPath,
        hostWorkspacePath: hostWs,
        runtimeRef: ref,
        plan,
        projectType: detected,
        resume: resumeState ? { messages: resumeState.messages, trail: resumeState.trail, roundsUsed: resumeState.roundsUsed } : undefined,
    });
    if (onProgress) onProgress({
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

    if (onProgress) onProgress({ stage: 'preview', message: '阶段 2 通过，创建预览隧道' });
    let preview = null;
    try {
        try { stopByProjectId(project.id); } catch { /* ignore */ }
        const now = Date.now();
        const deploymentId = `dep_${crypto.randomBytes(8).toString('hex')}`;
        // 用 verify 探测到的真实应用端口（agent 可能在非默认端口上 serve），兜底回退 defaultPort。
        let port = verify?.appPort || detected.defaultPort || 3000;
        // 系统侧在前端产物上起一个持久静态服务，确保 preview 稳定可连（不依赖 verify 的短命进程）。
        const served = await ensureFrontendServed({ runtimeRef: ref, workspacePath: wsPath, port, onLog: (m) => console.error(`[twoStage] ${m}`) });
        if (served.ok) port = served.port;
        const tunnel = await createTunnel({ deploymentId, workspacePath: wsPath, runtimeRef: ref, vmPort: port, projectId: project.id });
        await db.insert(schema.deployments).values({
            id: deploymentId, userId, projectId: project.id, runtimeId,
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

    if (onProgress) onProgress({ stage: 'done', message: '✓ 两阶段通过，preview ready' });
    return {
        ok: true, plan, verify,
        previewUrl: preview.publicUrl, deploymentId: preview.deploymentId, previewToken: preview.previewToken,
        elapsedMs: Date.now() - startedAt,
    };
}

function registerAutoDeployRoutes(fastify, { getProjectForUser }) {
    fastify.post('/api/v1/projects/:projectId/auto-deploy', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
        try {
            const result = await runAutoTwoStageDeploy({
                projectId: request.params.projectId,
                userId: request.user.id,
                getProjectForUser,
                resume: Boolean(request.body?.resume),
                sessionId: request.query?.session_id || request.body?.session_id,
            });
            return reply.send(result);
        } catch (err) {
            request.log.error(err);
            return reply.code(err.statusCode || 500).send({ ok: false, error: err.message });
        }
    });
}

module.exports = { registerAutoDeployRoutes, runAutoTwoStageDeploy, detectProjectType };
