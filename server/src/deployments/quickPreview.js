// 快速预览（Quick Preview）：与「部署」并列的独立功能。
// 目标：让用户在开发的同时快速看到修改后的效果——dev server + HMR 热更新，
// 不做全量部署（不跑 verify agent 生产化流水线、不做 wheel/DB 重预配）。
//
// 与部署的关系（互斥共享同一沙箱 workspace）：
//   - 部署进行中 → 拒绝预览（deployments.kind='dev' 记录不与 deploy 抢 workspace）
//   - 快速预览进行中 → 拒绝部署（同一互斥键空间，occupants 里 kind='dev' 展示"预览中"）
//
// 两阶段（标准/非标项目一视同仁，AI 用现成 LLM 配置）：
//   阶段 A（理解）：跑现有 analyzeProject（阶段 A 同款单次 LLM 分析）——产出
//     dev 启动命令/env 模板/依赖安装命令。plan 缓存复用部署的缓存（部署过的
//     项目不再调 LLM）。
//   阶段 B（执行）：确定性代码，无 agent 循环：
//     deps 检测（lock hash 缓存）→ platform install（仅 stale 时）
//     → spawn mock server → startLiveDevServer（HMR）→ startViteAggregateProxy
//       （/api/* 恒打 mock，其余透传 dev server）→ createTunnel → 出 URL。
//
// 交互式补全（env 填写）沿用部署的 configFiles 机制：阶段 A 发现缺 .env 时
// 返回 needsConfig=true + configFiles，前端展示表单；用户填完携带 configValues
// 重发请求。已填过的值存 plan 缓存，下次直接用。

const crypto = require('crypto');
const { db } = require('../db/index');
const schema = require('../db/schema');
const path = require('path');
const fs = require('fs');
const { eq, and, inArray } = require('drizzle-orm');
const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const { getRuntime } = require('../runtime/registry');
const { createTunnel, stopByProjectId } = require('../preview/tunnelServer');
const { resolveControlPlanePublicUrlSync } = require('../llm/publicUrl');
const { analyzeProjectDeploy: analyzeProject } = require('./analyzeDeploy');
const { loadVerifyState, saveVerifyState, issuePreviewToken: _ipt } = require('./twoStage');
const deploymentService = require('./DeploymentService');
const { registerDeploy, peekDeploy, unregisterDeploy, deployKey } = require('./activeDeploys');

const issuePreviewToken = (id) => deploymentService.issuePreviewToken(id);

const PREVIEW_TTL_MS = Number(process.env.QUICK_PREVIEW_TTL_MS) || 2 * 60 * 60 * 1000; // 2h

function quickLog(m) { console.error(`[quickPreview] ${m}`); }

// workspace 宿主绝对路径（detectProjectType 需要宿主侧文件系统读 package.json）
function resolveHostWorkspace(hostWorkspacePath) {
    return hostWorkspacePath;
}

// 从部署/预览记录读占用，构造 occupants 数组（与 deploy_in_progress 的展示同构）
async function buildOccupants(projectId, userId) {
    try {
        // 联表补 projectName/sessionName：前端占用列表显示「工作区「空」- 会话「未命名会话」」
        // 是因为只有 id 没有名称（实测反馈）。sessions 表拿会话名，projects 表拿项目名。
        const rows = await db.select({
            id: schema.deployments.id,
            kind: schema.deployments.kind,
            status: schema.deployments.status,
            sessionId: schema.deployments.sessionId,
            projectName: schema.projects.name,
            sessionName: schema.sessions.title,
        }).from(schema.deployments)
            .leftJoin(schema.projects, eq(schema.projects.id, schema.deployments.projectId))
            .leftJoin(schema.sessions, eq(schema.sessions.id, schema.deployments.sessionId))
            .where(and(
                eq(schema.deployments.projectId, projectId),
                eq(schema.deployments.userId, userId),
                inArray(schema.deployments.status, ['running', 'building', 'pending']),
            ));
        return rows.map((r) => ({ kind: r.kind, status: r.status, sessionId: r.sessionId, deploymentId: r.id, projectName: r.projectName || null, sessionName: r.sessionName || null }));
    } catch (e) {
        quickLog(`buildOccupants error: ${e.message}`);
        return [];
    }
}

// LLM 端点归一化：env 可能给 base URL（…/api/v1）或完整 chat/completions URL，
// 直接拼接会产生 …/chat/completions/chat/completions → 405 Method Not Allowed
// （analyzeDeploy.chatCompletionsUrl 同款逻辑，此处独立复制避免引依赖环）。
function chatCompletionsUrl(url) {
    const u = String(url || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions\/?$/i.test(u)) return u;
    return `${u}/chat/completions`;
}

// 不支持 thinking 字段的模型（与 analyzeDeploy/analyzeVerify 同一份名单）。
const NO_THINKING_MODELS = new Set([
    'deepseek-chat', 'deepseek-reasoner',
    ...(String(process.env.LLM_NO_THINKING_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean)),
]);

// dev 目标选择：根 dev script 是 concurrently 聚合（web+server+desktop）时，electron
// 桌面包在无 GUI 沙箱必崩（libglib 等共享库缺失 → exit 127）， concurrently 全队退出
// 连带 vite 陪葬 → 探测 http 000。与部署链路排除 desktop 的逻辑对齐：检测到 electron
// 时改用浏览器可跑的子目录 dev server（web/frontend/client/app，vite/next/nuxt 优先）。
// electron 信号：deps.electron / electron-vite / electron-builder（xensemble 实测
// electron 二进制经 electron-vite 引入，desktop/package.json 无裸 electron 依赖——
// 只查 electron 会漏检）。
function pickBrowserDevTarget(detected, hostPath) {
    const fs = require('fs');
    const path = require('path');
    const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
    const isElectronish = (pkg) => {
        if (!pkg) return false;
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
        return !!(deps.electron || deps['electron-vite'] || deps['electron-builder']);
    };
    const rootPkg = readJson(path.join(hostPath, 'package.json')) || {};
    const desktopPkg = readJson(path.join(hostPath, 'desktop', 'package.json')) || readJson(path.join(hostPath, 'app', 'package.json')) || {};
    const hasElectron = isElectronish(rootPkg) || isElectronish(desktopPkg)
        || ['desktop', 'app', 'apps/desktop', 'packages/desktop'].some((d) => {
            const p = readJson(path.join(hostPath, d, 'package.json'));
            return !!p && /electron/.test(JSON.stringify(p.scripts || {}));
        });
    if (!hasElectron) return detected; // 根 dev 不含 electron，维持原判
    for (const d of ['web', 'frontend', 'client', 'app', 'renderer', 'apps/web', 'apps/frontend', 'apps/client', 'apps/app', 'packages/web', 'packages/frontend', 'packages/client', 'packages/app']) {
        const pkg = readJson(path.join(hostPath, d, 'package.json'));
        if (!pkg) continue;
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        if (deps['@umijs/max'] || deps.umi) continue; // umi 子路径代理白屏，同 twoStage 规则
        if (deps.vite) return { ...detected, devKind: 'vite', devDir: d };
        if (deps.next) return { ...detected, devKind: 'next', devDir: d };
        if (deps.nuxt) return { ...detected, devKind: 'nuxt', devDir: d };
        if (pkg.scripts && pkg.scripts.dev) return { ...detected, devKind: 'npm', devDir: d };
    }
    return detected; // 找不到浏览器可跑的子前端 → 维持原判（失败信息会如实上报）
}

