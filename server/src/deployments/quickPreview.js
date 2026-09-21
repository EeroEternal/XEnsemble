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
const { resolveDeployEnvironment } = require('../runtime/CustomImageService');
const { localizeDeployError } = require('./deployErrors');
const { getRuntime } = require('../runtime/registry');
const { createTunnel, stopByProjectId } = require('../preview/tunnelServer');
const { resolveControlPlanePublicUrlSync } = require('../llm/publicUrl');
const { analyzeProjectDeploy: analyzeProject } = require('./analyzeDeploy');
const { loadVerifyState, saveVerifyState, issuePreviewToken: _ipt } = require('./twoStage');
const deploymentService = require('./DeploymentService');
const { registerDeploy, peekDeploy, unregisterDeploy, deployKey } = require('./activeDeploys');
// 0043：LLM 调用统一走 analyzeClient —— 端点归一化/thinking 名单收口，token 消耗
// 以 source='internal' 落 llm_usage，归属到发起用户（feature='quick_preview'）。
const llm = require('../llm/analyzeClient');

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

// LLM 端点归一化（chatCompletionsUrl）与 thinking 不支持名单（NO_THINKING_MODELS）
// 已收口到 analyzeClient：本文件的 LLM 调用全部改走 llm.chatRaw（0043 内部计量）。

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
    // 0043：内部计量归属 —— 本流程全部 LLM 消耗（plan / heal / mock factory）记到发起用户名下。
    const metering = { feature: 'quick_preview', userId, sessionId, projectId };
    // 锁定会话的 worktree runtime（与部署 twoStage 同规则）：不传 runtimeId 时
    // ensureProjectRuntime 会落到 project.defaultRuntimeId（基础目录），而基础目录带
    // 平台占位 index.html → detectStack 误判 static → buildCmd 为空、devKind 为 null
    // （frontend+backend 多仓库项目预览失败实测根因）。预览必须和部署看同一份代码。
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
            quickLog(`resolve runtimeId from session failed: ${e.message}`);
        }
    }
    // 环境就绪：镜像还在后台构建时在此等待（不计入预览时间上限）。
    try {
        const env = await resolveDeployEnvironment({
            userId,
            sessionId,
            project,
            shouldContinue: () => !deployState.cancelled,
            onWaiting: () => report({
                stage: 'A',
                message: '等待镜像后台构建中…',
                waitingImage: true,
            }),
        });
        Object.assign(ensureOpts, env);
    } catch (err) {
        if (err && err.cancelled) {
            return { ok: false, aborted: true, code: 'deploy_aborted', error: '预览已中止' };
        }
        console.error(`[quickPreview] environment not ready: ${err.message}`);
        return { ok: false, code: err.code || 'custom_image_not_ready', error: err.message };
    }

    const ready = await ensureProjectRuntime(project, ensureOpts);
    const ref = ready.runtime ? ready.runtime.runtimeRef : undefined;
    const wsPath = ready.workspacePath;
    const hostPath = ready.hostWorkspacePath || wsPath;

    // 宿主目录属主修正（必须在任何沙箱写入之前）：server 以 root 创建项目/worktree，
    // 目录属 root:root(755)；而 virtiofs 由 blink-server（administrator, uid 1000）
    // 导出，沙箱内写入以 1000 落盘 → 对 root 属主目录无写权限 → mock 工厂/依赖安装/
    // 前端构建全部 write failed → 预览失败（实测 6/6 相关：有部署记录的项目目录属 1000
    // 可写，无部署记录的属 0:0 不可写）。部署路径（twoStage）一直有此修正，快速预览漏了，
    // 表现为「新建项目直接点预览必失败，先跑一次完整部署才正常」。
    // 传基础目录：函数内部会级联修复 <base>.wt/* 下所有 worktree（当前会话 runtime 就在
    // 其中）。不传 hostPath——boxlite 下 hostWorkspacePath 可能为 undefined，此时它会回退
    // 成 guest 路径 /workspace，chown 会打偏。函数自带 try/catch，失败仅告警不阻塞。
    try {
        const { repairHostWorkspaceOwnership } = require('./twoStage');
        const workspace = require('../workspace');
        repairHostWorkspaceOwnership(workspace.projectDir(userId, projectId));
    } catch (e) {
        quickLog(`repair workspace ownership failed (non-fatal): ${e.message}`);
    }

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
        const analyzed = await analyzeProject({ workspacePath: wsPath, hostWorkspacePath: hostPath, runtimeRef: ref, isAborted: () => deployState.cancelled, userId, projectId });
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

    // 沙箱环境前置（镜像源 + pnpm 预装）：runPlatformInstall 的文档化前置条件
    // （见 twoStage configureGuestMirrors 注释），部署路径一直调用，快速预览漏了。
    // 后果：镜像只带 corepack 不带 pnpm 二进制，而 pnpm-lock.yaml 项目的 install/build
    // 都用 `pnpm ...` → 秒失败 `sh: 1: pnpm: not found`（exit 127）→ 依赖缺失 → 构建失败
    // → 预览失败。该函数幂等（pnpm 已装则跳过），同时铺 npm/pnpm/pip 镜像源加速安装。
    // 必须无条件执行：依赖缓存命中时 node_modules 虽在，但 `pnpm run build` 仍要 pnpm 二进制。
    try {
        const { configureGuestMirrors } = require('./twoStage');
        await configureGuestMirrors(ref, wsPath, (m) => quickLog(String(m).slice(0, 160)));
    } catch (e) {
        quickLog(`configure guest mirrors failed (non-fatal): ${e.message}`);
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
    // 标志位为真≠产物可用：DB 标志位与沙箱产物生命周期不一致（沙箱重建丢产物、标志位
    // 仍在）。必须先探测产物，不能只信标志位——否则「既不生成也不兜底」，工厂缺失导致
    // 登录等硬前置接口卡死（见 probeFactoryArtifact）。
    const GEN = '.xensemble/mocks/_generated.cjs';
    const BAK = '/tmp/_generated.cjs.bak';
    let factoryOk = plan.mockDataFactory
        ? await probeFactoryArtifact({ runtimeRef: ref, workspacePath: wsPath })
        : false;
    if (plan.mockDataFactory && !factoryOk) {
        quickLog('mock factory flagged as cached but artifact missing/unusable; regenerating');
    }
    if (!factoryOk || forceRegen) {
        if (forceRegen) quickLog('mock factory regenerate forced (MOCK_FACTORY_REGENERATE=1)');
        try {
            await runtime.exec.exec('sh', ['-c', `cp ${GEN} ${BAK} 2>/dev/null; rm -f ${GEN}`], {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 5000 }).catch(() => null);
            const generated = await generateMockFactory({ workspacePath: wsPath, hostWorkspacePath: hostPath, runtimeRef: ref, metering });
            if (generated) {
                plan.mockDataFactory = true;
                factoryOk = true;
                if (forceRegen) {
                    // 一次性开关：清本进程 + 提示用户清 systemd 环境（delete 只影响当前进程，
                    // systemd 重启会重新注入——20:04 事故根因）。用 DEPLOY_MOCK_NO_REGEN 永久关闸。
                    delete process.env.MOCK_FACTORY_REGENERATE;
                    quickLog('mock factory regenerated OK; unset MOCK_FACTORY_REGENERATE in-process (systemd env must be removed too: sudo systemctl unset-environment MOCK_FACTORY_REGENERATE)');
                }
                try { await saveVerifyState(projectId, { plan, messages: [], trail: [], roundsUsed: 0, runtimeRef: ref, workspacePath: wsPath }); } catch { /* cache best-effort */ }
            } else {
                // 生成失败 → 回滚旧工厂（有的话）；回滚失败则产物仍缺失，如实记回探测结果，
                // 避免下方 readiness 日志谎报 factory=true。
                await runtime.exec.exec('sh', ['-c', `[ -f ${BAK} ] && mv ${BAK} ${GEN} || true`], {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 5000 }).catch(() => null);
                quickLog('mock factory generation failed; previous factory restored (if any)');
                factoryOk = await probeFactoryArtifact({ runtimeRef: ref, workspacePath: wsPath });
            }
        } catch (e) {
            quickLog(`mock factory generation failed (non-fatal): ${e.message}`);
            await runtime.exec.exec('sh', ['-c', `[ -f ${BAK} ] && mv ${BAK} ${GEN} || true`], {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 5000 }).catch(() => null);
            factoryOk = await probeFactoryArtifact({ runtimeRef: ref, workspacePath: wsPath });
        }
    } else {
        quickLog('mock factory cached and artifact verified, skipping generation');
    }
    const mockEndpoints = await collectMockEndpoints(projectId);
    // 前端期望裸数组的端点（确定性兜底）：工厂可能漏掉某端点（LLM 覆盖不全），此时通用
    // 兜底返回 {data:null} 对象，而前端对该端点做 .filter/.map → TypeError 白屏（实测
    // /v2/users/me/organizations）。这里把前端 request<X[]> 的路径传给 mock server，
    // 未命中工厂时按路径后缀匹配返回 []，把"漏一个端点就白屏"降级为"该列表为空"。
    let arrayPaths = Array.isArray(plan.arrayPaths) ? plan.arrayPaths : null;
    if (!arrayPaths) {
        arrayPaths = await extractArrayPaths({ runtimeRef: ref, workspacePath: wsPath });
        if (arrayPaths.length) {
            plan.arrayPaths = arrayPaths;
            try { await saveVerifyState(projectId, { plan, messages: [], trail: [], roundsUsed: 0, runtimeRef: ref, workspacePath: wsPath }); } catch { /* best-effort */ }
        }
    }
    const mockOk = await startMockServer({ runtimeRef: ref, workspacePath: wsPath, port: mockPort, endpoints: mockEndpoints, arrayPaths });
    if (mockOk) quickLog(`mock server ready on :${mockPort} (factory=${factoryOk})`);
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

    // 启动 live dev server（含失败自愈）。仅在存在 live 能力的前端时走 dev server：
    // devKind=null（umi 等无 live 能力的目标）走下方"构建 + 静态 serve"兜底——盲目在
    // 根目录跑 `npm run dev` 会因根无 package.json 而 ENOENT（多仓库布局实测）。
    let live = { ok: false, reason: 'no live-capable dev target', logTail: '' };
    if (detected.devKind) {
        const attempt = await attemptLiveDevServer({ ref, wsPath, hostPath, detected, recipe, base: basePath, report, metering });
        live = attempt.live;
        detected = attempt.detected; // electron 救场可能改写 devKind/devDir
        recipe = attempt.recipe;
        if (live.ok && recipe && recipe.source !== 'cache') {
            // 成功配方回写 plan 缓存——下次预览零 LLM 直达
            plan.devRecipe = { cmd: recipe.cmd, dir: recipe.dir, port: recipe.port || null };
            try { await saveVerifyState(projectId, { plan, messages: [], trail: [], roundsUsed: 0, runtimeRef: ref, workspacePath: wsPath }); } catch { /* best-effort */ }
        }
    }

    // 服务端口（aggPort）：live 路径 = dev server + 聚合代理；无 live 能力 = 构建产物 + 静态代理。
    let aggPort = 0;
    if (detected.devKind) {
        if (!live.ok) {
            // logTail 直接拼进错误：用户在面板里看到 vite/next 崩溃的第一现场，
            // 而不是只有一句 not ready + 一个未必方便看的沙箱日志路径。
            return { ok: false, code: 'dev_server_failed', error: `开发服务器启动失败：${live.reason || '未知原因'}${live.logTail ? '\n' + live.logTail : ''}` };
        }
        // 聚合代理：前端 → dev server；/api/* → mock server（Mock 恒开，Live 已隐藏）
        report({ stage: 'B', substage: 'proxy', message: '配置代理' });
        aggPort = (await getGuestFreePortCompat(ref)) || 0;
        const proxyOk = aggPort ? await startAggregateProxyCompat({ runtimeRef: ref, workspacePath: wsPath, devPort: live.port, mockPort: mockOk ? mockPort : 0, listenPort: aggPort, base: basePath, devKind: detected.devKind }) : false;
        if (!proxyOk) {
            return { ok: false, code: 'proxy_failed', error: '预览代理启动失败（聚合代理 10s 未就绪）' };
        }
    } else {
        // 无 live 能力的前端（umi 等）：构建 + 静态 serve（详见 startStaticQuickServe）。
        report({ stage: 'B', substage: 'serve', message: '构建前端产物（该项目无 dev server）' });
        const staticServe = await startStaticQuickServe({
            runtimeRef: ref, workspacePath: wsPath, detected,
            base: basePath, mockPort: mockOk ? mockPort : 0, onLog: quickLog,
        });
        if (!staticServe.ok) {
            return { ok: false, code: 'static_serve_failed', error: `静态预览启动失败：${staticServe.reason}` };
        }
        aggPort = staticServe.port;
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
    // ── 就绪自检（根治"已完成但 iframe 显示 Bad Request"）──
    // 此前的就绪判定全是弱信号：waitForVmPort 只验证"端口在监听/任意 HTTP 响应"
    // （404/5xx 都算通过），聚合代理就绪判定放宽为"任意 3 位状态码"。旧前端要等
    // 轮询 + 人工刷新才加载 iframe，延迟掩盖了"成功宣告 ≠ 链路真正可服务"的竞态；
    // 前端改为成功即渲染（SSE 种子）后，首帧请求直接吃到链路未就绪的 400。
    // 这里用与浏览器 iframe 完全相同的公网路径（网关→隧道→聚合代理→dev server）
    // 自检，未就绪重试——确保 SSE result 发出时页面真的能打开。
    const readiness = await probePreviewReady(tunnel.publicUrl, previewToken, tunnel.browserPort);
    if (readiness !== 'ready') {
        quickLog(`preview chain not verified ready (${readiness}) after probe window; proceeding anyway`);
    }
    return { ok: true, previewUrl: tunnel.publicUrl, deploymentId: deployRef.id, previewToken, elapsedMs: Date.now() - startedAt };
}

// 就绪自检：优先走公网完整链路（与 iframe 同路径，含 nginx/网关/token 校验），
// 公网地址本机不可达时退化为直探隧道入口（隧道→聚合代理→dev server）。
// 非致命：超时也放行（保持旧可用性），只是打日志。
async function probePreviewReady(publicUrl, previewToken, browserPort, { attempts = 8, intervalMs = 1000 } = {}) {
    const withToken = `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}preview_token=${encodeURIComponent(previewToken)}`;
    const snippet = async (res) => {
        try {
            const text = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 120);
            return text ? ` body="${text}"` : '';
        } catch { return ''; }
    };
    let publicUnreachable = false;
    for (let i = 0; i < attempts; i++) {
        // 公网完整链路判定（与浏览器 iframe 同路径，含 nginx/网关/token 校验）。
        // 关键：只要收到了 HTTP 响应，就以它为准——非 2xx（400/401/502…）说明浏览器
        // 也会吃到同样的错误，绝不能用"隧道入口正常"来顶替，否则成功宣告后 iframe
        // 依旧 Bad Request。
        try {
            const res = await fetch(withToken, { signal: AbortSignal.timeout(4000), redirect: 'follow' });
            if (res.ok) {
                quickLog(`preview chain ready via public url (attempt ${i + 1})`);
                return 'ready';
            }
            quickLog(`preview probe #${i + 1}: public chain status=${res.status}${await snippet(res)}`);
        } catch (e) {
            // 只有"网络层不可达"（DNS 解析失败/本机无路由/防火墙拒绝——常见于公网域名
            // 仅在外部可解析的部署形态）才允许退化用隧道入口判定链路本身是否就绪。
            publicUnreachable = true;
            try {
                const res = await fetch(`http://127.0.0.1:${browserPort}/`, { signal: AbortSignal.timeout(4000) });
                if (res.ok) {
                    quickLog(`preview chain ready via tunnel entry (public url unreachable from host: ${e.message}); public path not verified`);
                    return 'ready';
                }
                quickLog(`preview probe #${i + 1}: tunnel entry status=${res.status}`);
            } catch (e2) {
                quickLog(`preview probe #${i + 1}: not ready (public: ${e.message}; tunnel: ${e2.message})`);
            }
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return publicUnreachable ? 'public-unreachable' : 'timeout';
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
// live dev server 启动 + 失败自愈（≤2 轮 LLM 修复）。
// 返回最终 live 结果，以及可能被改写的 detected（electron 确定性救场会换子目录前端）
// 与 recipe（自愈/回写 plan 缓存用）——调用方后续代理需要最新的 devKind。
async function attemptLiveDevServer({ ref, wsPath, hostPath, detected: detectedIn, recipe: recipeIn, base, report, metering }) {
    const runtime = getRuntime();
    let detected = detectedIn;
    let recipe = recipeIn;
    let live = await startLiveDevServerCompat({ runtimeRef: ref, workspacePath: wsPath, detected, base, recipe });
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
            live = await startLiveDevServerCompat({ runtimeRef: ref, workspacePath: wsPath, detected, base, recipe });
            continue;
        }
        report({ stage: 'B', substage: 'serve', message: `启动失败，AI 修复中（第 ${healRound + 1} 轮）` });
        quickLog(`heal round ${healRound + 1}: feeding live-dev.log to LLM`);
        const healed = await healDevRecipe({ ref, hostPath, detected, logTail, previousRecipe: recipe, metering });
        if (!healed) { quickLog('heal: LLM unavailable or no better recipe'); break; }
        recipe = { ...healed, source: `heal-${healRound + 1}` };
        quickLog(`heal round ${healRound + 1} recipe: ${recipe.cmd.slice(0, 120)}`);
        // 先杀上一轮残留进程再重试（换配方/换端口防串台）
        try {
            await runtime.exec.exec('sh', ['-c', 'pkill -f "vite --host" 2>/dev/null; pkill -f "next dev" 2>/dev/null; pkill -f "nuxt dev" 2>/dev/null; true'],
                {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 10000 });
        } catch { /* ignore */ }
        live = await startLiveDevServerCompat({ runtimeRef: ref, workspacePath: wsPath, detected, base, recipe });
    }
    return { live, detected, recipe };
}

// 无 dev server 的前端（umi 等 devKind=null）的快速预览兜底：构建产物 + 静态 serve。
// umi 的 dev 工具链在 /preview/<id>/ 子路径代理下 remoteEntry 404（白屏），平台规则是
// 不做 live、走"build + 静态 serve"（同部署路径）——但快速预览原先硬依赖 live dev
// server：devKind=null 时仍调 startLiveDevServer，落进兜底分支在根目录跑 `npm run dev`
// → 根无 package.json → ENOENT（frontend+backend 多仓库布局实测）。
// 这里复用 previewProxyServer 静态模式：注入 <base>/路由 shim、HTML 绝对路径改写为相对、
// /api 与 /ws 转发到 mock。构建耗时高于 live 预览，属"能预览"优先的取舍。
// 静态构建产物复用判断（P0 提速）：产物是纯构建输出，与预览实例无关——base 前缀与路由
// shim 都由 previewProxyServer.rewriteHtml 在 serve 时注入（见 previewProxyServer.js
// rewriteHtml），构建产物里不含 /preview/<id>/，所以同一份 dist 可跨多次预览复用。
// 判据用 mtime：沙箱内 /workspace 不是 git 仓库（.git 指针指向宿主路径，git status 报
// not a repository），拿不到 git 状态，只能比文件时间。find 扫 workspace 找"新于
// dist/index.html"的源文件，命中即视为需要重建。
// 保守原则：index.html 缺失、探测超时/异常、输出不可解析 → 一律返回 fresh=false 去构建。
// 宁可多构建一次，也绝不 serve 陈旧产物（陈旧产物 = 用户改了代码但预览不变，比慢更难查）。
// mtime 方案的已知局限：保留原 mtime 的还原（如 tar -p / rsync --times）不会触发重建。
async function isStaticBuildFresh({ runtimeRef, workspacePath, distAbs }) {
    const runtime = getRuntime();
    // prune 掉依赖/产物/元数据目录（这些不是构建输入，且 node_modules 有 1.6G，不 prune 会扫很久）；
    // 排除 *.log/*.md/*.tmp —— 文档与日志不是构建输入，改 README 不该触发 137s 重建。
    // 依赖存储目录（.pnpm-store/.yarn/.npm）也 prune：pnpm install 会往里写，但其变化不代表
    // 构建输入变了——真正的依赖变更信号是 lockfile，而 lockfile 在扫描范围内没被排除。
    const FIND = `find . `
        + `-type d \\( -name node_modules -o -name .git -o -name dist -o -name build -o -name .next `
        + `-o -name .nuxt -o -name .output -o -name .cache -o -name .turbo -o -name .parcel-cache `
        + `-o -name coverage -o -name .venv -o -name venv -o -name __pycache__ `
        + `-o -name .pnpm-store -o -name .pnpm -o -name .yarn -o -name .npm `
        + `-o -name .xensemble -o -name .agents \\) -prune `
        + `-o -type f ! -name '*.log' ! -name '*.md' ! -name '*.tmp' `
        + `-newer ${JSON.stringify(distAbs + '/index.html')} -print -quit 2>/dev/null`;
    try {
        const r = await runtime.exec.exec('sh', ['-c',
            `[ -f ${JSON.stringify(distAbs + '/index.html')} ] || { echo "XE_NO_INDEX"; exit 0; }; `
            + `NEWER=$(${FIND}); `
            + `if [ -n "$NEWER" ]; then echo "XE_CHANGED:$NEWER"; else echo "XE_FRESH:$(stat -c %y ${JSON.stringify(distAbs + '/index.html')} 2>/dev/null)"; fi`,
        ], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 60000 });
        const out = String(r.stdout || '').trim();
        if (out.startsWith('XE_FRESH:')) return { fresh: true, builtAt: out.slice('XE_FRESH:'.length).trim() };
        if (out.startsWith('XE_CHANGED:')) return { fresh: false, reason: `changed: ${out.slice('XE_CHANGED:'.length).trim().slice(0, 120)}` };
        if (out.startsWith('XE_NO_INDEX')) return { fresh: false, reason: 'no index.html' };
        return { fresh: false, reason: `unexpected probe output: ${out.slice(0, 120)}` };
    } catch (e) {
        return { fresh: false, reason: `probe failed: ${e.message?.slice(0, 120)}` };
    }
}

