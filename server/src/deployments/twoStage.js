// Two-stage auto-deploy orchestrator.
//   Stage 1: reuses analyzeProjectDeploy (opencode agent + LLM 1 = LLM_ANALYZE_MODEL).
//   Stage 2: analyzeProjectVerify (opencode agent + LLM 2 = LLM_VERIFY_MODEL). The agent runs
//            install + build in the sandbox and self-heals via edit_file + run_shell until both pass.
//   On success: reuses the existing tunnel-preview path inline (createTunnel + db.deployments +
//               issuePreviewToken + start serve in box) and returns the public URL.
//   On failure: returns the stage 2 finalStderr + plan for the front-end to show.

const crypto = require('crypto');
const { eq } = require('drizzle-orm');
const { getRuntime } = require('../runtime/registry');
const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const { analyzeProjectDeploy } = require('./analyzeDeploy');
const { analyzeProjectVerify } = require('./analyzeVerify');
const { createTunnel, stopByProjectId } = require('../preview/tunnelServer');
const deploymentService = require('./DeploymentService');
const { db } = require('../db');
const schema = require('../db/schema');

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const VERIFY_STATE_TTL_MS = 30 * 60 * 1000;

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

async function runAutoTwoStageDeploy({ projectId, userId, getProjectForUser, onProgress, resume }) {
    const project = await getProjectForUser(userId, projectId);
    if (!project) return { ok: false, error: 'Project not found' };
    if (!process.env.LLM_ANALYZE_API_KEY && !process.env.LLM_ANALYZE_API_URL) {
        return { ok: false, error: 'LLM_ANALYZE_* env not configured.' };
    }
    const startedAt = Date.now();
    const ready = await ensureProjectRuntime(project);
    const runtime = getRuntime();
    const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
    const runtimeId = ready.runtime ? ready.runtime.id : undefined;
    const hostWs = ready.hostWorkspacePath;
    const wsPath = ready.workspacePath;

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
        const port = detected.defaultPort || 3000;
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
            });
            return reply.send(result);
        } catch (err) {
            request.log.error(err);
            return reply.code(err.statusCode || 500).send({ ok: false, error: err.message });
        }
    });
}

module.exports = { registerAutoDeployRoutes, runAutoTwoStageDeploy, detectProjectType };