// ── 阶段 B：确定性执行 ─────────────────────────────────────────────
async function runQuickPreviewInner({ project, userId, projectId, sessionId, report, startedAt, deployRef, deployState }) {
    const runtime = getRuntime();
    const ready = await ensureProjectRuntime(project, {});
    const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
    const wsPath = ready.workspacePath;
    const hostPath = ready.hostWorkspacePath || wsPath;

    // 阶段 A：理解项目（LLM 单次分析；部署过的项目直接命中 plan 缓存零 LLM）
    report({ stage: 'A', message: '分析项目结构（快速）' });
    const { detectProjectType } = require('./twoStage');
    const detectedRaw = detectProjectType(hostPath);
    if (!detectedRaw || detectedRaw.type === 'unknown') {
        return { ok: false, code: 'unsupported_project', error: '无法识别项目结构（没有 package.json / go.mod / pyproject.toml）' };
    }
    // electron 守卫：根 dev 聚合桌面包时改跑子目录浏览器 dev（详见 pickBrowserDevTarget）
    let detected = pickBrowserDevTarget(detectedRaw, hostPath);
    if (detected.devDir !== detectedRaw.devDir) {
        quickLog(`electron guard: dev target overridden kind=${detectedRaw.devKind}/. -> ${detected.devKind}/${detected.devDir}`);
    }

    // plan 来源优先级：部署的 plan 缓存（loadVerifyState 里的 plan）> 现跑 analyzeProjectDeploy
    // （与部署阶段 A 同款：opencode + ReAct 并行，先完成者交付）。
    let plan = null;
    try {
        const saved = await loadVerifyState(projectId, { forPlanCache: true });
        plan = saved && saved.plan && Array.isArray(saved.plan.steps) && saved.plan.steps.length ? saved.plan : null;
    } catch { /* no cache */ }
    if (!plan) {
        const analyzed = await analyzeProject({ workspacePath: wsPath, hostWorkspacePath: hostPath, runtimeRef: ref, isAborted: () => deployState.cancelled });
        if (!analyzed || analyzed.ok === false || !Array.isArray(analyzed.steps) || !analyzed.steps.length) {
            return { ok: false, code: 'analyze_failed', error: '项目分析失败，无法确定启动方式。建议先执行完整部署。' };
        }
        plan = analyzed;
        try { await saveVerifyState(projectId, { plan, messages: [], trail: [], roundsUsed: 0, runtimeRef: ref, workspacePath: wsPath }); } catch { /* cache best-effort */ }
    }

    // env 缺口：plan.configFiles 有模板但 workspace 没有 .env → 请求用户填一次
    const missingEnv = (plan.configFiles || []).filter((c) => c && c.template);
    // 把 plan 交给阶段 B（env/依赖安装命令都在里面）。missingEnv 非空时仍继续——
    // dev server 大多能在缺 env 下启动，mock 模式不依赖真实后端；真跑不起来时阶段 B 报错。
    if (missingEnv.length) {
        quickLog(`plan has ${missingEnv.length} configFiles with templates (env may be missing; dev preview tolerates it)`);
    }

    // 依赖：lock hash 缓存判定，stale 才装
    report({ stage: 'B', substage: 'prepare', message: '检查依赖' });
    const { buildDetectScript, parseDepsStatus, STACK_DEPS_RULES } = require('./detectStack');
    let depsStatus = null;
    try {
        const script = buildDetectScript(detected.stack || detected);
        const r = await runtime.exec.exec('sh', ['-c', script], {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 60000 });
        depsStatus = parseDepsStatus(String(r.stdout || ''));
    } catch (e) {
        quickLog(`deps detect failed (non-fatal, skip install): ${e.message}`);
    }
    if (depsStatus && depsStatus.overallCached === false) {
        // 注意形状：parseDepsStatus 返回 { overallCached, perPackage }——此前用
        // Object.values(depsStatus) 判断，overallCached(bool)/perPackage(obj) 永远
        // !== 'CACHED' → 缓存全命中也强制 install（每次预览白跑 13-90s）。
        const { runPlatformInstall } = require('./twoStage');
        report({ stage: 'B', substage: 'install', message: '安装依赖（有变更）' });
        try {
            await runPlatformInstall({ runtimeRef: ref, workspacePath: wsPath, hostWorkspacePath: hostPath, stack: detected, depsStatus, onLog: quickLog });
        } catch (e) {
            quickLog(`platform install failed (non-fatal): ${e.message}`);
        }
    }

    // mock server（P2）：/api/* 恒打 mock。数据三级来源：
    //   1. .xensemble/mocks/<METHOD>__<path>.json（用户手写，完全覆盖）
    //   2. .xensemble/mocks/_generated.cjs（LLM 按真实路由结构生成的拟真工厂，见下）
    //   3. 通用兜底（保活不报错）
    // _generated.cjs 来源：阶段 A 理解项目时 LLM 已读过路由/数据模型——若 plan 缓存
    // 没有 mock 工厂（首次），追加一次 LLM 调用产出拟真数据工厂（含真实响应包络 +
    // 合理字段值 + POST/PUT 回显），存沙箱后所有预览复用，接口结构未变则不重生成。
    report({ stage: 'B', substage: 'mock', message: '启动 Mock API' });
    const mockPort = (await getGuestFreePortCompat(ref)) || 9701;
    // 重生成流程：先备份旧工厂，生成成功才替换——绝不 rm 后失败留空（实测 20:04：
    // 开关还挂在 systemd 环境里 → 强刷遇 route-grep 偶发空 → fallback 垃圾 → rm 掉
    // 好工厂后生成失败 → 登录回归）。备份在沙箱 /tmp，失败后自动回滚。
    // 强制重生成的唯一入口是手动删除沙箱内 .xensemble/mocks/_generated.cjs +
    // plan 缓存的 mockDataFactory 标志——环境变量开关已废除（systemctl
    // set-environment 设了忘 unset 会永久残留，20:04 事故根因）。
    const forceRegen = false;
    if (!plan.mockDataFactory || forceRegen) {
        if (forceRegen) quickLog('mock factory regenerate forced (MOCK_FACTORY_REGENERATE=1)');
        const GEN = '.xensemble/mocks/_generated.cjs';
        const BAK = '/tmp/_generated.cjs.bak';
        try {
            await runtime.exec.exec('sh', ['-c', `cp ${GEN} ${BAK} 2>/dev/null; rm -f ${GEN}`], {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 5000 }).catch(() => null);
            const generated = await generateMockFactory({ workspacePath: wsPath, hostWorkspacePath: hostPath, runtimeRef: ref });
            if (generated) {
                plan.mockDataFactory = true;
                if (forceRegen) {
                    // 一次性开关：清本进程 + 提示用户清 systemd 环境（delete 只影响当前进程，
                    // systemd 重启会重新注入——20:04 事故根因）。用 DEPLOY_MOCK_NO_REGEN 永久关闸。
                    delete process.env.MOCK_FACTORY_REGENERATE;
                    quickLog('mock factory regenerated OK; unset MOCK_FACTORY_REGENERATE in-process (systemd env must be removed too: sudo systemctl unset-environment MOCK_FACTORY_REGENERATE)');
                }
                try { await saveVerifyState(projectId, { plan, messages: [], trail: [], roundsUsed: 0, runtimeRef: ref, workspacePath: wsPath }); } catch { /* cache best-effort */ }
            } else {
                // 生成失败 → 回滚旧工厂（有的话）
                await runtime.exec.exec('sh', ['-c', `[ -f ${BAK} ] && mv ${BAK} ${GEN} || true`], {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 5000 }).catch(() => null);
                quickLog('mock factory generation failed; previous factory restored (if any)');
            }
        } catch (e) {
            quickLog(`mock factory generation failed (non-fatal): ${e.message}`);
            await runtime.exec.exec('sh', ['-c', `[ -f ${BAK} ] && mv ${BAK} ${GEN} || true`], {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 5000 }).catch(() => null);
        }
    } else {
        quickLog('mock factory cached (plan.mockDataFactory), skipping generation');
    }
    const mockEndpoints = await collectMockEndpoints(projectId);
    const mockOk = await startMockServer({ runtimeRef: ref, workspacePath: wsPath, port: mockPort, endpoints: mockEndpoints });
    if (mockOk) quickLog(`mock server ready on :${mockPort} (factory=${!!plan.mockDataFactory})`);
    else quickLog('mock server failed (non-fatal): /api 将透传 dev server 自己的 /api（若有）');

    const previewBase = `${((process.env.PREVIEW_PUBLIC_URL || '').trim() || resolveControlPlanePublicUrlSync()).replace(/\/+$/, '')}/preview/${deployRef.id}/`;
    const basePath = previewBase.replace(/^https?:\/\/[^/]+/, '');

    // ── 混合方案：AI 出「配方」，平台出「工艺」──
    // 1) 配方来源优先级：plan 缓存 devRecipe（上次成功配方，零 LLM）> 平台确定性规则
    //    （startLiveDevServer 内置模板 + electron 守卫）> LLM 兜底（非标项目）
    // 2) spawn 工艺平台化：PORT/--base/setsid/长命通道由平台注入，LLM 配方只决定
    //    「cd 哪个目录跑什么命令」（防止它不知道 idmapped 挂载权限/exec 收割这些平台坑）
    // 3) 失败自愈：探测失败把 live-dev.log 喂回 LLM 修配方，上限 2 轮（已知坑规则化
    //    零成本直达，未知坑烧 1-2 轮 LLM 收敛——electron 事故后 vite 陪葬即此类）
    const previewDirAbs = hostPath + '/' + (detected.devDir || '.');
    let recipe = null;
    if (plan.devRecipe && plan.devRecipe.cmd && plan.devRecipe.dir !== undefined) {
        recipe = { ...plan.devRecipe, source: 'cache' };
        quickLog(`dev recipe from cache: ${recipe.cmd.slice(0, 120)}`);
    }

    report({ stage: 'B', substage: 'serve', message: '启动开发服务器' });
    // devDir 依赖预检：platform install 的逐子包补装对子包不可靠（实测 PARTIALLY
    // FAILED 后 web 残留 stale → npx vite 现场下载/秒退 → 40s 探测全败）。dev server
    // 是快速预览唯一硬依赖，这里确定性兜底一次：devDir 的 node_modules 缺失/缺 bin
    // 时直接在 devDir 装依赖（CI=true + /usr/local/bin PATH，与 platform install 同 env）。
    if (detected.devKind && detected.devDir && detected.devDir !== '.') {
        try {
            const hasBins = require('fs').existsSync(previewDirAbs + '/node_modules')
                && (detected.devKind !== 'vite' || require('fs').existsSync(previewDirAbs + '/node_modules/.bin/vite'));
            if (!hasBins) {
                quickLog(`devDir ${detected.devDir} node_modules/vite bin missing; installing directly`);
                const PRE = 'export PATH="/usr/local/bin:$PATH"; export CI=true; export NODE_OPTIONS="--max-old-space-size=3072"; ';
                await runtime.exec.exec('sh', ['-c', `cd ${detected.devDir} && ${PRE}npm install --no-audit --no-fund`], {},
                    { runtimeRef: ref, cwd: wsPath, timeoutMs: 600000 });
                quickLog('devDir install done');
            }
        } catch (e) {
            quickLog(`devDir pre-install failed (non-fatal, dev server may fail): ${e.message?.slice(0, 160)}`);
        }
    }

    // 启动 → 失败自愈循环（≤2 轮 LLM 修复）
    let live = await startLiveDevServerCompat({ runtimeRef: ref, workspacePath: wsPath, detected, base: basePath, recipe });
    for (let healRound = 0; !live.ok && healRound < 2; healRound++) {
        const logTail = live.logTail || '';
        if (!logTail) break; // 无日志可喂（如 exec 层挂了）→ 自愈无从谈起
        // 确定性救场（零 LLM）：日志暴露 electron 陷阱（libglib/libnss3/electron 崩溃）
        // 且存在浏览器可跑子前端 → 直接换子目录 vite 重试。已知坑规则化，不烧 LLM。
        const electronCrash = /electron|libglib|libnss3|libgtk/i.test(logTail);
        const overridden = electronCrash && detected.devDir === '.'
            ? pickBrowserDevTarget({ ...detected, devKind: null, devDir: '.' }, hostPath)
            : null;
        if (overridden && overridden.devDir && overridden.devDir !== '.') {
            quickLog(`heal round ${healRound + 1}: deterministic electron rescue -> ${overridden.devKind}/${overridden.devDir}`);
            detected = overridden;
            recipe = null; // 回到平台模板（子目录 vite 标准件）
            live = await startLiveDevServerCompat({ runtimeRef: ref, workspacePath: wsPath, detected, base: basePath, recipe });
            continue;
        }
        report({ stage: 'B', substage: 'serve', message: `启动失败，AI 修复中（第 ${healRound + 1} 轮）` });
        quickLog(`heal round ${healRound + 1}: feeding live-dev.log to LLM`);
        const healed = await healDevRecipe({ ref, hostPath, detected, logTail, previousRecipe: recipe });
        if (!healed) { quickLog('heal: LLM unavailable or no better recipe'); break; }
        recipe = { ...healed, source: `heal-${healRound + 1}` };
        quickLog(`heal round ${healRound + 1} recipe: ${recipe.cmd.slice(0, 120)}`);
        // 先杀上一轮残留进程再重试（换配方/换端口防串台）
        try {
            await runtime.exec.exec('sh', ['-c', 'pkill -f "vite --host" 2>/dev/null; pkill -f "next dev" 2>/dev/null; pkill -f "nuxt dev" 2>/dev/null; true'],
                {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 10000 });
        } catch { /* ignore */ }
        live = await startLiveDevServerCompat({ runtimeRef: ref, workspacePath: wsPath, detected, base: basePath, recipe });
    }
    if (live.ok && recipe && recipe.source !== 'cache') {
        // 成功配方回写 plan 缓存——下次预览零 LLM 直达
        plan.devRecipe = { cmd: recipe.cmd, dir: recipe.dir, port: recipe.port || null };
        try { await saveVerifyState(projectId, { plan, messages: [], trail: [], roundsUsed: 0, runtimeRef: ref, workspacePath: wsPath }); } catch { /* best-effort */ }
    }
    if (!live.ok) {
        // logTail 直接拼进错误：用户在面板里看到 vite/next 崩溃的第一现场，
        // 而不是只有一句 not ready + 一个未必方便看的沙箱日志路径。
        return { ok: false, code: 'dev_server_failed', error: `开发服务器启动失败：${live.reason || '未知原因'}${live.logTail ? '\n' + live.logTail : ''}` };
    }

    // 聚合代理：前端 → dev server；/api/* → mock server（Mock 恒开，Live 已隐藏）
    report({ stage: 'B', substage: 'proxy', message: '配置代理' });
    const aggPort = (await getGuestFreePortCompat(ref)) || 0;
    const proxyOk = aggPort ? await startAggregateProxyCompat({ runtimeRef: ref, workspacePath: wsPath, devPort: live.port, mockPort: mockOk ? mockPort : 0, listenPort: aggPort, base: previewBase.replace(/^https?:\/\/[^/]+/, ''), devKind: detected.devKind }) : false;
    if (!proxyOk) {
        return { ok: false, code: 'proxy_failed', error: '预览代理启动失败（聚合代理 10s 未就绪）' };
    }

    // 隧道 + 预览记录
    report({ stage: 'B', substage: 'preview', message: '开启预览' });
    const tunnel = await createTunnel({ deploymentId: deployRef.id, workspacePath: wsPath, runtimeRef: ref, vmPort: aggPort, projectId: project.id });
    const now = Date.now();
    // 记录已在 runQuickPreview 入口创建（id 相同、status='building'）——此处必须
    // UPDATE 回填隧道/终态。twoStage 是 deploy+preview 两条不同 id 记录所以能
    // INSERT 两条；快速预览共用一条 id，再 INSERT 就是主键冲突（实测 Failed query）。
    await db.update(schema.deployments).set({
        runtimeId: ready.runtime?.id || null,
        status: 'running', revision: 'quick', mode: 'live',
        publicUrl: tunnel.publicUrl, internalRef: tunnel.internalRef,
        expiresAt: now + PREVIEW_TTL_MS, updatedAt: now,
    }).where(eq(schema.deployments.id, deployRef.id));
    const previewToken = await issuePreviewToken(deployRef.id);
    return { ok: true, previewUrl: tunnel.publicUrl, deploymentId: deployRef.id, previewToken, elapsedMs: Date.now() - startedAt };
}