async function startStaticQuickServe({ runtimeRef, workspacePath, detected, base, mockPort, onLog }) {
    const runtime = getRuntime();
    // 构建命令：优先检测结果（如 `cd frontend && pnpm run build`）；缺失时从子项目里
    // 找带 build 命令的那个（多仓库布局下构建发生在子目录，根无 package.json）。
    let buildCmd = String(detected.buildCmd || '').trim();
    if (!buildCmd) {
        const sub = (detected.subProjects || []).find((s) => s.buildCmd);
        buildCmd = sub ? String(sub.buildCmd).trim() : '';
    }
    if (!buildCmd) return { ok: false, reason: '项目没有可用的构建命令（无 build 脚本），无法静态预览' };

    // 找构建产物（与 twoStage.ensureFrontendServed 同一批常见位置）。探测提到构建之前：
    // 复用判断需要先知道 dist 在哪。
    const probeDist = async () => {
        try {
            const probe = await runtime.exec.exec('sh', ['-c',
                'ls -d web/dist frontend/dist client/dist apps/web/dist apps/client/dist dist 2>/dev/null | head -1'],
                {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
            return String(probe.stdout || '').trim();
        } catch { return ''; }
    };

    // 产物复用：产物存在且无源文件比它新 → 跳过构建直接 serve。命中场景是「停预览后再启动」
    // 与反复调预览（代码没变却每次重跑全量构建，实测 137s，占静态预览总耗时 98%）。
    let dist = await probeDist();
    let reused = false;
    if (dist) {
        const distAbsChk = dist.startsWith('/') ? dist : `${workspacePath}/${dist}`;
        const chk = await isStaticBuildFresh({ runtimeRef, workspacePath, distAbs: distAbsChk });
        if (chk.fresh) {
            reused = true;
            onLog(`static fallback: reusing existing build (${dist}, built ${chk.builtAt}), skipping build`);
        } else {
            onLog(`static fallback: rebuild needed (${chk.reason})`);
        }
    }

    if (!reused) {
        onLog(`static fallback: building (${buildCmd.slice(0, 120)})`);
        const PRE = 'export PATH="/usr/local/bin:$PATH"; export CI=true; export NODE_OPTIONS="--max-old-space-size=3072"; ';
        let buildLog = '';
        try {
            const r = await runtime.exec.exec('sh', ['-c', `${PRE}${buildCmd}`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 900000 });
            buildLog = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
            if (Number(r.exitCode) !== 0) {
                return { ok: false, reason: `构建失败（exit ${r.exitCode}）：${buildLog.slice(-400)}` };
            }
        } catch (e) {
            return { ok: false, reason: `构建执行失败：${e.message}` };
        }
        onLog('static fallback: build done, probing dist');
        dist = await probeDist();
    }
    if (!dist) return { ok: false, reason: '未找到产物目录（frontend/dist、web/dist、dist 等）' };

    const distAbs = dist.startsWith('/') ? dist : `${workspacePath}/${dist}`;
    const listenPort = (await getGuestFreePortCompat(runtimeRef)) || 0;
    if (!listenPort) return { ok: false, reason: '无法分配空闲端口' };

    // previewProxyServer 静态模式位置参数：<distDir> <listenPort> <backendPort> <spaFallback> <base>
    // /api 与 /ws 由内置 isBackendApiPath 命中 → 转发 backendPort（即 mock）。
    try {
        const fsMod = require('fs');
        const pathMod = require('path');
        const script = fsMod.readFileSync(pathMod.join(__dirname, '../preview/previewProxyServer.js'), 'utf8');
        await runtime.fs.fsWrite(workspacePath, '.agents/previewProxyServer.cjs', script, { runtimeRef });
        await runtime.exec.spawn('node',
            ['.agents/previewProxyServer.cjs', distAbs, String(listenPort), String(mockPort || 0), '1', base || ''],
            { HOME: process.env.HOME || '/root', PATH: process.env.PATH || '/usr/bin:/bin' },
            { runtimeRef, cwd: workspacePath });
    } catch (e) {
        return { ok: false, reason: `静态服务启动失败：${e.message}` };
    }
    // 就绪探测：/ 返回 2xx/3xx 即成功（静态服务器应答快，给 15s 余量）。
    for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 800));
        try {
            const chk = await runtime.exec.exec('sh', ['-c',
                `curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:${listenPort}/`],
                {}, { runtimeRef, cwd: workspacePath, timeoutMs: 8000 });
            const code = String(chk.stdout || '').trim();
            if (/^[23]\d\d$/.test(code)) {
                onLog(`static preview ready on :${listenPort} (dist=${dist})`);
                return { ok: true, port: listenPort, dist };
            }
        } catch { /* retry */ }
    }
    return { ok: false, reason: `静态服务 :${listenPort} 15s 未就绪` };
}

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