async function getGuestFreePortCompat(ref) {
    try {
        const { getGuestFreePort } = require('./twoStage');
        return await getGuestFreePort(ref);
    } catch {
        const runtime = getRuntime();
        const r = await runtime.exec.exec('sh', ['-c', 'python3 -c "import socket;s=socket.socket();s.bind((\'0.0.0.0\',0));print(s.getsockname()[1]);s.close()"'], {}, { runtimeRef: ref, timeoutMs: 10000 }).catch(() => null);
        return r ? Number(String(r.stdout || '').trim()) || 0 : 0;
    }
}

// startLiveDevServer / startViteAggregateProxy 从 twoStage.js 导出后直接用；
// 导出未就绪时给出最小 fallback（npm dev + 透传代理），保证编排器不空转。
// dev server 启动（配方驱动）：
//   recipe=null  → 平台内置模板（vite/next/nuxt/npm 标准件，零 LLM）
//   recipe={cmd,dir} → LLM 配方：只决定 cd 哪个目录跑什么命令；工艺仍平台化
//     （PORT 注入替代配方里的 $PORT/--port 数字、setsid 长命通道、/usr/local/bin PATH、
//      CI=true、HOME=/tmp——这些平台坑 LLM 不知道也不该管）。配方命令里的 --port 数字
//      被平台改写为实际分配端口（sed 替换端口号），--base 由平台统一追加（子路径代理）。
async function startLiveDevServerCompat({ runtimeRef, workspacePath, detected, base, recipe }) {
    const two = require('./twoStage');
    if (!recipe && typeof two.startLiveDevServer === 'function') {
        // 平台路径：内置模板 + electron 守卫结论（detected.devKind/devDir）
        const live = await two.startLiveDevServer({ runtimeRef, workspacePath, devKind: detected.devKind, devDir: detected.devDir, defaultPort: detected.defaultPort, base, onLog: quickLog });
        if (live?.ok) {
            quickLog(`dev server ready on :${live.port} (kind=${detected.devKind}, dir=${detected.devDir}, platform recipe)`);
            return live;
        }
        // 失败：把 live-dev.log 尾部直接读出来，供自愈循环/错误信息使用——000 意味着
        // 进程没监听起来（依赖缺失/启动即崩/端口被占），根因只在这个日志里。
        const logTail = await readLiveDevLogTail(runtimeRef, workspacePath);
        if (logTail) quickLog(`dev server failure log tail:\n${logTail}`);
        return { ok: false, reason: live?.reason || 'live dev server not ready', logTail };
    }
    if (!recipe) return { ok: false, reason: 'no platform template and no recipe' };

    // LLM 配方路径：平台改写工艺，保留配方语义
    const runtime = getRuntime();
    const port = (await getGuestFreePortCompat(runtimeRef)) || 5173;
    let cmd = String(recipe.cmd || '').trim();
    // 工艺注入 1：PORT 环境变量恒定平台分配值（配方内 $PORT 会被 shell 展开）
    // 工艺注入 2：把配方里写死的常见端口号替换为分配端口（vite --port 5173 等）
    cmd = cmd.replace(/--port\s+\d+/g, `--port ${port}`).replace(/(-p|--port)\s+\$\{?PORT\}?/g, `$1 ${port}`);
    // 工艺注入 3：--base 子路径前缀（vite 专属语义；其他框架由 PORT+相对路径自然适配）
    if (detected.devKind === 'vite' || /\bvite\b/.test(cmd)) {
        if (base && !cmd.includes('--base')) cmd += ` --base ${base}`;
        if (!cmd.includes('--host')) cmd += ' --host 0.0.0.0 --strictPort';
    }
    const PRE = 'export PATH="/usr/local/bin:$PATH"; export CI=true; export HOME=/tmp; export NODE_OPTIONS="--max-old-space-size=3072"; ';
    try {
        await runtime.exec.exec('sh', ['-c', `cd ${recipe.dir || '.'} && (setsid nohup sh -c '${PRE}${cmd.replace(/'/g, `'\\''`)}' > /tmp/live-dev.log 2>&1 &) && echo started`],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
    } catch (e) {
        return { ok: false, reason: `recipe spawn failed: ${e.message}`, logTail: '' };
    }
    for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const chk = await runtime.exec.exec('sh', ['-c', `curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 8000 }).catch(() => null);
        const code = String(chk?.stdout || '').trim();
        if (/^[23]\d\d$/.test(code)) {
            quickLog(`dev server ready on :${port} (recipe=${recipe.source || 'llm'})`);
            return { ok: true, port };
        }
    }
    const logTail = await readLiveDevLogTail(runtimeRef, workspacePath);
    return { ok: false, reason: `dev server (recipe) 40s 未就绪`, logTail };
}

async function readLiveDevLogTail(runtimeRef, workspacePath) {
    try {
        const runtime = getRuntime();
        const log = await runtime.exec.exec('sh', ['-c', 'tail -n 15 /tmp/live-dev.log 2>/dev/null | tail -c 1200'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 8000 });
        return String(log.stdout || '').trim();
    } catch { return ''; }
}

// 自愈：dev 起不来 → live-dev.log + 当前配方喂给 LLM → 新配方 {cmd, dir, port}。
// 平台否决：cmd 禁止 apt/pkill/rm/curl|sh 等破坏性模式；dir 必须存在于 workspace。
const HEAL_PROMPT = `A frontend dev server failed to start inside a Linux sandbox (no GUI, no root X11, virtiofs idmapped mount).
You get: the tail of /tmp/live-dev.log, and the previous start command (if any).
Return ONLY a JSON object (no markdown, no explanation):
{"cmd": "<shell command to start the dev server, relative to dir>", "dir": "<subdir under /workspace, '.' allowed>", "port": <port the server will listen on>}
Rules:
- The browser-facing dev server only (vite/next/webpack-dev-server). Do NOT start electron/desktop apps (no GUI in sandbox), do NOT start backend servers.
- Use the package manager consistent with the lockfile in that dir (pnpm-lock.yaml -> pnpm, yarn.lock -> yarn, else npm).
- Do NOT include: apt/pip install, pkill/kill, rm -rf, curl|sh, sudo, cd into absolute paths outside dir, --port/--base flags (platform injects them), backgrounding (&, nohup).
- If the log shows a missing dependency, prefix the command with the minimal install: e.g. "npm install --no-audit --no-fund && npm run dev".
- If the log shows the app needs env vars that are obviously build-time static (e.g. VITE_API_BASE), you may inline them with env VAR=value.

live-dev.log tail:
`;