async function healDevRecipe({ ref, hostPath, detected, logTail, previousRecipe, metering }) {
    if (!llm.isConfigured()) return null;
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
    let content = '';
    try {
        // 0043：经 analyzeClient 统一入口，消耗以 source='internal' 计量归属；
        // 端点归一化（base/完整 URL）由 client 处理。
        const data = await llm.chatRaw({
            metering,
            options: { maxTokens: 1500, temperature: 0.1, timeoutMs: 90000 },
            messages: [
                { role: 'system', content: 'Output raw JSON only.' },
                { role: 'user', content: HEAL_PROMPT + logTail.slice(0, 1500) + `\n\nAvailable package.json scripts (ONLY reference these; do NOT invent script names):\n${scriptsHint}\n\nprevious command: ${previousRecipe ? previousRecipe.cmd : '(platform default ' + (detected.devKind || 'npm') + ' dev in ' + (detected.devDir || '.') + ')'}` },
            ],
        });
        content = String(data?.choices?.[0]?.message?.content || '');
    } catch (e) {
        quickLog(`heal LLM call failed: ${e.message?.slice(0, 100)}`);
        return null;
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
- ARRAY vs PAGINATED OBJECT — get this wrong and the app crashes with "X.filter is not a function" / "X.map is not a function" and the page goes blank. Two authoritative signals, use BOTH:
  * Backend type annotation: "response_model=List[X]" (FastAPI) or a return of "List[X]" / "X[]" means the response body is a BARE ARRAY — return the array itself, NOT {items:[...]}, NOT {data:[...]}, NOT {list:[...]}. Only when the annotation is a paginated wrapper ("response_model=Page[X]" / "PaginatedList[X]" / a model with items+total) return an object like {items:[...], total, page, perPage}.
  * Frontend call site: the section "FRONTEND EXPECTS BARE ARRAY" lists endpoints whose TypeScript type is X[] (e.g. request<MyOrganizationItem[]>('/users/me/organizations')). EVERY endpoint listed there MUST return a bare array at the top level. This signal beats your own guess about what looks idiomatic.
  * Never apply a paginated {items,total} envelope to an endpoint that either signal marks as a bare array. When the two signals disagree, the frontend type wins (it is what actually crashes).
- ITEM SHAPE / NESTING — a wrong item shape also blanks the page (e.g. "Cannot read properties of undefined (reading 'is_personal')"). The frontend destructures nested fields literally, so:
  * If the backend response model WRAPS a nested object, your mock item MUST keep that nesting. Example: "response_model=List[MyOrganization]" where "class MyOrganization { organization: OrganizationPublic; role: OrgRole }" means each item is {organization: {id,name,display_name,...}, role} — NOT the inner object's fields flattened. The frontend does o.organization.is_personal, so a flat item crashes.
  * The section "FRONTEND TS INTERFACES" is the authoritative field list the browser reads. Match its top-level keys AND its nesting exactly (optional "?" fields may be omitted; everything else must be present).
  * NEVER reuse one shape helper across endpoints whose response models differ. Similar-looking paths often return different shapes: /v2/organizations returns List[OrganizationPublic] (flat org) while /v2/users/me/organizations returns List[MyOrganization] (nested {organization, role}). Same noun, different shape — build separate item factories.
- Auth/login/register endpoints: return plausible tokens (e.g. 'mock-jwt-header.payload.sig') + a user object, at top level if the handler does.
- Data must be REALISTIC and DETERMINISTIC (seeded pseudo-random; stable across restarts):
  * list endpoints: 8 plausible items with plausible field values (names, emails, dates in the past, booleans, statuses seen in the models)
  * detail endpoints (/:id): return the first list item
  * POST/PUT/PATCH: echo request body merged with an id, wrapped the same way the handler wraps it
  * DELETE: same success shape the handler returns
- Route params: extract from path segments (e.g. /api/users/42 -> id="42") and match loosely.
- PREFIX MATTERS: the browser calls the paths listed under "FRONTEND API PATHS" verbatim (e.g. /v2/users/me, /v2/models). Match those EXACT prefixes in your patterns — do NOT rewrite them to /api/* and do NOT drop the version prefix. Backend route registrations may show bare relative paths (e.g. @router.get("") with prefix="/api-keys") because the version prefix is applied at mount time; the FRONTEND API PATHS section is the authoritative browser-facing surface.
- Cover EVERY route you can see. Unknown routes -> null (server falls back).

Routes, handler returns, and models (verbatim excerpts):
`;

async function generateMockFactory({ workspacePath, hostWorkspacePath, runtimeRef, metering }) {
    const runtime = getRuntime();
    // 收集路由/模型摘要（guest 侧）。两级来源：
    //   1) grep 路由注册行（Express/Koa router.get / NestJS @Get 装饰器 / Flask @app.route）
    //   2) 全部失败时 fallback：目录树（2 层）+ 所有 package.json scripts + 后端入口文件头
    //      ——LLM 从「这个项目有什么结构」推断接口面，弱于真路由但远好于放弃
    // 排除目录统一清单（grep --exclude-dir / find -path 共用）：node_modules 之外还必须排
    // Python 虚拟环境与站点包——backend/.venv/lib/python3.11/site-packages/fastapi/applications.py
    // 里全是 FastAPI 自带的教程样例（@app.get("/items/")、/items/{item_id}），60 行配额被它
    // 占满后真路由（backend/gpustack 下 292 处）一条都进不了 prompt → 工厂照着教程样例造出
    // /items、/login、/uploadfile 这种与项目无关的 mock（实测 gpustack 预览工厂全错根因）。
    const GREP_EXCLUDES = `--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage ` +
        `--exclude-dir=.venv --exclude-dir=venv --exclude-dir=env --exclude-dir=site-packages --exclude-dir=__pycache__ --exclude-dir=.tox --exclude-dir=.mypy_cache --exclude-dir=.pytest_cache`;
    const FIND_EXCLUDES = `-not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.venv/*' -not -path '*/venv/*' -not -path '*/site-packages/*' -not -path '*/__pycache__/*'`;
    const GREP_CMD =
        // 前端实际调用的 API 路径（最有效的"真实 API 面"）：前后端分离项目里，后端路由
        // 常写成 @router.get("") + 挂载时给 prefix（gpustack：app.include_router(api_router)
        // 且前端一律调 /v2/*、/v1/*），注册行里根本没有 /v2 字样 → 工厂照着注册行造不出
        // /v2/* 的 mock，前端请求全落到兜底 {data:null}（实测）。前端字面量是权威来源。
        // 放在最前：前端信号是"实际会崩的那一侧"，必须优先于冗长的后端路由行（末尾截断会丢）。
        `echo '--- FRONTEND API PATHS (what the browser actually calls) ---'; ` +
        `for d in web/src frontend/src client/src app/src src; do [ -d "$d" ] || continue; ` +
        `grep -rhoE "/v[0-9]+/[a-zA-Z0-9_-]+(/[a-zA-Z0-9_{}.-]+)*|/api/[a-zA-Z0-9_-]+(/[a-zA-Z0-9_{}.-]+)*|/console/api/[a-zA-Z0-9_-]+" ` +
        `--include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' "$d" 2>/dev/null | sort -u | head -60; done; ` +
        // 前端期望裸数组的端点（最强信号）：`request<X[]>('/path')` 的 TS 类型就是运行时的
        // 解构方式——类型是数组而 mock 返回 {items:[...]} 时，前端 X.filter/map 直接抛
        // TypeError 白屏（实测 /v2/users/me/organizations：后端 response_model=List[X]、
        // 前端 request<MyOrganizationItem[]>，工厂却给了分页包络 → orgs.filter 崩）。
        `echo '--- FRONTEND EXPECTS BARE ARRAY (return the array itself, NOT {items:...}) ---'; ` +
        `for d in web/src frontend/src client/src app/src src; do [ -d "$d" ] || continue; ` +
        `grep -rnE "request<[A-Za-z_][A-Za-z0-9_]*\\[\\]>\\(" --include='*.ts' --include='*.tsx' "$d" 2>/dev/null | head -40; done; ` +
        // 前端 TS 接口定义（权威响应形态）：前端按这些字段名/嵌套层级解构，是"包络对不对"
        // 之外的第二道契约。实测 MyOrganizationItem { organization: {...}, role } 被工厂
        // 拍平成裸 org 对象 → 前端 o.organization.is_personal 抛 TypeError 白屏。
        // 只取 services/apis 目录（API 类型集中处），避免全量 src 噪声。
        `echo '--- FRONTEND TS INTERFACES (authoritative field names + nesting the browser reads) ---'; ` +
        `for d in web/src frontend/src client/src app/src src; do [ -d "$d" ] || continue; ` +
        `grep -rn -A14 "export interface [A-Za-z_]\\|export type [A-Za-z_][A-Za-z0-9_]* = " ` +
        `--include='*.ts' --include='*.tsx' "$d/services" "$d/apis" 2>/dev/null | head -300; done; ` +
        // 后端 response_model 指向的模型类定义（嵌套来源）：List[MyOrganization] 这类包装
        // 模型的字段（organization/role）决定了 item 的嵌套层级——只看路由行看不到，必须展开。
        // 先取路由里出现过的 response_model 类型名，再按名抓 class 定义（避免 dump 整个
        // schemas 目录：gpustack 的 schemas 有 100KB+，全量会挤爆上下文预算）。
        `echo '--- BACKEND RESPONSE MODELS (expanded class definitions) ---'; ` +
        `MODELS=$( ` +
        // 优先级 1：List[X] 的 item 模型——列表端点的元素形态，嵌套包装最常出现在这里
        // （MyOrganization { organization, role }），也是前端 .filter/.map 崩白屏的高发处。
        `{ grep -rhoE "response_model=List\\[[A-Za-z_][A-Za-z0-9_.]*\\]" --include='*.py' ${GREP_EXCLUDES} backend server src api 2>/dev/null | sed 's/.*List\\[//; s/\\]$//; s/.*\\.//'; ` +
        // 优先级 2：其余单对象 response_model
        `grep -rhoE "response_model=[A-Za-z_][A-Za-z0-9_.]*" --include='*.py' ${GREP_EXCLUDES} backend server src api 2>/dev/null | sed 's/response_model=//; s/.*\\.//'; } ` +
        // 保序去重：awk 按出现顺序去重，不打乱优先级
        `| awk '!seen[$0]++' | head -110); ` +
        `for m in $MODELS; do grep -rn -A10 "^class $m(" --include='*.py' ${GREP_EXCLUDES} backend server src api 2>/dev/null; done | head -500; ` +
        // handler 的 return/reply.send 语句：包络与字段名的权威（如裸 {access_token}）
        `echo '--- HANDLER RETURNS ---'; ` +
        // grep -A2：return { 往往跨行（access_token 单独一行）——只抓 return 行看不到字段名
        `for d in server/src src api backend server web/src frontend/src client/src; do [ -d "$d" ] || continue; ` +
        `grep -rnA2 -E "return \\{|reply\\.(code\\([0-9]+\\)\\.)?send\\(|res\\.(status\\([0-9]+\\)\\.)?json\\(" ` +
        `--include='*.js' --include='*.ts' ${GREP_EXCLUDES} "$d" 2>/dev/null; done ` +
        `| grep -v node_modules | grep -vE "^[^:]+:[0-9]+[-:]\\s*[*//]" | sort -u | head -120; ` +
        // 后端路由注册行（放在最后：最长、信息密度最低——前端路径已给出真实 API 面，它只是补充）
        `echo '--- ROUTES ---'; ` +
        `for d in server/src server/app src api backend web/src frontend/src client/src app/src server web frontend client app; do ` +
        `[ -d "$d" ] || continue; ` +
        `grep -rnE "(fastify|router|app|api)\\.(get|post|put|delete|patch|route)\\(|@(Get|Post|Put|Delete|Patch|Controller)\\(|@app\\.route|@(router|app|api_router)\\.(get|post|put|delete|patch)\\(" ` +
        `--include='*.js' --include='*.ts' --include='*.mjs' --include='*.py' --include='*.go' ` +
        `${GREP_EXCLUDES} "$d" 2>/dev/null; done ` +
        `| grep -v node_modules | grep -vE ":[0-9]+:\\s*[*//]" | sort -u | head -60; ` +
        `echo '--- ROUTER PREFIXES ---'; ` +
        `grep -rhoE 'prefix="/[^"]*"' --include='*.py' --include='*.js' --include='*.ts' ${GREP_EXCLUDES} backend server src api 2>/dev/null | sort -u | head -30; ` +
        // Next.js app router 的路由就是目录结构（page.tsx/route.ts）——没有注册行可
        // grep，补一段文件树让 LLM 从路径推出页面/API 面（multica 实测 route-grep
        // 真空、工厂失败的根因）。route.ts 是 API 端点，优先展示完整路径。
        `echo '--- NEXTJS ROUTES ---'; ` +
        `find apps/web/src/app apps/web/app src/app app app/src -maxdepth 5 \\( -name 'page.tsx' -o -name 'route.ts' -o -name 'page.ts' \\) ${FIND_EXCLUDES} 2>/dev/null | head -40; ` +
        `echo '--- MODELS ---'; ` +
        `find server/src src api backend server web/src -maxdepth 4 \\( -name 'schema.prisma' -o -name 'models.py' -o -name 'schema.sql' -o -path '*entities*.ts' \\) ${FIND_EXCLUDES} 2>/dev/null | head -5 | xargs -r head -c 6000`;
    const FALLBACK_CMD =
        `echo '--- TREE ---'; find . -maxdepth 2 -type d ${FIND_EXCLUDES} 2>/dev/null | head -30; ` +
        `echo '--- PKGS ---'; find . -maxdepth 2 -name package.json ${FIND_EXCLUDES} 2>/dev/null | head -6 | xargs -r grep -h '"\\(dev\\|start\\|scripts\\|main\\)"' 2>/dev/null | head -20; ` +
        `echo '--- ENTRY ---'; find . -maxdepth 3 \\( -name 'main.ts' -o -name 'main.js' -o -name 'index.ts' -o -name 'app.py' -o -name 'main.py' \\) ${FIND_EXCLUDES} 2>/dev/null | head -4 | xargs -r head -c 5000`;
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
    if (!llm.isConfigured()) {
        quickLog('no LLM config; skip mock factory');
        return false;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
        let content = '';
        try {
            // 调用姿势与 analyzeDeploy.callLlm 对齐：thinking disabled（glm 等推理
            // 模型不关 thinking 会把 max_tokens 烧在 reasoning 上 → content 为空——
            // 实测 19:26 两次 len=0 的根因）；finish_reason/usage 落日志可观测。
            // 0043：经 analyzeClient 统一入口，消耗以 source='internal' 计量归属。
            const model = llm.getLlmConfig().model;
            const data = await llm.chatRaw({
                metering,
                options: {
                    maxTokens: 16000,
                    temperature: 0.2,
                    timeoutMs: 120000,
                    disableThinking: !llm.noThinkingModels.has(model),
                },
                messages: [
                    { role: 'system', content: 'Output raw JavaScript only. No markdown, no explanation.' },
                    { role: 'user', content: MOCK_FACTORY_PROMPT + excerpts.slice(0, 65000) },
                ],
            });
            const choice = data?.choices?.[0];
            quickLog(`mock factory LLM finish_reason=${choice?.finish_reason} usage=${JSON.stringify(data?.usage || {}).slice(0, 120)}`);
            content = String(choice?.message?.content || '');
        } catch (e) {
            if (e instanceof llm.LlmRequestError && e.status) {
                const errBody = String(e.body || '').slice(0, 150);
                quickLog(`mock factory LLM http ${e.status} (attempt ${attempt}): ${errBody}`);
            } else {
                quickLog(`mock factory LLM call failed (attempt ${attempt}): ${e.message?.slice(0, 120)}`);
            }
            continue;
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

// 产物可用性探测：缓存标志位存在宿主 DB（deploy_verify_states），产物存在沙箱文件系统，
// 两者生命周期不一致——沙箱重建会丢产物而标志位仍在（TTL 30min，见 twoStage
// VERIFY_STATE_TTL_MS）。跳过生成前必须先验证产物真实存在且可加载，否则工厂静默缺失、
// mock 退化成 {data:null}，登录等硬前置接口直接卡死且长时间不自愈。
async function probeFactoryArtifact({ runtimeRef, workspacePath }) {
    const runtime = getRuntime();
    const GEN = '.xensemble/mocks/_generated.cjs';
    const chk = await runtime.exec.exec('sh', ['-c',
        `[ -f ${GEN} ] && node -e "const m=require('./${GEN}'); if(typeof m.handle!=='function')process.exit(3)" && echo FACTORY_OK`],
        {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 }).catch(() => null);
    return /FACTORY_OK/.test(String(chk?.stdout || ''));
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

// 从前端 TS 调用点提取"期望裸数组"的端点路径（request<X[]>('/path')）。
// 返回去掉前导 /、剔除模板变量的路径段（如 users/me/organizations、menus/mine）。
// 用途：mock server 兜底按后缀匹配返回 []，避免前端 .filter/.map 拿到对象崩白屏。
async function extractArrayPaths({ runtimeRef, workspacePath }) {
    const runtime = getRuntime();
    const cmd = `for d in web/src frontend/src client/src app/src src; do [ -d "$d" ] || continue; ` +
        `grep -rhoE "request<[A-Za-z_][A-Za-z0-9_]*\\[\\]>\\('[^']+'|request<[A-Za-z_][A-Za-z0-9_]*\\[\\]>\\(\\\`[^\\\`]+\\\`" ` +
        `--include='*.ts' --include='*.tsx' "$d" 2>/dev/null; done`;
    let out = '';
    try {
        const r = await runtime.exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 });
        out = String(r.stdout || '');
    } catch { return []; }
    const paths = new Set();
    for (const m of out.matchAll(/['"`](\/[^'"`]*)['"`]/g)) {
        const raw = m[1];
        // 含模板变量（${userId}）的路径无法按字面匹配，跳过
        if (raw.includes('${') || raw.includes('{')) continue;
        const norm = raw.replace(/^\/+/, '').replace(/\/+$/, '');
        if (norm) paths.add(norm);
    }
    return [...paths].slice(0, 60);
}

// mock server：写进沙箱 spawn（长命通道）。逻辑极简：
//   GET/POST/PUT/DELETE/PATCH 任意 /api/* → 查 .xensemble/mocks/<METHOD>__<path>.json
//   命中返回文件内容；未命中但有 endpoint 种子 → 返回 { data: null, mock: true, path }
//   404 兜底 → { mock: true, error: 'no mock for <path>' }（仍 200，前端不炸）
async function startMockServer({ runtimeRef, workspacePath, port, endpoints, arrayPaths }) {
    const runtime = getRuntime();
    const script = QUICK_MOCK_SERVER_SCRIPT.replace('__PORT__', String(port))
        .replace('__ENDPOINTS__', JSON.stringify(endpoints || []))
        .replace('__ARRAY_PATHS__', JSON.stringify(arrayPaths || []));
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
// 前端 TS 类型为 X[] 的端点路径段（如 users/me/organizations）。未命中工厂时按后缀匹配
// 返回裸数组 []——前端对这类端点做 .filter/.map，返回对象会直接抛 TypeError 白屏。
const ARRAY_PATHS = __ARRAY_PATHS__;
// 段对齐的后缀匹配：请求 v2/users/me/organizations 命中 users/me/organizations。
function expectsArray(cleanPath) {
    if (!cleanPath) return false;
    const req = cleanPath.split('/');
    for (const ap of ARRAY_PATHS) {
        const seg = String(ap).split('/').filter(Boolean);
        if (!seg.length || seg.length > req.length) continue;
        let ok = true;
        for (let i = 0; i < seg.length; i++) {
            if (req[req.length - seg.length + i] !== seg[i]) { ok = false; break; }
        }
        if (ok) return true;
    }
    return false;
}
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
            // 工厂未覆盖：前端 TS 类型声明为 X[] 的端点先于其它兜底返回 []（见 expectsArray）。
            if (expectsArray(cleanPath)) return send(200, []);
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
    // 前端声明为 X[] 的端点优先返回 []（无工厂时更常见，是白屏高发路径）。
    if (expectsArray(cleanPath)) return send(200, []);
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
            send({ type: 'result', result: localizeDeployError({ ok: !!result?.ok, ...result }, request.locale) });
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