async function healDevRecipe({ ref, hostPath, detected, logTail, previousRecipe }) {
    const API_KEY = process.env.LLM_ANALYZE_API_KEY;
    const API_URL = process.env.LLM_ANALYZE_API_URL;
    const MODEL = process.env.LLM_ANALYZE_MODEL || 'deepseek-chat';
    if (!API_KEY || !API_URL) return null;
    // 根/子包 scripts 清单注入：防止 LLM 推荐不存在的脚本（multica 实测两轮都给
    // `npm run dev`，而根 scripts 只有 dev:web/dev:desktop/turbo 系列 → 死循环）。
    let scriptsHint = '';
    try {
        const readJson = (p) => { try { return JSON.parse(require('fs').readFileSync(require('path').join(hostPath, p), 'utf8')); } catch { return null; } };
        const parts = [];
        for (const d of ['.', 'apps/web', 'apps/frontend', 'packages/web', 'web', 'frontend', 'client']) {
            const pkg = readJson(require('path').join(d, 'package.json'));
            if (pkg) parts.push(`  ${d}/package.json scripts: ${JSON.stringify(pkg.scripts || {}).slice(0, 300)}`);
        }
        scriptsHint = parts.join('\n');
    } catch { /* hint is best-effort */ }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    let content = '';
    try {
        const resp = await fetch(chatCompletionsUrl(API_URL), {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
            body: JSON.stringify({
                model: MODEL, temperature: 0.1, max_tokens: 1500,
                messages: [
                    { role: 'system', content: 'Output raw JSON only.' },
                    { role: 'user', content: HEAL_PROMPT + logTail.slice(0, 1500) + `\n\nAvailable package.json scripts (ONLY reference these; do NOT invent script names):\n${scriptsHint}\n\nprevious command: ${previousRecipe ? previousRecipe.cmd : '(platform default ' + (detected.devKind || 'npm') + ' dev in ' + (detected.devDir || '.') + ')'}` },
                ],
            }),
        });
        const data = await resp.json();
        content = String(data?.choices?.[0]?.message?.content || '');
    } catch (e) {
        quickLog(`heal LLM call failed: ${e.message?.slice(0, 100)}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
    content = content.replace(/^```[a-z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
    let parsed;
    try { parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1)); } catch { return null; }
    const cmd = String(parsed.cmd || '').trim();
    const dir = String(parsed.dir || '.').trim();
    if (!cmd || cmd.length > 500) return null;
    // 平台否决：破坏性/越权模式一律拒收
    if (/apt-get|apt install|pkill|kill |rm -rf|curl[^|]*\|\s*sh|sudo|chmod 777|mkfs|>\s*\/etc/.test(cmd)) {
        quickLog(`heal recipe rejected (dangerous pattern): ${cmd.slice(0, 120)}`);
        return null;
    }
    // dir 越界否决：必须真实存在于 workspace 内
    const fs = require('fs');
    const dirAbs = path.resolve(hostPath, dir);
    if (!dirAbs.startsWith(path.resolve(hostPath)) || !fs.existsSync(dirAbs)) {
        quickLog(`heal recipe rejected (bad dir): ${dir}`);
        return null;
    }
    return { cmd, dir, port: Number(parsed.port) || null };
}

async function startAggregateProxyCompat({ runtimeRef, workspacePath, devPort, mockPort, listenPort, base, devKind }) {
    const two = require('./twoStage');
    if (typeof two.startViteAggregateProxy === 'function' && mockPort) {
        // 聚合代理 --live <devPort> <backendPort>：backendPort 位给 mock，/api/* 打 mock
        return two.startViteAggregateProxy({ runtimeRef, workspacePath, devPort, backendPort: mockPort, listenPort, base, apiPrefixes: ['api'], baseForward: devKind === 'vite' });
    }
    if (typeof two.startViteAggregateProxy === 'function') {
        return two.startViteAggregateProxy({ runtimeRef, workspacePath, devPort, backendPort: 0, listenPort, base, baseForward: devKind === 'vite' });
    }
    // fallback：dev server 直连（无代理，无 mock）
    return devPort > 0;
}

// LLM 生成拟真 mock 数据工厂（.xensemble/mocks/_generated.cjs）。
// 输入：沙箱内路由文件摘要（让 LLM 看到真实接口结构）——路由注册行 grep + 数据模型
// 字段（schema/prisma/entities）。输出：CommonJS 工厂模块，导出 handle({method,path,body,query})。
// 设计：单次 LLM 调用、非交互、失败静默降级（mock server 退回空壳兜底，不阻塞预览）。
const MOCK_FACTORY_PROMPT = `You are generating a mock-data factory for a frontend dev preview.
Read the route registrations, handler return statements, and data models provided below, then output ONE CommonJS module (and nothing else, no markdown fences).

Module contract:
- module.exports = { handle }
- handle({ method, path, body, query }) must return a JS object (the response body) or null if the route is unknown.
- Response envelope: COPY the handler's actual return statement verbatim-shape. If the handler returns {access_token, refresh_token, user} at top level, your mock MUST return exactly those top-level keys with those exact spellings (snake_case vs camelCase matters — the frontend reads data.access_token or data.data.list etc. literally). Do NOT invent a {code:0,data:...} wrapper unless handlers actually return that.
- Auth/login/register endpoints: return plausible tokens (e.g. 'mock-jwt-header.payload.sig') + a user object, at top level if the handler does.
- Data must be REALISTIC and DETERMINISTIC (seeded pseudo-random; stable across restarts):
  * list endpoints: 8 plausible items with plausible field values (names, emails, dates in the past, booleans, statuses seen in the models)
  * detail endpoints (/:id): return the first list item
  * POST/PUT/PATCH: echo request body merged with an id, wrapped the same way the handler wraps it
  * DELETE: same success shape the handler returns
- Route params: extract from path segments (e.g. /api/users/42 -> id="42") and match loosely.
- Cover EVERY route you can see. Unknown routes -> null (server falls back).

Routes, handler returns, and models (verbatim excerpts):
`;

async function generateMockFactory({ workspacePath, hostWorkspacePath, runtimeRef }) {
    const runtime = getRuntime();
    // 收集路由/模型摘要（guest 侧）。两级来源：
    //   1) grep 路由注册行（Express/Koa router.get / NestJS @Get 装饰器 / Flask @app.route）
    //   2) 全部失败时 fallback：目录树（2 层）+ 所有 package.json scripts + 后端入口文件头
    //      ——LLM 从「这个项目有什么结构」推断接口面，弱于真路由但远好于放弃
    const GREP_CMD =
        // 关键：grep -r 从根扫会把根 node_modules（root 装过依赖）里的测试 fixture
        // 全抓进来，而 `-h` 输出无路径、`grep -v node_modules` 永远匹配不上 → head -80
        // 配额被垃圾占满，真路由（fastify.）根本进不了 prompt（实测 19:33 工厂照着
        // Hono 测试样例造）。改为显式只扫业务源码目录 + 排除注释行。
        // 上下文三段：路由注册行 + handler 的 return/reply.send 语句（包络与字段名的
        // 唯一权威——LLM 猜 {code:0,data:...} 而真包络是裸 {access_token} 会让前端
        // 解析失败，实测登录页就这样卡住）+ 数据模型。
        // 裁剪扫描面：去掉 '.' 兜底（业务目录已覆盖；它会扫到 .git/dist/gateway/docs 全树，
        // virtiofs 递归 IO 慢，实测沙箱内 30s 超时而宿主 1s——扫描量是关键）+ 目录 prune。
        `for d in server/src server/app src api backend web/src frontend/src client/src app/src server web frontend client app; do ` +
        `[ -d "$d" ] || continue; ` +
        `grep -rnE "(fastify|router|app|api)\\.(get|post|put|delete|patch|route)\\(|@(Get|Post|Put|Delete|Patch|Controller)\\(|@app\\.route" ` +
        `--include='*.js' --include='*.ts' --include='*.mjs' --include='*.py' --include='*.go' ` +
        `--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage "$d" 2>/dev/null; done ` +
        `| grep -v node_modules | grep -vE ":[0-9]+:\\s*[*//]" | sort -u | head -60; ` +
        // Next.js app router 的路由就是目录结构（page.tsx/route.ts）——没有注册行可
        // grep，补一段文件树让 LLM 从路径推出页面/API 面（multica 实测 route-grep
        // 真空、工厂失败的根因）。route.ts 是 API 端点，优先展示完整路径。
        `echo '--- NEXTJS ROUTES ---'; ` +
        `find apps/web/src/app apps/web/app src/app app app/src -maxdepth 5 \\( -name 'page.tsx' -o -name 'route.ts' -o -name 'page.ts' \\) -not -path '*/node_modules/*' 2>/dev/null | head -40; ` +
        `echo '--- HANDLER RETURNS ---'; ` +
        // grep -A2：return { 往往跨行（access_token 单独一行）——只抓 return 行看不到字段名
        `for d in server/src src api backend server web/src frontend/src client/src; do [ -d "$d" ] || continue; ` +
        `grep -rnA2 -E "return \\{|reply\\.(code\\([0-9]+\\)\\.)?send\\(|res\\.(status\\([0-9]+\\)\\.)?json\\(" ` +
        `--include='*.js' --include='*.ts' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=coverage "$d" 2>/dev/null; done ` +
        `| grep -v node_modules | grep -vE "^[^:]+:[0-9]+[-:]\\s*[*//]" | sort -u | head -120; ` +
        `echo '--- MODELS ---'; ` +
        `find server/src src api backend server web/src -maxdepth 4 \\( -name 'schema.prisma' -o -name 'models.py' -o -name 'schema.sql' -o -path '*entities*.ts' \\) -not -path '*/node_modules/*' 2>/dev/null | head -5 | xargs -r head -c 6000`;
    const FALLBACK_CMD =
        `echo '--- TREE ---'; find . -maxdepth 2 -type d -not -path '*/node_modules*' -not -path '*/.git*' 2>/dev/null | head -30; ` +
        `echo '--- PKGS ---'; find . -maxdepth 2 -name package.json -not -path '*/node_modules/*' 2>/dev/null | head -6 | xargs -r grep -h '"\\(dev\\|start\\|scripts\\|main\\)"' 2>/dev/null | head -20; ` +
        `echo '--- ENTRY ---'; find . -maxdepth 3 \\( -name 'main.ts' -o -name 'main.js' -o -name 'index.ts' -o -name 'app.py' -o -name 'main.py' \\) -not -path '*/node_modules/*' 2>/dev/null | head -4 | xargs -r head -c 5000`;
    let excerpts = '';
    let lastDiag = '';
    for (const [label, cmd] of [['route-grep', GREP_CMD], ['structure-fallback', FALLBACK_CMD]]) {
        // 连续 3 次预览 route-grep 在沙箱内空输出（宿主同命令 57KB）——exec 层有稳定
        // 故障（超时/权限/shell 差异）。失败时把 exit code + stderr 带出来，一眼定位。
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const r = await runtime.exec.exec('sh', ['-c', cmd + '; echo "XC_EXIT:$?" 1>&2'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 }).catch((e) => ({ _err: e }));
                excerpts = String(r?.stdout || '').trim();
                lastDiag = `exit=${r?.exitCode ?? r?._err?.message?.slice(0, 60) ?? '?'} stderr=${String(r?.stderr || r?._err?.stderr || '').slice(-120).replace(/\n/g, ' ')}`;
                if (excerpts.length >= 40) {
                    quickLog(`mock factory context via ${label} (${excerpts.length}B, attempt ${attempt + 1})`);
                    attempt = 9; break; // 成功，跳出重试
                }
                if (attempt === 0) quickLog(`mock factory context ${label} empty (attempt 1, ${lastDiag}); retrying`);
            } catch (e) {
                lastDiag = e.message?.slice(0, 100);
            }
        }
        if (excerpts.length >= 40) break;
        quickLog(`mock factory context ${label} failed after retry (${lastDiag})`);
    }
    // 弱上下文防线：structure-fallback 只有目录树+scripts（~800B），LLM 从中推断不出
    // 响应包络/字段名，产物必是垃圾（实测 66B/115B）——直接放弃，保住已有旧工厂。
    // route-grep 偶发空输出（exec 抖动）也会掉进这里，属正确行为：宁缺毋滥。
    const isWeakContext = excerpts.includes('--- TREE ---') && !excerpts.includes('fastify.') && !excerpts.includes('router.') && !excerpts.includes('app.get') && !excerpts.includes('app.post');
    if (!excerpts || excerpts.length < 40 || isWeakContext) {
        quickLog(`mock factory context unusable (${excerpts.length}B, weak=${isWeakContext}); skip generation to preserve existing factory`);
        return false;
    }
    // LLM 单次调用（现成 analyze 配置）+ 1 次重试：空响应/5xx 常态偶发，静默放弃
    // 会把整条拟真数据链路打回空壳兜底（实测 len=0 两次）。
    const API_KEY = process.env.LLM_ANALYZE_API_KEY;
    const API_URL = process.env.LLM_ANALYZE_API_URL;
    const MODEL = process.env.LLM_ANALYZE_MODEL || 'deepseek-chat';
    if (!API_KEY || !API_URL) {
        quickLog('no LLM config; skip mock factory');
        return false;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120000);
        let content = '';
        try {
            // 调用姿势与 analyzeDeploy.callLlm 对齐：thinking disabled（glm 等推理
            // 模型不关 thinking 会把 max_tokens 烧在 reasoning 上 → content 为空——
            // 实测 19:26 两次 len=0 的根因）；finish_reason/usage 落日志可观测。
            const bodyObj = { model: MODEL, temperature: 0.2, max_tokens: 16000, messages: [
                { role: 'system', content: 'Output raw JavaScript only. No markdown, no explanation.' },
                { role: 'user', content: MOCK_FACTORY_PROMPT + excerpts.slice(0, 12000) },
            ] };
            if (!NO_THINKING_MODELS.has(MODEL)) bodyObj.thinking = { type: 'disabled' };
            const resp = await fetch(chatCompletionsUrl(API_URL), {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
                body: JSON.stringify(bodyObj),
            });
            if (!resp.ok) {
                const errBody = await resp.text().catch(() => '');
                quickLog(`mock factory LLM http ${resp.status} (attempt ${attempt}): ${errBody.slice(0, 150)}`);
                continue; // 重试
            }
            const data = await resp.json();
            const choice = data?.choices?.[0];
            quickLog(`mock factory LLM finish_reason=${choice?.finish_reason} usage=${JSON.stringify(data?.usage || {}).slice(0, 120)}`);
            content = String(choice?.message?.content || '');
        } catch (e) {
            quickLog(`mock factory LLM call failed (attempt ${attempt}): ${e.message?.slice(0, 120)}`);
            continue;
        } finally {
            clearTimeout(timer);
        }
        // 剥掉可能的 ``` 包裹；前导空白/换行也剥掉（glm 有时先输出空行再 module.exports，
        // 严格 startsWith 会误杀 17837B 的合格产物——实测 19:41 attempt 1）。
        content = content.replace(/^```[a-z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
        if (!/^module\.exports/m.test(content) || content.length < 200) {
            quickLog(`mock factory output unusable (len=${content.length}, attempt ${attempt})`);
            continue; // 重试
        }
        // 沙箱内语法自检后再落盘——坏的工厂会拖垮整个 mock server
        const chk = await runtime.exec.exec('sh', ['-c',
            `cat > /tmp/_mf_check.cjs <<'XENSEMBLE_MF_EOF'\n${content}\nXENSEMBLE_MF_EOF\nnode -e "const m=require('/tmp/_mf_check.cjs'); if(typeof m.handle!=='function')process.exit(3)" && echo FACTORY_OK`],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 20000 }).catch(() => null);
        if (!chk || !/FACTORY_OK/.test(String(chk.stdout || ''))) {
            quickLog(`mock factory syntax/contract check failed (attempt ${attempt}); discard`);
            continue;
        }
        await runtime.fs.fsWrite(workspacePath, '.xensemble/mocks/_generated.cjs', content, { runtimeRef });
        quickLog(`mock factory generated (${content.length} bytes)`);
        return true;
    }
    return false;
}

// mock endpoints 种子：最近一次成功部署的 verify API 探测结果（plan 缓存 trail）+
// workspace .xensemble/mocks/*.json 约定文件（GET__api__users.json → GET /api/users）。
async function collectMockEndpoints(projectId) {
    const endpoints = [];
    try {
        const rows = await db.select({ id: schema.deployments.id }).from(schema.deployments)
            .where(and(eq(schema.deployments.projectId, projectId), inArray(schema.deployments.status, ['running'])))
            .limit(1);
        // apiVerdict endpoints 存在 verify trail/final 里——简化：从 plan 缓存的 trail 抓
        const saved = await loadVerifyState(projectId).catch(() => null);
        if (saved && Array.isArray(saved.trail)) {
            for (const t of saved.trail) {
                const txt = JSON.stringify(t);
                const re = /"(GET|POST|PUT|DELETE|PATCH) (\/[a-zA-Z0-9/_-]+)"/g;
                let m;
                while ((m = re.exec(txt)) !== null) {
                    if (!endpoints.some((e) => e.method === m[1] && e.path === m[2])) endpoints.push({ method: m[1], path: m[2] });
                    if (endpoints.length >= 40) break;
                }
            }
        }
    } catch { /* best-effort */ }
    return endpoints;
}

// mock server：写进沙箱 spawn（长命通道）。逻辑极简：
//   GET/POST/PUT/DELETE/PATCH 任意 /api/* → 查 .xensemble/mocks/<METHOD>__<path>.json
//   命中返回文件内容；未命中但有 endpoint 种子 → 返回 { data: null, mock: true, path }
//   404 兜底 → { mock: true, error: 'no mock for <path>' }（仍 200，前端不炸）
async function startMockServer({ runtimeRef, workspacePath, port, endpoints }) {
    const runtime = getRuntime();
    const script = QUICK_MOCK_SERVER_SCRIPT.replace('__PORT__', String(port))
        .replace('__ENDPOINTS__', JSON.stringify(endpoints || []));
    try {
        await runtime.fs.fsWrite(workspacePath, '.agents/quickMockServer.cjs', script, { runtimeRef });
        await runtime.exec.spawn('node', ['.agents/quickMockServer.cjs'], { HOME: process.env.HOME || '/root', PATH: process.env.PATH || '/usr/bin:/bin' }, { runtimeRef, cwd: workspacePath });
    } catch (e) {
        quickLog(`mock spawn failed: ${e.message}`);
        return false;
    }
    for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const chk = await runtime.exec.exec('sh', ['-c', `curl -s -m 2 http://127.0.0.1:${port}/__mock_ping`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 6000 }).catch(() => null);
        if (chk && /"ok":true/.test(String(chk.stdout || ''))) return true;
    }
    return false;
}

const QUICK_MOCK_SERVER_SCRIPT = `#!/usr/bin/env node
// 快速预览 Mock API：/api/* 恒定返回 mock 数据（不从真实后端代理）。
// 数据优先级：
//   1. .xensemble/mocks/<METHOD>__<path>.json      （用户手写，完全覆盖）
//   2. .xensemble/mocks/_generated.cjs             （LLM 拟真工厂：真实包络+合理数据+写操作回显）
//   3. 通用兜底                                     （保活不报错，提示如何补 mock）
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = __PORT__;
const ENDPOINTS = __ENDPOINTS__;
const MOCK_DIR = '.xensemble/mocks';
// 工厂模块按 mtime 惰性加载：用户/生成器更新文件后无需重启 mock server
let factory = null;
let factoryMtime = 0;
function loadFactory() {
    try {
        const f = path.join(MOCK_DIR, '_generated.cjs');
        const st = fs.statSync(f);
        if (!factory || st.mtimeMs !== factoryMtime) {
            delete require.cache[require.resolve(path.resolve(f))];
            factory = require(path.resolve(f));
            factoryMtime = st.mtimeMs;
            console.error('mock factory loaded');
        }
    } catch (e) { factory = null; }
}
http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__mock_ping') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); return; }
    const send = (code, obj) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const cleanPath = url.pathname.replace(/^\\/+/, '').replace(/\\/+$/, '');
    // 1) 用户手写 JSON 文件（精确路径 + GET 回退）
    const candidates = [
        path.join(MOCK_DIR, (req.method + '__' + cleanPath).replace(/\\//g, '__') + '.json'),
        path.join(MOCK_DIR, ('GET__' + cleanPath).replace(/\\//g, '__') + '.json'),
    ];
    for (const f of candidates) {
        try { return send(200, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* next */ }
    }
    // 2) LLM 拟真工厂（POST/PUT/PATCH 读 body 传入，支持写操作回显）
    loadFactory();
    if (factory && typeof factory.handle === 'function') {
        let body;
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
        req.on('end', () => {
            try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
            let out = null;
            try {
                out = factory.handle({ method: req.method, path: url.pathname, body, query: Object.fromEntries(url.searchParams) });
            } catch (e) { console.error('factory handle error:', e.message); }
            if (out && typeof out === 'object') return send(200, out);
            // 3) 兜底按「前端期望的类型」分化：
            //    SSE 端点（EventSource 要求 text/event-stream）→ 合法空流并保活，
            //    否则 EventSource 拿到 JSON 立即断连重试刷屏（实测 console 报错）。
            var lastSeg = ('/' + cleanPath).split('/').pop() || '';
            var isSse = lastSeg === 'events' || lastSeg === 'stream' || lastSeg === 'sse' || lastSeg === 'tail' || lastSeg === 'logs' || String(req.headers.accept || '').indexOf('text/event-stream') >= 0;
            if (isSse) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
                res.write(': mock sse\\n\\n');
                var ka = setInterval(function () { try { res.write(': ka\\n\\n'); } catch (e2) { clearInterval(ka); } }, 15000);
                req.on('close', function () { clearInterval(ka); });
                return;
            }
            //    数组型资源（前端大概率 data.filter/map）→ 空数组而不是 null，避免 TypeError；
            //    尾段后缀匹配：'custom-images'/'api-keys' 这类连字符资源也要命中
            //    （精确段匹配漏掉它们 → 兜底 {data:null} → 前端 data.images ?? data 整个
            //    对象被当数组 .filter 炸——实测 CustomImages.jsx:99）。catalog 不以资源名
            //    结尾不误伤；detail 路由返回 [] 也可接受（.filter/.map 同样不炸）。
            var ARRAY_RESOURCES = ['images', 'files', 'items', 'users', 'projects', 'sessions', 'repos', 'keys', 'tokens', 'logs', 'containers', 'services', 'nodes', 'tasks', 'jobs', 'models', 'providers', 'quotas', 'members', 'roles', 'tags', 'backups', 'endpoints', 'webhooks'];
            var lastSegForArr = cleanPath.split('/').pop() || '';
            var isArrayResource = req.method === 'GET' && ARRAY_RESOURCES.some(function (s) { return lastSegForArr === s || lastSegForArr.endsWith('-' + s); });
            if (isArrayResource) {
                return send(200, []);
            }
            return send(200, { data: null, mock: true, path: '/' + cleanPath, note: 'no mock; add ' + MOCK_DIR + '/' + req.method + '__' + cleanPath.replace(/\\//g, '__') + '.json' });
        });
        return;
    }
    // 无工厂：endpoints 种子空壳 / 通用兜底
    const ep = ENDPOINTS.find((e) => e.path && cleanPath.startsWith(e.path.replace(/^\\//, '')));
    if (ep) return send(200, { data: null, mock: true, endpoint: ep.method + ' /' + cleanPath });
    return send(200, { data: null, mock: true, path: '/' + cleanPath, note: 'no mock; add ' + MOCK_DIR + '/' + req.method + '__' + cleanPath.replace(/\\//g, '__') + '.json' });
}).listen(PORT, '0.0.0.0', () => console.error('quick mock on ' + PORT));
`;

// ── 入口编排：互斥 + 记录 + 两阶段 ────────────────────────────────
async function runQuickPreview({ projectId, userId, getProjectForUser, onProgress, onStarted, sessionId }) {
    // deployRef 提前声明（id 在插入记录后回填）：report 需要它把子阶段持久化。
    const deployRef = { id: null, lastSub: null };
    const report = (p) => {
        if (onProgress) { try { onProgress(p); } catch (_) { /* SSE closed */ } }
        // 子阶段持久化到 DB：刷新后前端恢复进度条需要真实阶段。原先 dev 行 stage 恒 'A'
        // 且无子阶段，恢复时只能硬编码猜步 → 刷新后进度条跳步/错位（实测"安装依赖中刷新
        // 就蹦出预览页"）。dev 行的 stage 列不被其它逻辑消费（findBuildingDeployRecord 只
        // 查 kind='deploy'），用它存最新子阶段最省事。同值不写（节流）。
        if (deployRef.id && p && p.stage === 'B' && p.substage && deployRef.lastSub !== p.substage) {
            deployRef.lastSub = p.substage;
            db.update(schema.deployments)
                .set({ stage: p.substage, updatedAt: Date.now() })
                .where(eq(schema.deployments.id, deployRef.id))
                .catch(() => { /* 持久化失败不影响预览本身 */ });
        }
    };
    const project = await getProjectForUser(userId, projectId);
    if (!project) return { ok: false, error: 'Project not found' };

    // ── 互斥 + 自愈式重启（自我排除修复）──
    // 1) 本进程内有在飞任务（同项目，注册表键=projectId）：拒绝并明说，避免同沙箱并发。
    // 2) 完整部署/预览记录（kind='deploy'/'preview'）在飞：拒绝（重操作有自己的生命周期）。
    // 3) kind='dev' 残留记录（同 session 重入 / 上次失败残留 / session_id 变化导致
    //    比对不上——旧记录 sessionId=null 就会出现「会话「未命名会话」占用」）：直接
    //    停掉旧预览（杀进程+停隧道+记录标 stopped）再继续——预览是轻量操作，
    //    「重启」语义比拒绝友好（实测用户反复被自己上一条残留记录挡住）。
    const inflight = peekDeploy(projectId, sessionId);
    if (inflight) {
        return { ok: false, code: 'deploy_in_progress', error: '预览正在启动中，请稍候再试', occupants: await buildOccupants(projectId, userId) };
    }
    const existing = await db.select({ id: schema.deployments.id, kind: schema.deployments.kind, status: schema.deployments.status, sessionId: schema.deployments.sessionId })
        .from(schema.deployments)
        .where(and(
            eq(schema.deployments.projectId, projectId),
            eq(schema.deployments.userId, userId),
            inArray(schema.deployments.status, ['building', 'running', 'pending']),
        ));
    const heavyInFlight = existing.filter((r) => (r.kind === 'deploy' || r.kind === 'preview'));
    if (heavyInFlight.length) {
        return {
            ok: false,
            code: 'deploy_in_progress',
            error: '该工作区已有部署/预览在进行中，请先停止后再试',
            occupants: await buildOccupants(projectId, userId),
        };
    }
    if (existing.some((r) => r.kind === 'dev')) {
        quickLog('existing dev preview record(s) found; stopping old preview before restart');
        await stopQuickPreview({ projectId, userId });
    }

    const deployId = `dep_${crypto.randomBytes(8).toString('hex')}`;
    deployRef.id = deployId;
    const deployState = { cancelled: false };
    const now0 = Date.now();
    try {
        await db.insert(schema.deployments).values({
            id: deployId, userId, projectId, sessionId: sessionId || null, runtimeId: null,
            kind: 'dev', status: 'building', stage: 'A', createdAt: now0, updatedAt: now0, createdBy: userId,
        });
        if (onStarted) { try { onStarted(deployId); } catch (_) { /* SSE closed */ } }
    } catch (e) {
        return { ok: false, error: `failed to create preview record: ${e.message}` };
    }
    if (!registerDeploy(projectId, userId, sessionId)) {
        // 注册表键被占（同项目部署在飞，DB 记录尚未落库的窗口）——回滚并拒绝
        await db.update(schema.deployments).set({ status: 'stopped', updatedAt: Date.now() }).where(eq(schema.deployments.id, deployId));
        return { ok: false, code: 'deploy_in_progress', error: '该工作区已有预览在进行中，请先停止后再开始新的预览', occupants: await buildOccupants(projectId, userId) };
    }
    const startedAt = Date.now();
    let result;
    // 预览存续期心跳：每小时 touch updatedAt。没有它，运行中的预览 2 小时后会被
    // lifecycle.reclaimStaleBuildingDeploys 判为僵尸回收（连进程一起杀）——活跃
    // 预览被误杀。终态落库后心跳即停。
    const keepAlive = setInterval(() => {
        db.update(schema.deployments).set({ updatedAt: Date.now() })
            .where(eq(schema.deployments.id, deployId)).catch(() => {});
    }, 60 * 60 * 1000);
    try {
        result = await runQuickPreviewInner({ project, userId, projectId, sessionId, report, startedAt, deployRef, deployState });
        return result;
    } finally {
        clearInterval(keepAlive);
        unregisterDeploy(projectId, sessionId);
        // 终态按实际结果落库——此前无条件标 running：dev server 失败时记录仍显示
        // running（无 public_url），前端轮询误判"还在跑"，且占用互斥空间导致
        // 下一次快速预览被 deploy_in_progress 拒绝。
        await db.update(schema.deployments).set({
            status: result?.ok ? 'running' : 'failed',
            updatedAt: Date.now(),
        }).where(eq(schema.deployments.id, deployId)).catch(() => {});
    }
}

// 沙箱内预览相关进程清理（pkill 模式单一来源）：next 15+ 的服务进程名是
// next-server（`next dev` 只是父 CLI，`pkill -f "next dev"` 匹配不到它——
// 幽灵进程实测根因），必须两者都杀。
const PREVIEW_PKILL = 'pkill -f quickMockServer.cjs 2>/dev/null; pkill -f previewProxyServer.cjs 2>/dev/null; pkill -f "vite --host" 2>/dev/null; pkill -f "vite.*--port" 2>/dev/null; pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; pkill -f "nuxt dev" 2>/dev/null; pkill -f "npm run dev" 2>/dev/null; true';

// 停止快速预览：杀 dev server/mock/代理进程 + 停隧道 + 记录置 stopped
async function stopQuickPreview({ projectId, userId }) {
    try { stopByProjectId(projectId); } catch { /* tunnel may be gone */ }
    try {
        const { ensureProjectRuntime } = require('../runtime/RuntimeService');
        const project = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
        if (project[0]) {
            const ready = await ensureProjectRuntime(project[0], {});
            const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
            const runtime = getRuntime();
            await runtime.exec.exec('sh', ['-c', PREVIEW_PKILL],
                {}, { runtimeRef: ref, cwd: ready.workspacePath, timeoutMs: 15000 });
        }
    } catch (e) {
        quickLog(`stop cleanup error (non-fatal): ${e.message}`);
    }
    await db.update(schema.deployments).set({ status: 'stopped', updatedAt: Date.now() })
        .where(and(eq(schema.deployments.projectId, projectId), eq(schema.deployments.kind, 'dev'), inArray(schema.deployments.status, ['running', 'building'])));
    return { ok: true };
}

// 路由：SSE 流式（与 auto-deploy 同构），POST 启动 / DELETE 停止。
function registerQuickPreviewRoutes(fastify, { getProjectForUser }) {
    fastify.post('/api/v1/projects/:projectId/quick-preview', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
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
            const result = await runQuickPreview({
                projectId: request.params.projectId,
                userId: request.user.id,
                getProjectForUser,
                sessionId: request.query?.session_id || request.body?.session_id,
                onProgress: (p) => send({ type: 'progress', ...p }),
                onStarted: (deploymentId) => send({ type: 'started', deploymentId }),
            });
            // 事件协议与 auto-deploy 对齐：终态必须是 type='result' + result 字段——
            // 前端 DeployPanel 只处理 started/progress/result/error，'done' 会被静默
            // 忽略 → SSE 正常关闭但 UI 永远停在 running（"卡在启动服务"实测根因之一）。
            send({ type: 'result', result: { ok: !!result?.ok, ...result } });
        } catch (e) {
            send({ type: 'result', result: { ok: false, error: e.message } });
        }
        reply.raw.end();
    });

    fastify.delete('/api/v1/projects/:projectId/quick-preview', { preValidation: [fastify.authenticate, fastify.requireActive] }, async (request, reply) => {
        const result = await stopQuickPreview({ projectId: request.params.projectId, userId: request.user.id });
        return reply.send(result);
    });
}

module.exports = { runQuickPreview, stopQuickPreview, registerQuickPreviewRoutes };
