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
const { eq, and, inArray, desc } = require('drizzle-orm');
const { getRuntime } = require('../runtime/registry');
const { ensureProjectRuntime } = require('../runtime/RuntimeService');
const { analyzeProjectDeploy, collectProjectContext } = require('./analyzeDeploy');
const { analyzeProjectVerify } = require('./analyzeVerify');
const { createTunnel, stopTunnel } = require('../preview/tunnelServer');
const { signBlinkToken } = require('../preview/blinkToken');
const { resolveControlPlanePublicUrlSync } = require('../llm/publicUrl');
const { DEPENDENCY_EXCLUDE_SCRIPT } = require('../git/dependencyExclude');
const deploymentService = require('./DeploymentService');
const workspace = require('../workspace');
const { registerDeploy, peekDeploy, unregisterDeploy, isAborted, countByUser, listProjectIdsByUser, listByUser, deployKey } = require('./activeDeploys');
const { ensureUserQuota, getUsage } = require('../auth/PolicyService');
const dbAdapt = require('./dbAdapt');
const { broadcastSse } = require('../session/sseManager');
const { db } = require('../db');
const schema = require('../db/schema');

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const VERIFY_STATE_TTL_MS = 30 * 60 * 1000;
// 单次部署（阶段 1 分析 + 阶段 2 验证）整体超时：verify agent 可能因 run_shell 启动服务未正确
// 后台化（缺少 &/nohup）而挂起，必须有总超时自动中止，否则部署永不结束、前端一直显示 running。
const DEPLOY_TOTAL_TIMEOUT_MS = Number(process.env.DEPLOY_TOTAL_TIMEOUT_MS) || 60 * 60 * 1000;
// 缓存版本：verify 判定逻辑每次升级（如 "ok" 页面拒绝、backend_listening 兜底）时 +1。
// 旧版本缓存自动作废——判定标准变了，旧标准盖的"成功"章不可信，重新生成。
const CACHE_VERSION = 2;

// apt/dpkg 防卡死统一参数（实测 verify agent 现场 apt-get 装 postgres 卡住 → 60 轮耗尽）：
//  - DPkg::Lock::Timeout：dpkg 锁等待有界（默认无限等），避免与残留 apt 进程互卡
//  - Acquire::Retries / Acquire::http::Timeout：网络重试/下载超时有界
// 清理残留锁：仅当"无活跃 apt/dpkg 进程"时才删锁文件（清理上次被中断留下的僵尸锁）。
// 绝不 pkill 活跃的 apt-get/dpkg——工具链预装与 DB 预配是并行的，两个 aptSafeInstall
// 同时跑时 pkill 会杀掉对端的 apt-get/dpkg，造成 dpkg 中断 + 反复重试/互杀（真卡死）。
const APT_SAFE_FLAGS = '-o DPkg::Lock::Timeout=300 -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::ftp::Timeout=30';
const APT_CLEAR_LOCKS = 'if ! pgrep -x apt-get >/dev/null 2>&1 && ! pgrep -x dpkg >/dev/null 2>&1; then rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null; fi; true';

// 进程内 apt 串行闸门：apt/dpkg 是**全局单例**（/var/lib/apt/lists 与 dpkg 锁）。
// 并行调用（工具链预装 ensureGuestToolchains + DB 预配 provisionDbServices/Postgres，都跑在
// Promise.allSettled 里）会互相抢 lists 锁：抢输的一方 `apt-get update` 失败被 `|| true` 吞掉，
// 随后 `apt-get install` 用未更新的空索引 → `E: Unable to locate package`（实测
// mariadb-server exit=100 → mysql=down → 后端起不来）。串行化所有 aptSafeInstall，
// 保证每次 update+install 原子完成。通用（与具体包/DB 无关）。
let _aptChain = Promise.resolve();
function _withAptLock(fn) {
    const prev = _aptChain;
    let release;
    _aptChain = new Promise((r) => { release = r; });
    return prev.then(fn, fn).finally(release);
}

/**
 * 防卡死的 apt 安装（通用系统依赖安装入口，postgres/mysql/build-essential 等共用）。
 * 先清锁，再带超时/重试参数安装；返回是否成功与日志尾部，供调用方判断/记录。
 * 通过 _withAptLock 串行化，避免并行 apt 抢 lists 锁导致 "Unable to locate package"。
 */
function aptSafeInstall(args) {
    return _withAptLock(() => _aptSafeInstallInner(args));
}

async function _aptSafeInstallInner({ runtime, runtimeRef, workspacePath, packages, onLog, timeoutMs = 420000 }) {
    const log = (m) => { if (onLog) onLog(m); };
    try {
        await runtime.exec.exec('sh', ['-c', `${APT_CLEAR_LOCKS}`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 }).catch(() => {});
        const t = Math.floor(timeoutMs / 1000);
        const updateT = Math.min(120, t); // update 独立短超时，避免镜像源卡住拖死 install
        // 与 install 同一条命令串行执行（同一沙箱内不与其它 apt 并发），避免并发
        // clean/install 的锁竞争与误删已下载的 .deb。预检：根盘可用 < 400MB 时先回收
        // 纯缓存（apt deb 缓存 / npm cache / /tmp）再装，降低 ENOSPC 概率；best-effort，
        // 清理失败不阻断。安装完成后 apt-get clean 释放下载缓存，防止大包（postgresql
        // 等）缓存累积占满根盘（沙箱默认根盘偏小，xensemble 实测 2G 根盘被占满后任何
        // apt 安装都 ENOSPC）。
        // 退出码必须取 apt-get 自身的（重定向到文件 + 单独捕获），不能用管道尾命令的
        // 退出码——`apt-get ... | tail` 的 $? 是 tail 的（恒 0），会把 apt 失败（含
        // timeout 124 被杀）掩盖成成功（xensemble 实测：PG 安装 ENOSPC 被误记 ok）。
        const cmd = `export DEBIAN_FRONTEND=noninteractive; `
            + `avail=$(df -k / | awk 'NR==2{print $4}'); `
            + `if [ "$avail" -lt 409600 ]; then apt-get clean 2>/dev/null || true; rm -rf /root/.npm/_cacache 2>/dev/null || true; rm -rf /root/.cache 2>/dev/null || true; find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true; fi; `
            + `(timeout ${updateT} apt-get update -qq ${APT_SAFE_FLAGS} >/dev/null 2>&1 || true); `
            + `timeout ${t} apt-get install -y -qq ${APT_SAFE_FLAGS} ${packages} > /tmp/_aptSafeInstall.log 2>&1; ec=$?; `
            + `tail -20 /tmp/_aptSafeInstall.log; rm -f /tmp/_aptSafeInstall.log; `
            + `apt-get clean 2>/dev/null || true; `
            // 注意 ${ec} 必须转义为 \${ec}：这是 shell 变量（ec=$? 的结果），不能让 JS
            // 模板字符串在此处插值——ec 的 const 声明在下方，插值会抛 TDZ
            // ReferenceError（"Cannot access 'ec' before initialization"），apt 安装
            // 直接崩（全新沙箱预配 postgres 必走此路径，实测连续部署失败）。
            + `echo "__APT_EXIT__=\${ec}"`;
        const r = await runtime.exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: timeoutMs + 30000 });
        const out = String(r.stdout || '');
        const m = out.match(/__APT_EXIT__=(-?\d+)/);
        const ec = m ? Number(m[1]) : null;
        const ok = ec === 0;
        log(`apt install ${packages}: ${ok ? 'ok' : `FAILED (exit=${ec})`} ${out.replace(/__APT_EXIT__=-?\d+/, '').trim().slice(-400)}`);
        return { ok, exitCode: ec, logTail: out.slice(-600) };
    } catch (e) {
        log(`apt install ${packages} error (non-fatal): ${e.message?.slice(0, 200)}`);
        return { ok: false, exitCode: null, logTail: String(e.message || '').slice(0, 400) };
    }
}

// 安装失败归因：从 apt/dpkg 输出里识别可操作的失败类别（与具体依赖无关，通用）。
// 供 provisionPostgresIfNeeded 失败时返回结构化 code/reason，并透传到部署记录与
// verify prompt——让"系统依赖预配失败"以真实原因呈现，而不是笼统的"阶段 2 失败"。
function classifyAptFailure(logTail) {
    const t = String(logTail || '');
    if (/No space left on device|ENOSPC/i.test(t)) return { code: 'ENOSPC', reason: '沙箱根盘空间不足（No space left on device）' };
    if (/dpkg was interrupted/i.test(t)) return { code: 'dpkg_broken', reason: 'dpkg 状态损坏（dpkg was interrupted）' };
    if (/Unable to fetch|Could not resolve|Connection timed out|Failed to connect|Temporary failure resolving/i.test(t)) return { code: 'network', reason: '镜像源网络失败' };
    if (/dpkg-deb|Corrupt|Hash Sum mismatch|Method gave invalid/i.test(t)) return { code: 'dpkg_error', reason: '包解压/完整性错误' };
    return { code: 'apt_error', reason: 'apt-get install 失败' };
}

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
async function buildConcurrencyOccupants(userId, getProjectForUser, exclude) {
    // exclude: { projectId, sessionId }——当前请求自己（quota 路径 self 已注册+插记录，
    // 把"自己"列为占用者会误导"我只开了一个部署却显示 2 个"）。
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
        // DB 记录是唯一可信来源（真实 sessionId/kind/status）。此前还遍历 activeDeploys
        // 注册表，但其键只含 projectId——session 信息丢失（恒显示"未命名会话"）且必然
        // 与 DB 记录重复，同一部署被列两次；已移除该来源。
        const rows = await db.select({
            projectId: schema.deployments.projectId,
            sessionId: schema.deployments.sessionId,
            kind: schema.deployments.kind,
            status: schema.deployments.status,
        }).from(schema.deployments)
            .where(and(
                eq(schema.deployments.userId, userId),
                inArray(schema.deployments.status, ['running', 'building', 'pending']),
            ));
        for (const r of rows) {
            const key = `${r.kind}:${r.projectId}:${r.sessionId || ''}`;
            if (seen.has(key)) continue;
            // 排除"自己"：当前请求的 deploy 记录（quota 路径 self 已插入 building 记录）。
            // deploy_in_progress 路径 self 无记录，此条件天然不命中。
            const isSelf = exclude
                && r.kind === 'deploy'
                && r.projectId === exclude.projectId
                && (r.sessionId || null) === (exclude.sessionId || null);
            if (isSelf) continue;
            // building/pending 必须有活跃注册表条目（activeDeploys）才算真实占用——孤儿记录
            // （进程被杀后 status 停在 building）会虚增占用列表，误导用户"有多个部署在跑"。
            if ((r.status === 'building' || r.status === 'pending') && !peekDeploy(r.projectId, r.sessionId)) continue;
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
// serve/启动类命令单独把关：`nohup ... &` 永远 exit=0，exit 码无法证明服务真的活着。
// 这类命令仅当本次 verify 的 API 探测确认后端可用（apiVerdict alive/backend_listening），
// 或项目确无后端（纯静态站，根路径探测已足够）时才允许进入缓存——否则"前端 200
// 后端死"的坏启动姿势会作为成功轨迹被后续部署的缓存无限继承（deepseek-harness 事故）。
// 判定正则宁宽勿漏：误过滤的代价只是下次 verify 多执行一条命令，漏过滤的代价是坏姿势固化。
const SERVE_CMD_RE = new RegExp([
    '\\bnohup\\b',
    '\\bsetsid\\b',
    '(?:^|\\s)&\\s*$',          // 以 & 后台化结尾（排除 a && b 的 &&）
    '\\b(?:npm|pnpm)\\s+(?:run\\s+)?(?:start|dev|serve)\\b',
    '\\byarn\\s+(?:start|dev|serve)\\b',
    '\\bnpx\\s+(?:--yes\\s+)?serve\\b',
    '\\bvite\\b',
    '\\bnext\\s+(?:start|dev)\\b',
    '\\bng\\s+serve\\b',
    '\\buvicorn\\b',
    '\\bgunicorn\\b',
    '\\bflask\\s+run\\b',
    '\\brunserver\\b',
    '\\bgo\\s+run\\b',
    '\\bcargo\\s+run\\b',
    '\\bjava\\s+-jar\\b',
    '\\bdotnet\\s+run\\b',
    '\\bnode\\s+\\S*(?:server|app|main|index)\\.(?:js|mjs|cjs|ts)\\b',
    '\\bpython3?\\s+\\S*(?:app|main|server|wsgi|asgi)\\.py\\b',
    '\\bartisan\\s+serve\\b',
].join('|'), 'i');

function extractSuccessCommands(trail, allowServeCommands = true) {
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
        if (!allowServeCommands && SERVE_CMD_RE.test(cmd)) continue;
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
        // 版本化：判定逻辑升级（CACHE_VERSION 递增）后续修点作废——旧续修点的"成功步骤"
        // 与 agent 认知基于旧判定标准，接回来会误导新一轮修复。
        if (Number(row.plan?.cacheVersion || 0) !== CACHE_VERSION) {
            console.error(`[twoStage] verify state stale (cacheVersion ${row.plan?.cacheVersion || 0} != ${CACHE_VERSION}), 续修点作废`);
            return null;
        }
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
        plan: JSON.parse(JSON.stringify({ ...(state.plan || {}), cacheVersion: CACHE_VERSION })),
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
        // 缓存版本化：判定逻辑升级（CACHE_VERSION 递增）后，旧版本缓存自动作废——
        // 旧标准验证通过的"成功"（如 "ok" 页面部署）在新标准下可能不合格。
        if (Number(plan.context?.cacheVersion || 0) !== CACHE_VERSION) {
            console.error(`[twoStage] plan cache stale (cacheVersion ${plan.context?.cacheVersion || 0} != ${CACHE_VERSION}, 判定逻辑已升级), re-analyzing`);
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
                context: { ...(plan.context || {}), cacheVersion: CACHE_VERSION },
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
            // umi（@umijs/max）排除：其 dev 工具链（MFSU/module federation）用绝对路径
            // 引用模块，在 /preview/<id>/ 子路径代理下 remoteEntry 404 → live 白屏。
            // umi 走 build + 静态 serve（生产模式），不做 live。
            if (deps['@umijs/max'] || deps.umi) continue;
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
    // umi（@umijs/max）的 dev 工具链（MFSU/module federation）用绝对路径引用模块，
    // 在 /preview/<id>/ 子路径代理下 remoteEntry 404 → live 预览白屏 → umi 走 build +
    // 静态 serve（frontend/dist 或根 dist 由 ensureFrontendServed 探测）。
    if (devKind === 'umi' || devKind === '@umijs/max') devKind = null;
    if (stack.type === 'monorepo' || !devKind) {
        const sub = detectSubDev();
        if (sub) { devKind = sub.devKind; devDir = sub.dir; }
        // 子目录检出 umi 也不走 live（monorepo 里前端是 umi 的场景）
        if (devKind === 'umi' || devKind === '@umijs/max') devKind = null;
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

function setprivPrefix(uid, gid) {
    return `setpriv --reuid=${uid} --regid=${gid} --clear-groups `;
}

// devDir 可能是 './web' 之类的相对路径（相对 /workspace）——归一为 guest 内绝对路径。
function workspaceAbsPath(targetDir) {
    const t = String(targetDir || '.').trim();
    if (t.startsWith('/')) return t.replace(/\/+$/, '') || '/';
    return '/workspace' + (t === '.' || t === '' ? '' : `/${t.replace(/^\.\//, '').replace(/\/+$/, '')}`);
}

// vite 沙箱内的身份/写权限适配（preview 白屏修复）：
// 沙箱里源码树（git clone，root）与 node_modules（npm install，agent uid）常常属主不同，
// 而 workspace 是 virtiofs idmapped 挂载——root 没有 DAC override，任何单一身份都有一半
// 目录不可写：root 写得了 vite.config.js 加载临时文件（bundle 落在 config 同目录）但写不了
// node_modules/.vite（依赖预构建产物），agent uid 反之。结果是 vite re-optimize 一直
// EACCES，deps 请求全部 504（Outdated Optimize Dep），preview 白屏。
// 解法：以 node_modules 属主身份跑 vite；ESM config（type:module / .mjs）额外生成"桥接
// config"——把 __dirname/__filename 静态替换为 devDir 绝对路径后落到 node_modules 内，
// --config 指向它（这样 bundle 临时文件也写在 node_modules，属主可写）。CJS config 由
// vite 直接 require、无临时文件，降权即可。属主为 root/当前身份时零开销直跑；setpriv
// 缺失或任何一步失败都回退原命令，行为不劣化。返回 { prefix, configArg }。
async function prepareVitePrivilegedRun({ runtimeRef, targetDir, onLog }) {
    const runtime = getRuntime();
    const dirAbs = workspaceAbsPath(targetDir);
    const nmAbs = `${dirAbs}/node_modules`;
    try {
        const id = await runtime.exec.exec('sh', [
            '-c', 'id -u; stat -c "%u:%g" "$1/node_modules" 2>/dev/null || echo -; command -v setpriv || echo -', 'sh', nmAbs,
        ], {}, { runtimeRef, cwd: '/workspace', timeoutMs: 10000 });
        const lines = String(id.stdout || '').trim().split('\n');
        const curUid = parseInt(lines[0], 10) || 0;
        const owner = (lines[1] || '-').trim();
        const setprivPath = (lines[2] || '-').trim();
        if (!/^\d+:\d+$/.test(owner) || setprivPath === '-') {
            return { prefix: '', configArg: '' };
        }
        const [ownerUid, ownerGid] = owner.split(':');
        if (ownerUid === '0' || Number(ownerUid) === curUid) {
            return { prefix: '', configArg: '' };
        }
        const prefix = setprivPrefix(ownerUid, ownerGid);
        // 找 config；CJS（.js 且包非 type:module）无 bundle 临时文件，无需 bridge
        const ls = await runtime.exec.exec('sh', [
            '-c', 'ls "$1"/vite.config.* 2>/dev/null | head -1; grep -o \'"type": *"module"\' "$1"/package.json 2>/dev/null | head -1', 'sh', dirAbs,
        ], {}, { runtimeRef, cwd: '/workspace', timeoutMs: 10000 });
        const lsLines = String(ls.stdout || '').trim().split('\n');
        const configPath = (lsLines[0] || '').trim();
        const pkgTypeModule = Boolean((lsLines[1] || '').trim());
        if (!configPath || (!configPath.endsWith('.mjs') && !pkgTypeModule)) {
            return { prefix, configArg: '' };
        }
        const cat = await runtime.exec.exec('sh', ['-c', 'cat "$1"', 'sh', configPath], {}, { runtimeRef, cwd: '/workspace', timeoutMs: 10000 });
        const orig = String(cat.stdout || '');
        if (!orig || !/defineConfig|export default|module\.exports/.test(orig)) {
            return { prefix, configArg: '' };
        }
        const patched = orig
            .replace(/__dirname/g, JSON.stringify(dirAbs))
            .replace(/__filename/g, JSON.stringify(configPath));
        const b64 = Buffer.from(patched, 'utf8').toString('base64');
        const bridgePath = `${nmAbs}/.vite-xe-config.mjs`;
        // 文件必须以属主身份落盘（重定向发生在降权 shell 内，root 在 idmapped 挂载上
        // 对属主目录没有写权限），因此 setpriv + 内层 sh 完成写入。
        const cp = await runtime.exec.exec('sh', [
            '-c',
            'setpriv --reuid="$1" --regid="$2" --clear-groups sh -c \'printf %s "$1" | base64 -d > "$2" && echo BRIDGE_OK\' xe "$3" "$4"',
            'sh', ownerUid, ownerGid, b64, bridgePath,
        ], {}, { runtimeRef, cwd: '/workspace', timeoutMs: 10000 });
        if (!String(cp.stdout || '').includes('BRIDGE_OK')) {
            if (onLog) onLog(`vite bridge config write failed: ${String(cp.stdout || cp.stderr || '').slice(0, 200)}`);
            return { prefix, configArg: '' };
        }
        return { prefix, configArg: ` --config ${bridgePath}` };
    } catch (e) {
        if (onLog) onLog(`vite privileged-run detection failed, fallback: ${e.message}`);
        return { prefix: '', configArg: '' };
    }
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
    // node_modules 可写兜底（所有 dev server 通用）：workspace 是 virtiofs idmapped 挂载，
    // 当 node_modules 属主与运行用户分裂（如 node_modules 宿主属主 root ↔ guest 视角 1000，
    // 而 dev server 以 guest root 跑）时，root 对宿主 root 拥有的 755 node_modules 无写权限，
    // vite 依赖预构建（node_modules/.vite）、webpack 缓存（node_modules/.cache）等会 EACCES
    // → dev 资源 504/白屏。启动前给 node_modules 目录加写位：幂等、只改目录权限位、不遍历
    // 子目录；即使 prepareVitePrivilegedRun 降权未生效（setpriv 缺失/检测回退），也能保证可写。
    const nmAbs = workspaceAbsPath(targetDir) + '/node_modules';
    const ensureNmWritable = `chmod u+w,g+w,o+w ${nmAbs} 2>/dev/null; `;
    let startCmd;
    if (devKind === 'vite') {
        // 沙箱身份/写权限适配：源码树与 node_modules 属主不同时以 node_modules 属主跑
        // vite（见 prepareVitePrivilegedRun 注释）；失败回退 root 原命令。
        let vitePrefix = '';
        let viteConfigArg = '';
        try {
            const priv = await prepareVitePrivilegedRun({ runtimeRef, targetDir, onLog });
            vitePrefix = priv.prefix;
            viteConfigArg = priv.configArg;
        } catch { /* fallback below */ }
        startCmd = `cd ${targetDir} && ${ensureNmWritable}${vitePrefix}env HOME=/tmp ${apiBaseArg} npx vite${viteConfigArg} --host 0.0.0.0 --port ${livePort} --strictPort${baseArg}`;
    } else if (devKind === 'next') {
        startCmd = `cd ${targetDir} && ${ensureNmWritable}PORT=${livePort} npx next dev -H 0.0.0.0 -p ${livePort}`;
    } else if (devKind === 'nuxt') {
        startCmd = `cd ${targetDir} && ${ensureNmWritable}PORT=${livePort} HOST=0.0.0.0 npx nuxt dev --port ${livePort}`;
    } else {
        startCmd = `cd ${targetDir} && ${ensureNmWritable}PORT=${livePort} BROWSER=none npm run dev`;
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
    // —— 主动预热（辅助措施，失败绝不阻塞主流程）——
    // vite dev server 的 warm-up（esbuild 依赖预构建 + 按需转换）只在"首次完整请求"
    // 时才触发：根路径 / 会 302 到 --base 路径，上方就绪轮询拿到 302 即退，反而绕过
    // 了 warm-up（首个真正请求要现场预构建，大应用单次 20s+、多轮 re-optimization
    // 达数分钟，xensemble 实测 21:01-21:05 期间每次 21-23s）。这里用 -L 跟随到 base
    // 路径 + 长超时，把预构建成本在部署期消化——结果缓存进 node_modules/.vite，
    // 此后用户打开预览、探测访问都直接命中 warm 缓存。
    // 失败容忍：curl 可能失败（连接瞬断/超时/非 2xx），预热只是辅助——失败只打日志
    // 继续（vite 仍会在后台完成预构建，probeApiHealth 的 000 重试与用户访问自动兜底），
    // 绝不让预热失败拖垮部署主流程。
    if (devKind === 'vite') {
        try {
            const warmTarget = base ? `${base}` : '/';
            const warm = await runtime.exec.exec(
                'sh', ['-c', `curl -sL -m 180 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${livePort}${warmTarget}"`],
                {}, { runtimeRef, cwd: workspacePath, timeoutMs: 190000 },
            );
            const warmCode = String(warm.stdout || '').trim();
            if (/^2\d\d$/.test(warmCode)) {
                if (onLog) onLog(`dev server pre-warmed on :${livePort} (http ${warmCode}, dep pre-bundle cached)`);
            } else {
                if (onLog) onLog(`dev server warm-up got http ${warmCode || '000'} (non-fatal, background pre-bundle continues)`);
            }
        } catch (e) {
            if (onLog) onLog(`dev server warm-up failed (non-fatal): ${String(e.message || e).slice(0, 120)}`);
        }
    }
    if (onLog) onLog(`live dev server ready on :${livePort} (${devKind})`);
    return { ok: true, port: livePort };
}

// live 模式聚合代理：/api/* → 后端；其它 → vite dev server（实时预览，前后端都可用）。
// base 传给代理，转发 vite 请求时补回 /preview/<id>/ 前缀（vite 配了该 base，不带会 302 死循环）。
async function startViteAggregateProxy({ runtimeRef, workspacePath, devPort, backendPort, listenPort, base, apiPrefixes = [], onLog }) {
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
            [proxyPath, '--live', String(devPort), String(backendPort), String(listenPort), base || '',
                ...(Array.isArray(apiPrefixes) && apiPrefixes.length ? [`--api-prefixes=${apiPrefixes.join(',')}`] : [])],
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

// 探测沙箱内包管理器：pnpm workspace/lock 优先，其次 yarn/bun，默认 npm。
async function detectGuestPackageManager(runtimeRef, workspacePath) {
    const runtime = getRuntime();
    try {
        const r = await runtime.exec.exec('sh', ['-c',
            'for f in pnpm-workspace.yaml pnpm-lock.yaml; do [ -f "$f" ] && echo pnpm && exit 0; done; [ -f yarn.lock ] && echo yarn && exit 0; [ -f bun.lockb ] && echo bun && exit 0; echo npm'],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 10000 });
        const pm = String(r.stdout || '').trim().split('\n')[0];
        return ['pnpm', 'yarn', 'bun'].includes(pm) ? pm : 'npm';
    } catch { return 'npm'; }
}

// 平台侧确定性 install：把部署里最大的时间块（install）从 verify agent 手里拿走。
// 动机（journal 实测）：agent 执行 install 有三类浪费——单命令 240s 超时截断后重跑（时间
// 双倍）、workspaces 项目逐子包重复 install、以及 lockfile/依赖状态理解偏差导致的多余重装。
// 平台按 depsStatus 确定性执行：
//   1) 全 CACHED → 不跑；
//   2) Node：根目录一次 install（workspaces/pnpm-workspace 自动装齐全部子包）→ 重探测 →
//      仍非 CACHED 的子包逐个补装（上限 20，超出交给 agent 兜底）；
//   3) Python：stack.installCmd（requirements.txt）。
// 结果（命令 + 成败 + 失败日志尾部）写入 plan.context.platformInstall，由 analyzeVerify
// 注入 prompt：「平台已装好，禁止重复 install」；失败的带日志让 agent 定点修复。
// 前置条件：configureGuestMirrors 已执行（镜像源就绪）、ensureDependencyExcludeInGuest
// 已执行（install 落盘 node_modules 前排除项先配好）——调用方保证顺序。
/**
 * 静态识别 electron 桌面应用子包（apps/desktop、desktop/ 等，package.json 依赖含 electron）。
 * electron 无法在浏览器 preview，其依赖（electron 二进制下载 + electron-builder install-app-deps）
 * 是国内 github releases 链路卡死的源头；识别后 platform install 跳过其安装脚本/补装。
 * 纯文件读取（毫秒级），对其他含 desktop 子包的项目同样生效。
 * @param {string|null} hostWorkspacePath
 * @returns {{name:string, path:string, electron:string}[]}
 */
function detectElectronDesktopSubpackages(hostWorkspacePath) {
    if (!hostWorkspacePath) return [];
    const out = [];
    try {
        for (const sub of ['apps', 'desktop', 'client']) {
            const base = path.join(hostWorkspacePath, sub);
            if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) continue;
            for (const dir of fs.readdirSync(base)) {
                const pkgPath = path.join(base, dir, 'package.json');
                if (!fs.existsSync(pkgPath)) continue;
                try {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
                    if (deps.electron) {
                        out.push({ name: pkg.name || dir, path: `${sub}/${dir}`, electron: deps.electron });
                    }
                } catch { /* 单包解析失败不影响其他 */ }
            }
        }
    } catch { /* 扫描失败不影响 install */ }
    return out;
}

async function runPlatformInstall({ runtimeRef, workspacePath, hostWorkspacePath, stack, depsStatus, onLog }) {
    const runtime = getRuntime();
    const log = (m) => { if (onLog) onLog(m); };
    const stale = Object.entries(depsStatus || {}).filter(([, v]) => v !== 'CACHED');
    if (!stale.length) return { ran: false };
    const type = stack?.type || 'unknown';
    // 多仓库/目录式 monorepo：根目录没有 package.json，detectProjectType 常返回 unknown/static，
    // 但子包（frontend/server）有 package.json 且 STALE —— 也必须做平台预装，否则全落到 agent
    // 现场 pnpm/npm install（慢、易撞 40min 总超时）。
    const hasRootPkg = !!(hostWorkspacePath && fs.existsSync(path.join(hostWorkspacePath, 'package.json')));
    const hasStaleSub = stale.some(([sub]) => sub && sub !== '.');
    // node-express/node-vite/node-next 等 node-* 变体全部支持——之前白名单漏了
    // node-express（xensemble 的实际类型），platform install 整个被跳过，
    // server/web 子包依赖全靠 agent 手装（多花 4+ 分钟）。
    if (!(type === 'monorepo' || type === 'python' || type.startsWith('node') || hasStaleSub)) {
        return { ran: false, skipped: type };
    }

    const cmds = [];
    // exec 的默认 PATH 可能不含 /usr/local/bin——guest 的 node/npm/pnpm（corepack 装的）
    // 都在那里，而 agent spawn 环境有完整 PATH 不受影响。实测症状：根 pnpm install
    // "command not found" 秒失败 exit 127，agent 会话里同一条命令却成功。
    // 所以平台 install 的每条命令统一前置 /usr/local/bin。
    // NODE_OPTIONS：大前端项目（katex/monaco/react-markdown 等）vite build 用 node 默认
    // 堆（~1.7GB）会 OOM，agent 要试错 2-3 次 NODE_OPTIONS 才成功（xensemble 实测
    // build ×3 ≈ 10 分钟）。平台命令统一预置 3GB 堆上限（DEPLOY_NODE_MAX_OLD_SPACE_MB
    // 可覆盖）；agent 侧由 analyzeVerify 的 run_shell 同步预置。
    const nodeMb = Number(process.env.DEPLOY_NODE_MAX_OLD_SPACE_MB) || 3072;
    // github releases 二进制下载（electron/playwright 等）国内链路卡（实测 github 主页通、
    // releases CDN 不通，宿主+沙箱一致）。方案：主走 npmmirror 国内二进制镜像，install
    // 失败后用 ghproxy 类 github 代理兜底（第三方，短超时快速失败，不拖流程）。
    // verify agent 侧由 analyzeVerify 的 run_shell 注入同一组镜像 env。
    const MIRROR_ENV = 'export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/; '
        + 'export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/; '
        + 'export PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/; ';
    // ghproxy 兜底：ELECTRON_MIRROR 指向 ghproxy 前缀（代理完整 github releases URL）。
    // 第三方服务不稳定，作为失败后的最后一次尝试，用短超时避免拖住部署。
    const GH_PROXY = process.env.DEPLOY_GH_PROXY || 'https://ghproxy.net';
    const GH_PROXY_ENV = `export ELECTRON_MIRROR=${GH_PROXY}/https://github.com/electron/electron/releases/download/; `;
    const GH_FALLBACK_INSTALL_TIMEOUT_MS = Number(process.env.DEPLOY_GH_FALLBACK_TIMEOUT_MS) || 300000;
    const PATH_PREFIX = `export PATH="/usr/local/bin:$PATH"; export NODE_OPTIONS="--max-old-space-size=${nodeMb}"; `;
    // CI=true：包管理器无 TTY 环境的官方标准解法。pnpm 在需要重建 node_modules（锁文件/
    // 依赖变化触发全量重装）时，无 TTY 下会 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
    // 中止（安全保护），yarn/npm 也有类似交互保护。platform install 的每条命令都带 CI=true，
    // 从根上消除该类秒失败（实测 multica：platform install pnpm 秒失败 → verify agent 试错
    // 到第 3 轮才 export CI=true 成功，白耗 3+ 分钟）。对所有包管理器、所有项目通用。
    const CI_ENV = 'export CI=true; ';
    // install 根命令单独超时：大 monorepo 冷装（multica 245 子包全量下载 + store 首写）
    // 实测 9-10 分钟，600s 默认会截断——且失败连锁严重（agent 再装 ~5min / npm fallback
    // 覆盖不齐导致子包缺失）。
    const INSTALL_TIMEOUT_MS = Number(process.env.DEPLOY_INSTALL_TIMEOUT_MS) || 1200000;

    // electron 桌面应用子包：无法在浏览器 preview，对部署目标无用；其依赖（electron 二进制
    // 下载 + electron-builder install-app-deps）正是 github 卡死的源头。识别后根 install 用
    // --ignore-scripts 跳过其 postinstall，补装循环直接排除该子包。
    const electronSubs = detectElectronDesktopSubpackages(hostWorkspacePath);
    const electronSubPaths = new Set(electronSubs.map((e) => e.path));
    const run = async (cmd, cwd, timeoutMs = 600000, useGhProxy = false) => {
        log(`platform install: ${cmd}${cwd ? ` (cwd=${cwd})` : ''}${useGhProxy ? ' [ghproxy fallback]' : ''}`);
        try {
            const r = await runtime.exec.exec('sh', ['-c',
                `${CI_ENV}${PATH_PREFIX}${useGhProxy ? GH_PROXY_ENV : MIRROR_ENV}${cmd} > /tmp/_pi.log 2>&1; ec=$?; tail -15 /tmp/_pi.log; echo "__PI_EXIT__=\${ec}"`],
                {}, { runtimeRef, cwd: cwd ? `${workspacePath}/${cwd}` : workspacePath, timeoutMs });
            const out = String(r.stdout || '');
            const m = out.match(/__PI_EXIT__=(-?\d+)/);
            const ec = m ? parseInt(m[1], 10) : (Number.isInteger(r.exitCode) ? r.exitCode : 1);
            const tail = out.replace(/__PI_EXIT__=-?\d+\s*/, '').trim().slice(-800);
            cmds.push({ cmd, cwd: cwd || '.', ok: ec === 0, logTail: ec === 0 ? undefined : tail });
            return ec === 0;
        } catch (e) {
            cmds.push({ cmd, cwd: cwd || '.', ok: false, logTail: String(e.message).slice(0, 800) });
            return false;
        }
    };

    // native 编译链预装：依赖里有 node-gyp 类原生包（node-pty/bcrypt/sharp 等）时，
    // 沙箱默认无 build-essential —— npm install 会部分失败或 agent 要自己试错 apt
    // （xensemble 实测 1.6 分钟 + 一轮 LLM）。命中即预装（幂等：已装则跳过）。
    try {
        const { detectNativeDeps } = require('./detectStack');
        const native = detectNativeDeps(hostWorkspacePath || null);
        if (native.hit) {
            const chk = await runtime.exec.exec('sh', ['-c', 'dpkg -s build-essential >/dev/null 2>&1 && echo YES || echo NO'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 10000 });
            if (String(chk.stdout || '').trim() !== 'YES') {
                log(`native compile deps detected (${native.pkgs.join(', ')}): installing build-essential + python3`);
                // 防卡死：清残留锁 + DPkg::Lock::Timeout/Acquire 重试/超时，避免 apt 长期挂起
                await aptSafeInstall({
                    runtime, runtimeRef, workspacePath,
                    packages: 'build-essential python3',
                    onLog: (m) => log(m),
                    timeoutMs: 240000,
                });
            } else {
                log(`native compile deps detected (${native.pkgs.join(', ')}): build-essential already present`);
            }
        }
    } catch (e) {
        log(`native deps preinstall failed (non-fatal): ${e.message?.slice(0, 120)}`);
    }

    if (type === 'python') {
        const cmd = stack.installCmd || 'pip install -r requirements.txt';
        const ok = await run(cmd, '');
        log(`platform install ${ok ? 'ok' : 'FAILED'} (python)`);
        return { ran: true, ok, cmds };
    }

    // Node / monorepo：解析「沙箱内实际可用」的安装命令。
    // 只看 lockfile 判定包管理器不够：guest 不继承宿主 nvm PATH，lockfile 是 pnpm
    // 而沙箱没有 pnpm 二进制时命令秒失败（deepseek-harness 实测）。降级链：
    //   pnpm → corepack pnpm（node 22 内置 corepack）→ npm i -g pnpm（镜像源，秒级）
    //   → npm install（最后兜底，注意 npm 不识别 pnpm-workspace.yaml，覆盖不到子包，
    //     此时依赖下方重探测补漏——但 245 子包的项目补漏上限 20 远不够，所以 pnpm 链
    //     能走通必须走通）。
    const cmdExists = async (c) => {
        try {
            const r = await runtime.exec.exec('sh', ['-c', `export PATH="/usr/local/bin:$PATH"; command -v ${c} >/dev/null 2>&1 && echo YES || echo NO`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 10000 });
            return String(r.stdout || '').trim() === 'YES';
        } catch { return false; }
    };
    // 根目录有 package.json 时做"根 install"；没有（多仓库/目录式 monorepo）则跳过根 install，
    // 直接由下方逐子包装（每个子包用自己的包管理器）。
    let ok = true;
    let effectiveCmd = null;
    if (hasRootPkg) {
        const pm = await detectGuestPackageManager(runtimeRef, workspacePath);
        let installCmd = pm === 'pnpm' ? 'pnpm install --no-frozen-lockfile'
            : pm === 'yarn' ? 'yarn install'
                : pm === 'bun' ? 'bun install'
                    : 'npm install --no-audit --no-fund';
        if (pm === 'pnpm' && !(await cmdExists('pnpm'))) {
            if (await cmdExists('corepack')) {
                log('platform install: pnpm binary missing, using corepack pnpm');
                installCmd = 'corepack pnpm install --no-frozen-lockfile';
            } else {
                log('platform install: pnpm missing, trying npm i -g pnpm');
                const installed = await (async () => {
                    try {
                        const r = await runtime.exec.exec('sh', ['-c', 'export PATH="/usr/local/bin:$PATH"; npm install -g pnpm --no-audit --no-fund >/dev/null 2>&1 && echo YES || echo NO'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 120000 });
                        return String(r.stdout || '').trim() === 'YES';
                    } catch { return false; }
                })();
                if (installed) log('platform install: pnpm installed globally');
                else log('platform install: npm i -g pnpm failed, will fall back to npm install');
            }
        }
        // electron 桌面子包存在：根 install 加 --ignore-scripts 跳过 electron 二进制下载与
        // electron-builder install-app-deps（github releases 国内卡死的源头）。web/server 的
        // postinstall（如 sharp/esbuild）同样被跳过，由 verify agent 在需要时补跑。
        if (electronSubs.length && /^corepack pnpm|^pnpm|^yarn/.test(installCmd)) {
            log(`platform install: electron desktop sub-packages detected (${electronSubs.map((e) => e.name).join(', ')}), adding --ignore-scripts to avoid github binary download`);
            installCmd += ' --ignore-scripts';
        }
        ok = await run(installCmd, '', INSTALL_TIMEOUT_MS);
        if (!ok && pm === 'pnpm') {
            // pnpm 断点续装：第一次超时/失败时 store 已写入大部分包，重试只需补剩余
            // （远快于首装），同时消掉「冷装贴着超时上限」的不确定性——比失败后交给
            // npm fallback（覆盖不齐 pnpm workspace）或 agent 再装（实测多花 ~5min）都好。
            // 兜底重试切 ghproxy 镜像（第三方，短超时，失败快速进入 npm fallback 不拖流程）。
            log('platform install: pnpm first attempt failed, retrying via ghproxy mirror fallback (short timeout)');
            ok = await run(installCmd, '', GH_FALLBACK_INSTALL_TIMEOUT_MS, true);
        }
        effectiveCmd = ok ? installCmd : null;
        if (!ok && pm !== 'npm') {
            // pnpm/yarn/bun 二进制缺失或安装失败：回退 npm（覆盖 package.json workspaces；
            // pnpm-only workspace 覆盖不到子包，由下方重探测补漏循环兜底）。
            // ⚠️ catalog: 协议守卫：pnpm workspace 的 catalog 特性（pnpm 9.5+/10）是 pnpm 专属，
            // package.json 依赖值形如 "catalog:"。npm 不认识该协议，必然
            // EUNSUPPORTEDPROTOCOL 秒失败（multica 实测）——命中则跳过 npm fallback，避免
            // 3 秒白费 + 错误归因，直接交给 verify agent（平台已预置 CI=true，agent 的 pnpm
            // 可正常重建 node_modules）。
            const hasCatalogProtocol = (() => {
                try {
                    const scan = (dir) => {
                        const pkgPath = path.join(dir, 'package.json');
                        if (!fs.existsSync(pkgPath)) return false;
                        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
                        return Object.values(deps).some((v) => String(v).startsWith('catalog:'));
                    };
                    if (scan(hostWorkspacePath)) return true;
                    for (const sub of ['apps', 'packages', 'web', 'client', 'server']) {
                        const dir = path.join(hostWorkspacePath, sub);
                        if (!fs.existsSync(dir)) continue;
                        if (fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && scan(path.join(dir, e.name)))) return true;
                    }
                    return false;
                } catch { return false; }
            })();
            if (hasCatalogProtocol) {
                log(`platform install: package.json uses pnpm catalog: protocol (npm incompatible) — skipping npm fallback, leaving to verify agent (CI=true preset)`);
            } else {
                log(`platform install: ${pm} install failed, falling back to npm install`);
                const npmOk = await run('npm install --no-audit --no-fund', '');
                if (npmOk) { ok = true; effectiveCmd = 'npm install --no-audit --no-fund'; }
            }
        }
    } else {
        log('platform install: no root package.json (multi-repo / dir-based monorepo) — installing per sub-package');
    }
    // 重探测补漏：根 install 不覆盖"独立子项目"（无 workspace 配置的 monorepo）。
    // 仍非 CACHED 的子包逐个补装；超过 20 个放弃逐包（极端项目交给 agent，避免拖死总预算）。
    // 补装命令必须用「根 install 实际成功的那条」——不能用理论上的 installCmd（可能
    // 就是失败的那条，如 pnpm 二进制缺失时逐条秒失败，245 个子包一个都装不上）。
    let remainingStale = 0;
    let finalStatus = null;
    try {
        const { buildDetectScript, parseDepsStatus } = require('./detectStack');
        const r = await runtime.exec.exec('sh', ['-c', buildDetectScript(stack)], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 });
        finalStatus = parseDepsStatus(r.stdout);
        const stillStale = Object.entries(finalStatus.perPackage || {}).filter(([, v]) => v !== 'CACHED');
        remainingStale = stillStale.length;
        // 逐子包补装（与根 install 是否成功无关）：根 install 成功时复用 effectiveCmd；
        // 无根 package.json（多仓库）时按**每个子包自己的包管理器**选命令（前端 pnpm 后端 npm 各自为政）。
        {
            const { detectPackageManager: detectHostPm } = require('./detectStack');
            const pmCmd = (pm) => pm === 'pnpm' ? 'pnpm install --no-frozen-lockfile'
                : pm === 'yarn' ? 'yarn install'
                    : pm === 'bun' ? 'bun install'
                        : 'npm install --no-audit --no-fund';
            const subInstallCmd = (sub) => {
                try {
                    const dir = path.join(hostWorkspacePath, sub);
                    if (fs.existsSync(path.join(dir, 'package.json'))) return pmCmd(detectHostPm(dir));
                } catch { /* ignore */ }
                return null;
            };
            // 补装并行化：各子包 install 互相独立（无 workspace 依赖），串行实测
            // web 13s + server 25s + desktop 78s = ~2min，并行后 = max(~78s)。
            // 并发限流：沙箱内存有限（2GB），同时跑太多 npm install 会互相 OOM，
            // 默认 3 并发，DEPLOY_INSTALL_CONCURRENCY 可覆盖。
            const subs = stillStale.map(([sub]) => sub).filter((s) => s !== '.' && !electronSubPaths.has(s)).slice(0, 20);
            if (electronSubs.length && subs.length !== stillStale.filter(([s]) => s !== '.').length) {
                log(`platform install: skipping electron desktop sub-package(s) in per-sub install (${electronSubs.map((e) => e.path).join(', ')})`);
            }
            if (subs.length) {
                const concurrency = Math.max(1, Math.min(Number(process.env.DEPLOY_INSTALL_CONCURRENCY) || 3, subs.length));
                const queue = [...subs];
                const workers = Array.from({ length: concurrency }, async () => {
                    while (queue.length) {
                        const sub = queue.shift();
                        const subCmd = effectiveCmd || subInstallCmd(sub);
                        if (!subCmd) continue;
                        const subOk = await run(subCmd, sub);
                        if (!subOk) ok = false;
                    }
                });
                await Promise.all(workers);
            }
        }
        if (stillStale.length > 20) log(`platform install: ${stillStale.length} sub-packages still stale (capped at 20), rest left to verify agent`);
    } catch (e) {
        log(`platform install re-detect failed (non-fatal): ${e.message?.slice(0, 120)}`);
    }
    log(`platform install ${ok ? 'ok' : 'PARTIALLY FAILED'} (${cmds.length} command(s), ${remainingStale} sub-package(s) still stale)`);
    return { ran: true, ok, cmds, remainingStale, finalStatus };
}


// Go 版本比较：go.mod "go 1.26.1" vs 沙箱 "go1.22.5" → 全量 major.minor.patch 比较。
function goVersionSatisfies(current, required) {
    const parse = (v) => {
        const m = String(v || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [0, 0, 0];
    };
    const [a1, a2, a3] = parse(current);
    const [b1, b2, b3] = parse(required);
    if (a1 !== b1) return a1 > b1;
    if (a2 !== b2) return a2 > b2;
    return a3 >= b3;
}

// Go 工具链版本预检与平台预装：go.mod 要求的版本高于沙箱已装版本时（如要求 go 1.26
// 而沙箱是 apt 的 1.19/1.22），agent 只能反复试错——实测 multica（AgentHarness）verify
// 烧掉 30+ 分钟在「apt 装旧 Go → 降级 go.mod → 编译失败 → 恢复重来」循环上。
// 平台在 verify 前确定性装好：从 npmmirror 的 golang 二进制镜像下载 tarball 解到
// /usr/local/go，并软链 go/gofmt 到 /usr/local/bin（已在 exec 与 agent PATH 内）。
// 已满足时仅补写 GOPROXY 持久配置（configureGuestMirrors 只在 go 已装时写，且装完
// 新 Go 后也要重写一次——它不会跑第二次）。
async function ensureGuestGoToolchain({ runtimeRef, workspacePath, hostWorkspacePath, onLog }) {
    const runtime = getRuntime();
    const log = (m) => { if (onLog) onLog(m); };
    const PATH_PREFIX = 'export PATH="/usr/local/bin:$PATH"; ';
    log(`[ensureGuestGoToolchain] START hostWorkspacePath=${hostWorkspacePath}`);
    try {
        // 1) 读 go.mod 要求版本：复用 findVersionFile 深度扫描（MAX_SEARCH_DEPTH=3，任意
        //    目录结构都覆盖），而非硬编码根/常见子目录。AgentHarness/multica 的 Go 服务在
        //    server/ 子目录，只读根 go.mod 会漏检 → 预装跳过 → verify agent 现场试错 30+ 轮
        //    还降级 go.mod 污染源码。
        let required = null;
        if (hostWorkspacePath) {
            const found = await findVersionFile(hostWorkspacePath, 'go');
            if (found.found) {
                required = String(found.content).match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m)?.[1] || null;
            }
        }
        if (!required) return { ran: false };
        // 2) 沙箱当前 go 版本
        let current = null;
        try {
            const r = await runtime.exec.exec('sh', ['-c', `${PATH_PREFIX}go version 2>/dev/null || echo NO_GO`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
            current = String(r.stdout || '').match(/go(\d+\.\d+(?:\.\d+)?)/)?.[1] || null;
        } catch { /* go missing */ }
        if (current && goVersionSatisfies(current, required)) {
            await runtime.exec.exec('sh', ['-c', `${PATH_PREFIX}go env -w GOPROXY=https://goproxy.cn,direct 2>/dev/null; go env -w GOSUMDB=sum.golang.google.cn 2>/dev/null; true`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 }).catch(() => {});
            log(`go toolchain ok (${current} >= ${required}), GOPROXY configured`);
            return { ran: true, ok: true, version: current, installed: false };
        }
        // 3) 下载并解包目标版本。go.mod 版本可能不带 patch（"go 1.21"）→ 补 .0。
        // 镜像主备：阿里云 golang 镜像（实测 200）→ golang.google.cn（Google 中国官方镜像）。
        const ver = /^\d+\.\d+$/.test(required) ? `${required}.0` : required;
        const arch = (await runtime.exec.exec('sh', ['-c', 'uname -m'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 10000 }).catch(() => ({ stdout: 'x86_64' }))).stdout?.trim() || 'x86_64';
        const goArch = arch === 'aarch64' || arch === 'arm64' ? 'arm64' : 'amd64';
        const dlCmd = [
            `https://mirrors.aliyun.com/golang/go${ver}.linux-${goArch}.tar.gz`,
            `https://golang.google.cn/dl/go${ver}.linux-${goArch}.tar.gz`,
        ].map((u) => `curl -fsSL -m 240 -o /tmp/go-toolchain.tgz "${u}"`).join(' || ');
        log(`go toolchain ${current || 'missing'} < required ${required}: installing go${ver} from mirror (${goArch})`);
        const r = await runtime.exec.exec('sh', ['-c',
            `${PATH_PREFIX}set -e; ${dlCmd} && rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go-toolchain.tgz && rm -f /usr/local/bin/go /usr/local/bin/gofmt && ln -sf /usr/local/go/bin/go /usr/local/bin/go && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt && /usr/local/bin/go version && /usr/local/bin/go env -w GOPROXY=https://goproxy.cn,direct && /usr/local/bin/go env -w GOSUMDB=sum.golang.google.cn && echo "__GO_OK__"`],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 600000 });
        const ok = String(r.stdout || '').includes('__GO_OK__');
        if (ok) {
            log(`go toolchain installed: go${ver} (GOPROXY=goproxy.cn)`);
            return { ran: true, ok: true, version: ver, installed: true };
        }
        const tail = String(r.stdout || r.stderr || '').trim().slice(-400);
        log(`go toolchain install FAILED (non-fatal, agent will handle): ${tail}`);
        return { ran: true, ok: false, version: null, installed: false, logTail: tail };
    } catch (e) {
        log(`go toolchain ensure failed (non-fatal): ${e.message?.slice(0, 200)}`);
        return { ran: true, ok: false, installed: false };
    }
}

// 通用工具链预装（Java/Maven、Java/Gradle、Ruby、Elixir、Dart、.NET 等）：
// 基于宿主侧 detectSystemDeps 检测出的 toolchains（多语言构建文件 → 工具链映射），
// 沙箱缺对应命令时用 apt 前置装好，避免 verify agent 现场 apt 装卡死
// （实测多仓库 Spring Boot 项目：agent 现场 apt 装 default-jdk/mariadb 单条 600s 超时
// 被截断 + dpkg 锁残留反复重试，阶段 2 prepare 卡 10+ 分钟）。
// 幂等：已装则跳过；apt 失败 non-fatal（agent 兜底）。与 Go/Node/Python/Rust 运行时
// 版本预装（ensureGuestGoToolchain / ensureGuestRuntimeVersions）互补，都是"平台前置、
// 不阻塞 verify"的同一模式。
async function ensureGuestToolchains({ runtimeRef, workspacePath, toolchains, onLog }) {
    const runtime = getRuntime();
    const log = (m) => { if (onLog) onLog(m); };
    // tool → 沙箱探活命令（任一命中即视为已装，避免重复 apt）
    const PROBE_CMDS = {
        'jdk-maven': 'command -v java >/dev/null 2>&1 && command -v mvn >/dev/null 2>&1',
        'jdk-gradle': 'command -v java >/dev/null 2>&1 && command -v gradle >/dev/null 2>&1',
        'ruby': 'command -v ruby >/dev/null 2>&1 && command -v bundle >/dev/null 2>&1',
        'elixir': 'command -v elixir >/dev/null 2>&1',
        'dart': 'command -v dart >/dev/null 2>&1',
        'dotnet': 'command -v dotnet >/dev/null 2>&1',
    };
    // 预装项：toolchains（Java/Maven、Java/Gradle、Ruby、Elixir、Dart、.NET 等）。
    // 统一走"探活 → 缺则 aptSafeInstall"逻辑，幂等且 non-fatal。
    // 数据库/缓存服务（mysql/redis 等）由 provisionDbServices 统一处理（装+启动+就绪），
    // 不在本函数重复安装，避免并行 apt 锁竞争。
    // packages 兜底表：即使调用方漏传 packages（历史 bug），也按 tool 取默认 apt 包，
    // 避免再次静默空转。只列沙箱（Debian bookworm）有官方包的；dart/.NET 无官方包 → 不预装。
    const PKG_BY_TOOL = {
        'jdk-maven': ['default-jdk', 'maven'],
        'jdk-gradle': ['default-jdk', 'gradle'],
        'ruby': ['ruby', 'ruby-bundler'],
        'elixir': ['elixir'],
        'dart': [],
        'dotnet': [],
    };
    const items = [];
    for (const tc of Array.isArray(toolchains) ? toolchains : []) {
        if (!tc || !tc.tool || !PROBE_CMDS[tc.tool]) continue;
        const fromDetector = Array.isArray(tc.packages) ? tc.packages : [];
        const pkgs = fromDetector.length ? fromDetector : (PKG_BY_TOOL[tc.tool] || []);
        if (pkgs.length) {
            items.push({ id: tc.tool, evidence: tc.evidence || '', probe: PROBE_CMDS[tc.tool], packages: pkgs });
        } else {
            log(`toolchain ${tc.tool} detected but no installable apt package on bookworm; leaving to agent`);
        }
    }
    if (items.length === 0) {
        log(`no toolchain to pre-install (detected: ${(Array.isArray(toolchains) ? toolchains : []).map((t) => t && t.tool).filter(Boolean).join(',') || 'none'})`);
        return { ran: false, results: [] };
    }
    const results = [];
    for (const item of items) {
        try {
            const r = await runtime.exec.exec('sh', ['-c', `if ${item.probe}; then echo INSTALLED; else echo MISSING; fi`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 }).catch(() => ({ stdout: 'MISSING' }));
            if (String(r.stdout || '').includes('INSTALLED')) {
                log(`toolchain ${item.id} ok (already installed)`);
                results.push({ tool: item.id, ok: true, installed: false });
                continue;
            }
            log(`toolchain ${item.id} missing (${item.evidence || ''}): installing ${item.packages.join(' ')}`);
            const res = await aptSafeInstall({ runtime, runtimeRef, workspacePath, packages: item.packages.join(' '), onLog, timeoutMs: 420000 });
            if (res.ok) {
                log(`toolchain ${item.id} installed: ${item.packages.join(' ')}`);
                results.push({ tool: item.id, ok: true, installed: true });
            } else {
                log(`toolchain ${item.id} install FAILED (non-fatal, agent will handle): ${(res.logTail || '').slice(0, 300)}`);
                results.push({ tool: item.id, ok: false, installed: false });
            }
        } catch (e) {
            log(`toolchain ${item.id} ensure failed (non-fatal): ${e.message?.slice(0, 200)}`);
            results.push({ tool: item.id, ok: false, installed: false });
        }
    }
    return { ran: results.length > 0, results };
}

/**
 * 版本比较：major.minor.patch 数值比较
 */
function versionSatisfies(current, required) {
    // 支持主版本号单独出现（.nvmrc/.tool-versions 常写 "22" 这种无点格式）：
    // 旧正则要求必须带点，"22" 解析为空 → 22 > undefined = false → 22.17.0 被
    // 误判为不满足要求，每次部署都白白重装 node（实测每次多花 1-3 分钟）。
    const parse = (v) => {
        const m = String(v || '').trim().replace(/^v/, '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
        if (!m) return null;
        return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
    };
    const c = parse(current);
    const r = parse(required);
    // 任一版本无法解析 → 放行不阻断（真实健康检查兜底），好过盲装一个垃圾版本
    if (!c || !r) return true;
    if (c[0] !== r[0]) return c[0] > r[0];
    if (c[1] !== r[1]) return c[1] > r[1];
    return c[2] >= r[2];
}

/**
 * 递归搜索版本文件（宿主侧）
 * @param {string} hostRoot - 宿主项目根路径
 * @param {string} language - 语言标识
 * @returns {Promise<{content: string, subdir: string, file: string, found: boolean}>}
 */
async function findVersionFile(hostRoot, language) {
    if (!hostRoot) return { content: '', subdir: null, file: null, found: false };
    const targets = TARGET_FILES[language] || [];
    const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.next', 'out', 'coverage'];
    const MAX_SEARCH_DEPTH = 3;
    const MAX_FILES_TO_CHECK = 50;
    const SEARCH_TIMEOUT_MS = 10000;
    let checked = 0;

    async function searchDir(dir, depth) {
        if (depth > MAX_SEARCH_DEPTH || checked >= MAX_FILES_TO_CHECK) return null;
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (checked >= MAX_FILES_TO_CHECK) break;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (SKIP_DIRS.includes(entry.name)) continue;
                    const found = await searchDir(fullPath, depth + 1);
                    if (found) return found;
                } else if (targets.includes(entry.name)) {
                    checked++;
                    const { readTextSafe } = require('./detectStack');
                    const content = String(readTextSafe(fullPath) || '');
                    if (content.trim()) {
                        return { content, subdir: path.relative(hostRoot, path.dirname(fullPath)), file: entry.name, found: true };
                    }
                }
            }
        } catch { /* 忽略权限错误等 */ }
        return null;
    }

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('search timeout')), SEARCH_TIMEOUT_MS));
    try {
        const result = await Promise.race([searchDir(hostRoot, 0), timeoutPromise]);
        return result || { content: '', subdir: null, file: null, found: false };
    } catch {
        return { content: '', subdir: null, file: null, found: false };
    }
}

/**
 * 在沙箱中执行命令
 */
async function execGuestCommand(runtime, runtimeRef, workspacePath, cmd, timeoutMs = 30000) {
    const PATH_PREFIX = 'export PATH="/usr/local/bin:$PATH"; ';
    try {
        const r = await runtime.exec.exec('sh', ['-c', `${PATH_PREFIX}${cmd}`], {}, { runtimeRef, cwd: workspacePath, timeoutMs });
        return { ok: true, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
    } catch (e) {
        return { ok: false, error: String(e.message || e) };
    }
}

/**
 * 目标文件名（按优先级，找到即停止）
 */
const TARGET_FILES = {
    node: ['package.json', '.nvmrc', '.node-version', '.tool-versions'],
    python: ['pyproject.toml', '.python-version', '.tool-versions'],
    rust: ['rust-toolchain.toml', 'rust-toolchain', 'Cargo.toml', '.tool-versions'],
    java: ['pom.xml', 'build.gradle', 'build.gradle.kts', '.tool-versions'],
    go: ['go.mod'],
    php: ['composer.json', '.php-version', '.tool-versions'],
    dotnet: ['global.json', '.tool-versions', 'Directory.Build.props'],
    ruby: ['Gemfile', '.ruby-version', '.tool-versions'],
    cpp: ['CMakeLists.txt', 'Makefile', 'conanfile.txt', 'vcpkg.json', 'meson.build'],
    swift: ['Package.swift', '.swift-version', '.tool-versions'],
    zig: ['build.zig', 'zig.mod', '.tool-versions'],
};

/**
 * 确保 Node.js 版本
 */
async function ensureNodeVersion({ runtime, runtimeRef, workspacePath, hostWorkspacePath, log, execGuest }) {
    let nodeRequired = null;
    const pkgJsonResult = await findVersionFile(hostWorkspacePath, 'node');
    if (pkgJsonResult.found && pkgJsonResult.file === 'package.json') {
        log(`[ensureGuestRuntimeVersions] package.json found in ${pkgJsonResult.subdir || 'root'}`);
        try {
            const pkg = JSON.parse(pkgJsonResult.content);
            nodeRequired = pkg?.engines?.node || null;
        } catch { }
    }
    if (!nodeRequired) {
        const nvmrcResult = await findVersionFile(hostWorkspacePath, 'node');
        if (nvmrcResult.found && (nvmrcResult.file === '.nvmrc' || nvmrcResult.file === '.node-version')) {
            log(`[ensureGuestRuntimeVersions] ${nvmrcResult.file} found in ${nvmrcResult.subdir || 'root'}`);
            nodeRequired = nvmrcResult.content.trim().replace(/^v/, '');
        }
    }
    if (!nodeRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'node');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^nodejs\s+(\S+)/m);
            if (m) nodeRequired = m[1].replace(/^v/, '');
        }
    }
    if (!nodeRequired) return { required: null, current: null, installed: false };

    const current = await execGuest('node --version 2>/dev/null || echo NO_NODE', 10000);
    const curVer = current.stdout?.match(/v?(\d+\.\d+\.\d+)/)?.[1] || null;
    if (!curVer || !versionSatisfies(curVer, nodeRequired)) {
        log(`node ${curVer || 'missing'} < required ${nodeRequired}: installing via nvm (npmmirror)`);
        const installCmd = `export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node; ` +
            `if [ ! -s "$HOME/.nvm/nvm.sh" ]; then curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash; fi; ` +
            `source "$HOME/.nvm/nvm.sh"; nvm install ${nodeRequired} && nvm use ${nodeRequired} && nvm alias default ${nodeRequired} && node --version && echo "__NODE_OK__"`;
        const r = await execGuest(installCmd, 300000);
        return { required: nodeRequired, current: curVer, installed: r.stdout?.includes('__NODE_OK__') };
    } else {
        log(`node ok (${curVer} >= ${nodeRequired})`);
        return { required: nodeRequired, current: curVer, installed: false };
    }
}

/**
 * 确保 Python 版本
 */
async function ensurePythonVersion({ runtime, runtimeRef, workspacePath, hostWorkspacePath, log, execGuest }) {
    let pythonRequired = null;
    const pyprojectResult = await findVersionFile(hostWorkspacePath, 'python');
    if (pyprojectResult.found && pyprojectResult.file === 'pyproject.toml') {
        log(`[ensureGuestRuntimeVersions] pyproject.toml found in ${pyprojectResult.subdir || 'root'}`);
        const m = pyprojectResult.content.match(/requires-python\s*=\s*['"]([^'"]+)['"]/);
        if (m) pythonRequired = m[1].replace(/^[<>=~^!]+/, '').replace(/\*$/, '').trim();
    }
    if (!pythonRequired) {
        const pyVerResult = await findVersionFile(hostWorkspacePath, 'python');
        if (pyVerResult.found && pyVerResult.file === '.python-version') {
            pythonRequired = pyVerResult.content.trim().replace(/^v/, '');
        }
    }
    if (!pythonRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'python');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^python\s+(\S+)/m);
            if (m) pythonRequired = m[1];
        }
    }
    if (!pythonRequired) return { required: null, current: null, installed: false };

    const current = await execGuest('python3 --version 2>/dev/null || echo NO_PYTHON', 10000);
    const curVer = current.stdout?.match(/Python\s+(\d+\.\d+\.\d+)/)?.[1] || null;
    if (!curVer || !versionSatisfies(curVer, pythonRequired)) {
        log(`python ${curVer || 'missing'} < required ${pythonRequired}: installing via apt (debian backports)`);
        const majorMinor = pythonRequired.split('.').slice(0, 2).join('.');
        const installCmd = `apt-get update -qq && apt-get install -y -t bookworm-backports python3.${majorMinor.split('.')[1]} python3.${majorMinor.split('.')[1]}-venv python3.${majorMinor.split('.')[1]}-dev 2>/dev/null || ` +
            `apt-get install -y python3 python3-venv python3-dev && echo "__PYTHON_OK__"`;
        const r = await execGuest(installCmd, 300000);
        return { required: pythonRequired, current: curVer, installed: r.stdout?.includes('__PYTHON_OK__') };
    } else {
        log(`python ok (${curVer} >= ${pythonRequired})`);
        return { required: pythonRequired, current: curVer, installed: false };
    }
}

/**
 * 确保 Rust 版本
 */
async function ensureRustVersion({ runtime, runtimeRef, workspacePath, hostWorkspacePath, log, execGuest }) {
    let rustRequired = null;
    const rustToolchainResult = await findVersionFile(hostWorkspacePath, 'rust');
    if (rustToolchainResult.found && (rustToolchainResult.file === 'rust-toolchain.toml' || rustToolchainResult.file === 'rust-toolchain')) {
        log(`[ensureGuestRuntimeVersions] ${rustToolchainResult.file} found in ${rustToolchainResult.subdir || 'root'}`);
        const m = rustToolchainResult.content.match(/channel\s*=\s*['"]([^'"]+)['"]/) || rustToolchainResult.content.match(/^(\d+\.\d+\.\d+)/m);
        if (m) rustRequired = m[1];
    }
    if (!rustRequired) {
        const cargoTomlResult = await findVersionFile(hostWorkspacePath, 'rust');
        if (cargoTomlResult.found && cargoTomlResult.file === 'Cargo.toml') {
            log(`[ensureGuestRuntimeVersions] Cargo.toml found in ${cargoTomlResult.subdir || 'root'}`);
            const m = cargoTomlResult.content.match(/rust-version\s*=\s*['"]([^'"]+)['"]/);
            if (m) rustRequired = m[1];
        }
    }
    if (!rustRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'rust');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^rust\s+(\S+)/m);
            if (m) rustRequired = m[1];
        }
    }
    if (!rustRequired) return { required: null, current: null, installed: false };

    const current = await execGuest('rustc --version 2>/dev/null || echo NO_RUST', 10000);
    const curVer = current.stdout?.match(/rustc\s+(\d+\.\d+\.\d+)/)?.[1] || null;
    if (!curVer || !versionSatisfies(curVer, rustRequired)) {
        log(`rust ${curVer || 'missing'} < required ${rustRequired}: installing via rustup (rsproxy.cn)`);
        const installCmd = `export RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup; export RUSTUP_DIST_SERVER=https://rsproxy.cn; ` +
            `if [ ! -s "$HOME/.cargo/env" ]; then curl --proto '=https' --tlsv1.2 -fsSL https://rsproxy.cn/rustup-init.sh | sh -s -- -y --default-toolchain ${rustRequired}; fi; ` +
            `source "$HOME/.cargo/env"; rustup default ${rustRequired} && rustc --version && echo "__RUST_OK__"`;
        const r = await execGuest(installCmd, 400000);
        return { required: rustRequired, current: curVer, installed: r.stdout?.includes('__RUST_OK__') };
    } else {
        log(`rust ok (${curVer} >= ${rustRequired})`);
        return { required: rustRequired, current: curVer, installed: false };
    }
}

/**
 * 确保 Java 版本
 */
async function ensureJavaVersion({ runtime, runtimeRef, workspacePath, hostWorkspacePath, log, execGuest }) {
    let javaRequired = null;
    const pomXmlResult = await findVersionFile(hostWorkspacePath, 'java');
    if (pomXmlResult.found && pomXmlResult.file === 'pom.xml') {
        log(`[ensureGuestRuntimeVersions] pom.xml found in ${pomXmlResult.subdir || 'root'}`);
        const m = pomXmlResult.content.match(/<java\.version>([^<]+)<\/java\.version>/) || pomXmlResult.content.match(/<maven\.compiler\.release>([^<]+)<\/maven\.compiler\.release>/);
        if (m) javaRequired = m[1];
    }
    if (!javaRequired) {
        const gradleResult = await findVersionFile(hostWorkspacePath, 'java');
        if (gradleResult.found && (gradleResult.file === 'build.gradle' || gradleResult.file === 'build.gradle.kts')) {
            log(`[ensureGuestRuntimeVersions] ${gradleResult.file} found in ${gradleResult.subdir || 'root'}`);
            const m = gradleResult.content.match(/java\.toolchain\s+languageVersion\s*=\s*(\d+)/) || gradleResult.content.match(/sourceCompatibility\s*=\s*(\d+)/);
            if (m) javaRequired = m[1];
        }
    }
    if (!javaRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'java');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^java\s+(\S+)/m);
            if (m) javaRequired = m[1];
        }
    }
    if (!javaRequired) return { required: null, current: null, installed: false };

    const current = await execGuest('java -version 2>&1 | head -1', 10000);
    const curVer = current.stdout?.match(/version\s+"(\d+)(?:\.\d+)?/)?.[1] || current.stderr?.match(/version\s+"(\d+)(?:\.\d+)?/)?.[1] || null;
    if (!curVer || Number(curVer) < Number(javaRequired)) {
        log(`java ${curVer || 'missing'} < required ${javaRequired}: installing via apt (adoptium/temurin mirror)`);
        const installCmd = `apt-get update -qq && apt-get install -y wget gpg && ` +
            `wget -qO- https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor > /usr/share/keyrings/adoptium.gpg && ` +
            `echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" > /etc/apt/sources.list.d/adoptium.list && ` +
            `apt-get update -qq && apt-get install -y temurin-${javaRequired}-jdk && java -version && echo "__JAVA_OK__"`;
        const r = await execGuest(installCmd, 400000);
        return { required: javaRequired, current: curVer, installed: r.stdout?.includes('__JAVA_OK__') };
    } else {
        log(`java ok (${curVer} >= ${javaRequired})`);
        return { required: javaRequired, current: curVer, installed: false };
    }
}

/**
 * 确保 PHP 版本
 */
async function ensurePhpVersion({ runtime, runtimeRef, workspacePath, hostWorkspacePath, log, execGuest }) {
    let phpRequired = null;
    const composerResult = await findVersionFile(hostWorkspacePath, 'php');
    if (composerResult.found && composerResult.file === 'composer.json') {
        log(`[ensureGuestRuntimeVersions] composer.json found in ${composerResult.subdir || 'root'}`);
        try {
            const composer = JSON.parse(composerResult.content);
            phpRequired = composer?.config?.platform?.php || composer?.require?.php || null;
            if (phpRequired) phpRequired = phpRequired.replace(/^[<>=~^!]+/, '').replace(/\*$/, '').trim();
        } catch { }
    }
    if (!phpRequired) {
        const phpVerResult = await findVersionFile(hostWorkspacePath, 'php');
        if (phpVerResult.found && phpVerResult.file === '.php-version') {
            phpRequired = phpVerResult.content.trim().replace(/^v/, '');
        }
    }
    if (!phpRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'php');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^php\s+(\S+)/m);
            if (m) phpRequired = m[1];
        }
    }
    if (!phpRequired) return { required: null, current: null, installed: false };

    const current = await execGuest('php --version 2>/dev/null | head -1', 10000);
    const curVer = current.stdout?.match(/PHP\s+(\d+\.\d+\.\d+)/)?.[1] || null;
    if (!curVer || !versionSatisfies(curVer, phpRequired)) {
        log(`php ${curVer || 'missing'} < required ${phpRequired}: installing via apt (ondrej PPA)`);
        const installCmd = `apt-get update -qq && apt-get install -y software-properties-common && ` +
            `add-apt-repository -y ppa:ondrej/php && apt-get update -qq && ` +
            `apt-get install -y php${phpRequired.replace('.', '')} php${phpRequired.replace('.', '')}-cli php${phpRequired.replace('.', '')}-common && php --version && echo "__PHP_OK__"`;
        const r = await execGuest(installCmd, 300000);
        return { required: phpRequired, current: curVer, installed: r.stdout?.includes('__PHP_OK__') };
    } else {
        log(`php ok (${curVer} >= ${phpRequired})`);
        return { required: phpRequired, current: curVer, installed: false };
    }
}

/**
 * 确保 .NET 版本
 */
async function ensureDotnetVersion({ runtime, runtimeRef, workspacePath, hostWorkspacePath, log, execGuest }) {
    let dotnetRequired = null;
    const globalJsonResult = await findVersionFile(hostWorkspacePath, 'dotnet');
    if (globalJsonResult.found && globalJsonResult.file === 'global.json') {
        log(`[ensureGuestRuntimeVersions] global.json found in ${globalJsonResult.subdir || 'root'}`);
        try {
            const globalJson = JSON.parse(globalJsonResult.content);
            dotnetRequired = globalJson?.sdk?.version || null;
        } catch { }
    }
    if (!dotnetRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'dotnet');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^dotnet\s+(\S+)/m);
            if (m) dotnetRequired = m[1];
        }
    }
    if (!dotnetRequired) {
        const dirBuildResult = await findVersionFile(hostWorkspacePath, 'dotnet');
        if (dirBuildResult.found && dirBuildResult.file === 'Directory.Build.props') {
            const m = dirBuildResult.content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/) || dirBuildResult.content.match(/<NETCoreVersion>([^<]+)<\/NETCoreVersion>/);
            if (m) dotnetRequired = m[1].replace('net', '').replace('core', '');
        }
    }
    if (!dotnetRequired) return { required: null, current: null, installed: false };

    const current = await execGuest('dotnet --version 2>/dev/null', 10000);
    const curVer = current.stdout?.trim() || null;
    if (!curVer || !versionSatisfies(curVer, dotnetRequired)) {
        log(`dotnet ${curVer || 'missing'} < required ${dotnetRequired}: installing via Microsoft mirror`);
        const installCmd = `wget -q https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -O packages-microsoft-prod.deb && ` +
            `dpkg -i packages-microsoft-prod.deb && apt-get update -qq && ` +
            `apt-get install -y dotnet-sdk-${dotnetRequired} && dotnet --version && echo "__DOTNET_OK__"`;
        const r = await execGuest(installCmd, 300000);
        return { required: dotnetRequired, current: curVer, installed: r.stdout?.includes('__DOTNET_OK__') };
    } else {
        log(`dotnet ok (${curVer} >= ${dotnetRequired})`);
        return { required: dotnetRequired, current: curVer, installed: false };
    }
}

/**
 * 确保 Ruby 版本
 */
async function ensureRubyVersion({ runtime, runtimeRef, workspacePath, hostWorkspacePath, log, execGuest }) {
    let rubyRequired = null;
    const gemfileResult = await findVersionFile(hostWorkspacePath, 'ruby');
    if (gemfileResult.found && gemfileResult.file === 'Gemfile') {
        log(`[ensureGuestRuntimeVersions] Gemfile found in ${gemfileResult.subdir || 'root'}`);
        const m = gemfileResult.content.match(/ruby\s+['"]([^'"]+)['"]/);
        if (m) rubyRequired = m[1];
    }
    if (!rubyRequired) {
        const rubyVerResult = await findVersionFile(hostWorkspacePath, 'ruby');
        if (rubyVerResult.found && rubyVerResult.file === '.ruby-version') {
            rubyRequired = rubyVerResult.content.trim().replace(/^v/, '');
        }
    }
    if (!rubyRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'ruby');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^ruby\s+(\S+)/m);
            if (m) rubyRequired = m[1];
        }
    }
    if (!rubyRequired) return { required: null, current: null, installed: false };

    const current = await execGuest('ruby --version 2>/dev/null', 10000);
    const curVer = current.stdout?.match(/ruby\s+(\d+\.\d+\.\d+)/)?.[1] || null;
    if (!curVer || !versionSatisfies(curVer, rubyRequired)) {
        log(`ruby ${curVer || 'missing'} < required ${rubyRequired}: installing via apt (brightbox PPA)`);
        const installCmd = `apt-get update -qq && apt-get install -y software-properties-common && ` +
            `add-apt-repository -y ppa:brightbox/ruby-ng && apt-get update -qq && ` +
            `apt-get install -y ruby${rubyRequired.replace('.', '')} ruby${rubyRequired.replace('.', '')}-dev && ruby --version && echo "__RUBY_OK__"`;
        const r = await execGuest(installCmd, 300000);
        return { required: rubyRequired, current: curVer, installed: r.stdout?.includes('__RUBY_OK__') };
    } else {
        log(`ruby ok (${curVer} >= ${rubyRequired})`);
        return { required: rubyRequired, current: curVer, installed: false };
    }
}

/**
 * 确保 Swift 版本
 */
async function ensureSwiftVersion({ runtime, runtimeRef, workspacePath, hostWorkspacePath, log, execGuest }) {
    let swiftRequired = null;
    const packageSwiftResult = await findVersionFile(hostWorkspacePath, 'swift');
    if (packageSwiftResult.found && packageSwiftResult.file === 'Package.swift') {
        log(`[ensureGuestRuntimeVersions] Package.swift found in ${packageSwiftResult.subdir || 'root'}`);
        const m = packageSwiftResult.content.match(/\/\/\s*swift-tools-version\s*:?\s*(\d+\.\d+)/);
        if (m) swiftRequired = m[1];
    }
    if (!swiftRequired) {
        const swiftVerResult = await findVersionFile(hostWorkspacePath, 'swift');
        if (swiftVerResult.found && swiftVerResult.file === '.swift-version') {
            swiftRequired = swiftVerResult.content.trim().replace(/^v/, '');
        }
    }
    if (!swiftRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'swift');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^swift\s+(\S+)/m);
            if (m) swiftRequired = m[1];
        }
    }
    if (!swiftRequired) return { required: null, current: null, installed: false };

    const current = await execGuest('swift --version 2>/dev/null | head -1', 10000);
    const curVer = current.stdout?.match(/Swift\s+(\d+\.\d+(?:\.\d+)?)/)?.[1] || null;
    if (!curVer || !versionSatisfies(curVer, swiftRequired)) {
        log(`swift ${curVer || 'missing'} < required ${swiftRequired}: installing via swiftly (CN mirror)`);
        const installCmd = `export SWIFTLY_HOME_DIR="/usr/local/swiftly"; export PATH="${SWIFTLY_HOME_DIR}/bin:$PATH"; ` +
            `curl -fsSL https://swiftly.swiftlang.org/install.sh | bash -s -- --assume-yes && ` +
            `source "${SWIFTLY_HOME_DIR}/env.sh" && swiftly install ${swiftRequired} && swift --version && echo "__SWIFT_OK__"`;
        const r = await execGuest(installCmd, 400000);
        return { required: swiftRequired, current: curVer, installed: r.stdout?.includes('__SWIFT_OK__') };
    } else {
        log(`swift ok (${curVer} >= ${swiftRequired})`);
        return { required: swiftRequired, current: curVer, installed: false };
    }
}

/**
 * 确保 Zig 版本
 */
async function ensureZigVersion({ runtime, runtimeRef, workspacePath, hostWorkspacePath, log, execGuest }) {
    let zigRequired = null;
    const buildZigResult = await findVersionFile(hostWorkspacePath, 'zig');
    if (buildZigResult.found && buildZigResult.file === 'build.zig') {
        log(`[ensureGuestRuntimeVersions] build.zig found in ${buildZigResult.subdir || 'root'}`);
    }
    if (!zigRequired) {
        const zigModResult = await findVersionFile(hostWorkspacePath, 'zig');
        if (zigModResult.found && zigModResult.file === 'zig.mod') {
            const m = zigModResult.content.match(/zig\s*=\s*['"]([^'"]+)['"]/);
            if (m) zigRequired = m[1];
        }
    }
    if (!zigRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'zig');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^zig\s+(\S+)/m);
            if (m) zigRequired = m[1];
        }
    }
    if (!zigRequired) return { required: null, current: null, installed: false };

    const current = await execGuest('zig version 2>/dev/null', 10000);
    const curVer = current.stdout?.trim() || null;
    if (!curVer || !versionSatisfies(curVer, zigRequired)) {
        log(`zig ${curVer || 'missing'} < required ${zigRequired}: installing via CN mirror`);
        const installCmd = `curl -fsSL https://ziglang.org/builds/zig-linux-x86_64-${zigRequired}.tar.xz -o /tmp/zig.tar.xz && ` +
            `tar -xf /tmp/zig.tar.xz -C /usr/local --strip-components=1 && zig version && echo "__ZIG_OK__"`;
        const r = await execGuest(installCmd, 300000);
        return { required: zigRequired, current: curVer, installed: r.stdout?.includes('__ZIG_OK__') };
    } else {
        log(`zig ok (${curVer} >= ${zigRequired})`);
        return { required: zigRequired, current: curVer, installed: false };
    }
}

/**
 * 统一运行时版本预装：Node / Python / Rust / Java / Go / PHP / .NET / Ruby / C/C++ / Swift / Zig。
 * 读取宿主项目的版本锁定文件，比对沙箱现有版本，不满足时从 CN 镜像下载安装。
 * 与 ensureGuestGoToolchain 同理：在 verify agent 之前确定性完成，避免 agent 试错。
 * 支持多目录项目：在根目录及常见子目录(server/, apps/, packages/, api/, backend/)中搜索版本文件。
 */
async function ensureGuestRuntimeVersions({ runtimeRef, workspacePath, hostWorkspacePath, onLog }) {
    const runtime = getRuntime();
    const log = (m) => { if (onLog) onLog(m); };
    const PATH_PREFIX = 'export PATH="/usr/local/bin:$PATH"; ';
    const results = { node: null, python: null, rust: null, java: null, go: null, php: null, dotnet: null, ruby: null, cpp: null, swift: null, zig: null };
    log(`[ensureGuestRuntimeVersions] START hostWorkspacePath=${hostWorkspacePath}`);

    if (!hostWorkspacePath) {
        log(`[ensureGuestRuntimeVersions] END: hostWorkspacePath not provided`);
        return results;
    }

    const execGuest = async (cmd, timeoutMs = 30000) => {
        try {
            const r = await runtime.exec.exec('sh', ['-c', `${PATH_PREFIX}${cmd}`], {}, { runtimeRef, cwd: workspacePath, timeoutMs });
            return { ok: true, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
        } catch (e) {
            return { ok: false, error: String(e.message || e) };
        }
    };

    // ============ 1) Node.js ============
    // 版本来源：package.json engines.node / .nvmrc / .node-version / .tool-versions
    let nodeRequired = null;
    const pkgJsonResult = await findVersionFile(hostWorkspacePath, 'node');
    if (pkgJsonResult.found && pkgJsonResult.file === 'package.json') {
        log(`[ensureGuestRuntimeVersions] package.json found in ${pkgJsonResult.subdir || 'root'}`);
        try {
            const pkg = JSON.parse(pkgJsonResult.content);
            nodeRequired = pkg?.engines?.node || null;
        } catch { }
    }
    if (!nodeRequired) {
        const nvmrcResult = await findVersionFile(hostWorkspacePath, 'node');
        if (nvmrcResult.found && (nvmrcResult.file === '.nvmrc' || nvmrcResult.file === '.node-version')) {
            log(`[ensureGuestRuntimeVersions] ${nvmrcResult.file} found in ${nvmrcResult.subdir || 'root'}`);
            nodeRequired = nvmrcResult.content.trim().replace(/^v/, '');
        }
    }
    if (!nodeRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'node');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^nodejs\s+(\S+)/m);
            if (m) nodeRequired = m[1].replace(/^v/, '');
        }
    }
    if (nodeRequired) {
        const current = await execGuest('node --version 2>/dev/null || echo NO_NODE', 10000);
        const curVer = current.stdout?.match(/v?(\d+\.\d+\.\d+)/)?.[1] || null;
        if (!curVer || !versionSatisfies(curVer, nodeRequired)) {
            log(`node ${curVer || 'missing'} < required ${nodeRequired}: installing via nvm (npmmirror)`);
            // 使用 nvm + npmmirror 镜像（~2-3 分钟）
            const installCmd = `export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node; ` +
                `if [ ! -s "$HOME/.nvm/nvm.sh" ]; then curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash; fi; ` +
                `source "$HOME/.nvm/nvm.sh"; nvm install ${nodeRequired} && nvm use ${nodeRequired} && nvm alias default ${nodeRequired} && node --version && echo "__NODE_OK__"`;
            const r = await execGuest(installCmd, 300000);
            results.node = { required: nodeRequired, current: curVer, installed: r.stdout?.includes('__NODE_OK__') };
        } else {
            log(`node ok (${curVer} >= ${nodeRequired})`);
            results.node = { required: nodeRequired, current: curVer, installed: false };
        }
    }

    // ============ 2) Python ============
    // 版本来源：pyproject.toml [project] requires-python / .python-version / .tool-versions
    let pythonRequired = null;
    const pyprojectResult = await findVersionFile(hostWorkspacePath, 'python');
    if (pyprojectResult.found && pyprojectResult.file === 'pyproject.toml') {
        log(`[ensureGuestRuntimeVersions] pyproject.toml found in ${pyprojectResult.subdir || 'root'}`);
        // requires-python = ">=3.11" 或 "==3.12.*" 等
        const m = pyprojectResult.content.match(/requires-python\s*=\s*['"]([^'"]+)['"]/);
        if (m) pythonRequired = m[1].replace(/^[<>=~^!]+/, '').replace(/\*$/, '').trim();
    }
    if (!pythonRequired) {
        const pyVerResult = await findVersionFile(hostWorkspacePath, 'python');
        if (pyVerResult.found && pyVerResult.file === '.python-version') {
            pythonRequired = pyVerResult.content.trim().replace(/^v/, '');
        }
    }
    if (!pythonRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'python');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^python\s+(\S+)/m);
            if (m) pythonRequired = m[1];
        }
    }
    if (pythonRequired) {
        const current = await execGuest('python3 --version 2>/dev/null || echo NO_PYTHON', 10000);
        const curVer = current.stdout?.match(/Python\s+(\d+\.\d+\.\d+)/)?.[1] || null;
        if (!curVer || !versionSatisfies(curVer, pythonRequired)) {
            log(`python ${curVer || 'missing'} < required ${pythonRequired}: installing via apt (debian backports)`);
            // 优先尝试 apt 安装特定版本（debian bookworm backports 有 3.11, 3.12）
            const majorMinor = pythonRequired.split('.').slice(0, 2).join('.');
            const installCmd = `apt-get update -qq && apt-get install -y -t bookworm-backports python3.${majorMinor.split('.')[1]} python3.${majorMinor.split('.')[1]}-venv python3.${majorMinor.split('.')[1]}-dev 2>/dev/null || ` +
                `apt-get install -y python3 python3-venv python3-dev && echo "__PYTHON_OK__"`;
            const r = await execGuest(installCmd, 300000);
            results.python = { required: pythonRequired, current: curVer, installed: r.stdout?.includes('__PYTHON_OK__') };
        } else {
            log(`python ok (${curVer} >= ${pythonRequired})`);
            results.python = { required: pythonRequired, current: curVer, installed: false };
        }
    }

    // ============ 3) Rust ============
    // 版本来源：rust-toolchain.toml / Cargo.toml [package] rust-version / .tool-versions
    let rustRequired = null;
    const rustToolchainResult = await findVersionFile(hostWorkspacePath, 'rust');
    if (rustToolchainResult.found && (rustToolchainResult.file === 'rust-toolchain.toml' || rustToolchainResult.file === 'rust-toolchain')) {
        log(`[ensureGuestRuntimeVersions] ${rustToolchainResult.file} found in ${rustToolchainResult.subdir || 'root'}`);
        const m = rustToolchainResult.content.match(/channel\s*=\s*['"]([^'"]+)['"]/) || rustToolchainResult.content.match(/^(\d+\.\d+\.\d+)/m);
        if (m) rustRequired = m[1];
    }
    if (!rustRequired) {
        const cargoTomlResult = await findVersionFile(hostWorkspacePath, 'rust');
        if (cargoTomlResult.found && cargoTomlResult.file === 'Cargo.toml') {
            log(`[ensureGuestRuntimeVersions] Cargo.toml found in ${cargoTomlResult.subdir || 'root'}`);
            const m = cargoTomlResult.content.match(/rust-version\s*=\s*['"]([^'"]+)['"]/);
            if (m) rustRequired = m[1];
        }
    }
    if (!rustRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'rust');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^rust\s+(\S+)/m);
            if (m) rustRequired = m[1];
        }
    }
    if (rustRequired) {
        const current = await execGuest('rustc --version 2>/dev/null || echo NO_RUST', 10000);
        const curVer = current.stdout?.match(/rustc\s+(\d+\.\d+\.\d+)/)?.[1] || null;
        if (!curVer || !versionSatisfies(curVer, rustRequired)) {
            log(`rust ${curVer || 'missing'} < required ${rustRequired}: installing via rustup (rsproxy.cn)`);
            // rustup + rsproxy.cn 镜像（~3-5 分钟）
            const installCmd = `export RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup; export RUSTUP_DIST_SERVER=https://rsproxy.cn; ` +
                `if [ ! -s "$HOME/.cargo/env" ]; then curl --proto '=https' --tlsv1.2 -fsSL https://rsproxy.cn/rustup-init.sh | sh -s -- -y --default-toolchain ${rustRequired}; fi; ` +
                `source "$HOME/.cargo/env"; rustup default ${rustRequired} && rustc --version && echo "__RUST_OK__"`;
            const r = await execGuest(installCmd, 400000);
            results.rust = { required: rustRequired, current: curVer, installed: r.stdout?.includes('__RUST_OK__') };
        } else {
            log(`rust ok (${curVer} >= ${rustRequired})`);
            results.rust = { required: rustRequired, current: curVer, installed: false };
        }
    }

    // ============ 4) Java (JVM) ============
    // 版本来源：pom.xml <java.version> / build.gradle toolchain / .tool-versions
    let javaRequired = null;
    const pomXmlResult = await findVersionFile(hostWorkspacePath, 'java');
    if (pomXmlResult.found && pomXmlResult.file === 'pom.xml') {
        log(`[ensureGuestRuntimeVersions] pom.xml found in ${pomXmlResult.subdir || 'root'}`);
        const m = pomXmlResult.content.match(/<java\.version>([^<]+)<\/java\.version>/) || pomXmlResult.content.match(/<maven\.compiler\.release>([^<]+)<\/maven\.compiler\.release>/);
        if (m) javaRequired = m[1];
    }
    if (!javaRequired) {
        const gradleResult = await findVersionFile(hostWorkspacePath, 'java');
        if (gradleResult.found && (gradleResult.file === 'build.gradle' || gradleResult.file === 'build.gradle.kts')) {
            log(`[ensureGuestRuntimeVersions] ${gradleResult.file} found in ${gradleResult.subdir || 'root'}`);
            const m = gradleResult.content.match(/java\.toolchain\s+languageVersion\s*=\s*(\d+)/) || gradleResult.content.match(/sourceCompatibility\s*=\s*(\d+)/);
            if (m) javaRequired = m[1];
        }
    }
    if (!javaRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'java');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^java\s+(\S+)/m);
            if (m) javaRequired = m[1];
        }
    }
    if (javaRequired) {
        const current = await execGuest('java -version 2>&1 | head -1', 10000);
        const curVer = current.stdout?.match(/version\s+"(\d+)(?:\.\d+)?/)?.[1] || current.stderr?.match(/version\s+"(\d+)(?:\.\d+)?/)?.[1] || null;
        if (!curVer || Number(curVer) < Number(javaRequired)) {
            log(`java ${curVer || 'missing'} < required ${javaRequired}: installing via apt (adoptium/temurin mirror)`);
            // 使用 apt 安装指定版本（adoptium 仓库，或默认 default-jdk）
            const installCmd = `apt-get update -qq && apt-get install -y wget gpg && ` +
                `wget -qO- https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor > /usr/share/keyrings/adoptium.gpg && ` +
                `echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" > /etc/apt/sources.list.d/adoptium.list && ` +
                `apt-get update -qq && apt-get install -y temurin-${javaRequired}-jdk && java -version && echo "__JAVA_OK__"`;
            const r = await execGuest(installCmd, 400000);
            results.java = { required: javaRequired, current: curVer, installed: r.stdout?.includes('__JAVA_OK__') };
        } else {
            log(`java ok (${curVer} >= ${javaRequired})`);
            results.java = { required: javaRequired, current: curVer, installed: false };
        }
    }

    // ============ 6) PHP ============
    // 版本来源：composer.json config.platform.php / .php-version / .tool-versions
    let phpRequired = null;
    const composerResult = await findVersionFile(hostWorkspacePath, 'php');
    if (composerResult.found && composerResult.file === 'composer.json') {
        log(`[ensureGuestRuntimeVersions] composer.json found in ${composerResult.subdir || 'root'}`);
        try {
            const composer = JSON.parse(composerResult.content);
            phpRequired = composer?.config?.platform?.php || composer?.require?.php || null;
            if (phpRequired) phpRequired = phpRequired.replace(/^[<>=~^!]+/, '').replace(/\*$/, '').trim();
        } catch { }
    }
    if (!phpRequired) {
        const phpVerResult = await findVersionFile(hostWorkspacePath, 'php');
        if (phpVerResult.found && phpVerResult.file === '.php-version') {
            phpRequired = phpVerResult.content.trim().replace(/^v/, '');
        }
    }
    if (!phpRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'php');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^php\s+(\S+)/m);
            if (m) phpRequired = m[1];
        }
    }
    if (phpRequired) {
        const current = await execGuest('php --version 2>/dev/null | head -1', 10000);
        const curVer = current.stdout?.match(/PHP\s+(\d+\.\d+\.\d+)/)?.[1] || null;
        if (!curVer || !versionSatisfies(curVer, phpRequired)) {
            log(`php ${curVer || 'missing'} < required ${phpRequired}: installing via apt (ondrej PPA)`);
            const installCmd = `apt-get update -qq && apt-get install -y software-properties-common && ` +
                `add-apt-repository -y ppa:ondrej/php && apt-get update -qq && ` +
                `apt-get install -y php${phpRequired.replace('.', '')} php${phpRequired.replace('.', '')}-cli php${phpRequired.replace('.', '')}-common && php --version && echo "__PHP_OK__"`;
            const r = await execGuest(installCmd, 300000);
            results.php = { required: phpRequired, current: curVer, installed: r.stdout?.includes('__PHP_OK__') };
        } else {
            log(`php ok (${curVer} >= ${phpRequired})`);
            results.php = { required: phpRequired, current: curVer, installed: false };
        }
    }

    // ============ 7) .NET ============
    // 版本来源：global.json sdk.version / .tool-versions / Directory.Build.props
    let dotnetRequired = null;
    const globalJsonResult = await findVersionFile(hostWorkspacePath, 'dotnet');
    if (globalJsonResult.found && globalJsonResult.file === 'global.json') {
        log(`[ensureGuestRuntimeVersions] global.json found in ${globalJsonResult.subdir || 'root'}`);
        try {
            const globalJson = JSON.parse(globalJsonResult.content);
            dotnetRequired = globalJson?.sdk?.version || null;
        } catch { }
    }
    if (!dotnetRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'dotnet');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^dotnet\s+(\S+)/m);
            if (m) dotnetRequired = m[1];
        }
    }
    if (!dotnetRequired) {
        const dirBuildResult = await findVersionFile(hostWorkspacePath, 'dotnet');
        if (dirBuildResult.found && dirBuildResult.file === 'Directory.Build.props') {
            const m = dirBuildResult.content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/) || dirBuildResult.content.match(/<NETCoreVersion>([^<]+)<\/NETCoreVersion>/);
            if (m) dotnetRequired = m[1].replace('net', '').replace('core', '');
        }
    }
    if (dotnetRequired) {
        const current = await execGuest('dotnet --version 2>/dev/null', 10000);
        const curVer = current.stdout?.trim() || null;
        if (!curVer || !versionSatisfies(curVer, dotnetRequired)) {
            log(`dotnet ${curVer || 'missing'} < required ${dotnetRequired}: installing via Microsoft mirror`);
            const installCmd = `wget -q https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -O packages-microsoft-prod.deb && ` +
                `dpkg -i packages-microsoft-prod.deb && apt-get update -qq && ` +
                `apt-get install -y dotnet-sdk-${dotnetRequired} && dotnet --version && echo "__DOTNET_OK__"`;
            const r = await execGuest(installCmd, 300000);
            results.dotnet = { required: dotnetRequired, current: curVer, installed: r.stdout?.includes('__DOTNET_OK__') };
        } else {
            log(`dotnet ok (${curVer} >= ${dotnetRequired})`);
            results.dotnet = { required: dotnetRequired, current: curVer, installed: false };
        }
    }

    // ============ 8) Ruby ============
    // 版本来源：Gemfile ruby 'X.Y.Z' / .ruby-version / .tool-versions
    let rubyRequired = null;
    const gemfileResult = await findVersionFile(hostWorkspacePath, 'ruby');
    if (gemfileResult.found && gemfileResult.file === 'Gemfile') {
        log(`[ensureGuestRuntimeVersions] Gemfile found in ${gemfileResult.subdir || 'root'}`);
        const m = gemfileResult.content.match(/ruby\s+['"]([^'"]+)['"]/);
        if (m) rubyRequired = m[1];
    }
    if (!rubyRequired) {
        const rubyVerResult = await findVersionFile(hostWorkspacePath, 'ruby');
        if (rubyVerResult.found && rubyVerResult.file === '.ruby-version') {
            rubyRequired = rubyVerResult.content.trim().replace(/^v/, '');
        }
    }
    if (!rubyRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'ruby');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^ruby\s+(\S+)/m);
            if (m) rubyRequired = m[1];
        }
    }
    if (rubyRequired) {
        const current = await execGuest('ruby --version 2>/dev/null', 10000);
        const curVer = current.stdout?.match(/ruby\s+(\d+\.\d+\.\d+)/)?.[1] || null;
        if (!curVer || !versionSatisfies(curVer, rubyRequired)) {
            log(`ruby ${curVer || 'missing'} < required ${rubyRequired}: installing via apt (brightbox PPA)`);
            const installCmd = `apt-get update -qq && apt-get install -y software-properties-common && ` +
                `add-apt-repository -y ppa:brightbox/ruby-ng && apt-get update -qq && ` +
                `apt-get install -y ruby${rubyRequired.replace('.', '')} ruby${rubyRequired.replace('.', '')}-dev && ruby --version && echo "__RUBY_OK__"`;
            const r = await execGuest(installCmd, 300000);
            results.ruby = { required: rubyRequired, current: curVer, installed: r.stdout?.includes('__RUBY_OK__') };
        } else {
            log(`ruby ok (${curVer} >= ${rubyRequired})`);
            results.ruby = { required: rubyRequired, current: curVer, installed: false };
        }
    }

    // ============ 9) C/C++ ============
    // 版本来源：CMakeLists.txt cmake_minimum_required
    // 条件性（非强制）：只有项目真实声明 C++ 构建（命中 CMakeLists.txt）才装工具链，
    // 避免无关项目为 gcc/cmake 白花几分钟（AgentHarness 等纯 Go/Node 项目实测每次
    // 新沙箱烧 ~4 分钟）。native 编译依赖场景由 runPlatformInstall 的 detectNativeDeps 兜底。
    let cppRequired = null;
    const cmakeResult = await findVersionFile(hostWorkspacePath, 'cpp');
    if (cmakeResult.found && cmakeResult.file === 'CMakeLists.txt') {
        log(`[ensureGuestRuntimeVersions] CMakeLists.txt found in ${cmakeResult.subdir || 'root'}`);
        const m = cmakeResult.content.match(/cmake_minimum_required\s*\(\s*VERSION\s+([^)\s]+)/i);
        if (m) cppRequired = m[1];
    }
    const cppCurrent = await execGuest('gcc --version 2>/dev/null | head -1', 10000);
    const hasGcc = cppCurrent.stdout?.includes('gcc') || false;
    const hasCmake = (await execGuest('cmake --version 2>/dev/null | head -1', 10000)).stdout?.includes('cmake') || false;
    if (cppRequired && (!hasGcc || !hasCmake)) {
        log(`c/cpp toolchain missing (gcc=${hasGcc} cmake=${hasCmake}): installing build-essential + cmake (CMakeLists.txt requires C++)`);
        const installCmd = `apt-get update -qq && apt-get install -y build-essential cmake pkg-config && echo "__CPP_OK__"`;
        const r = await execGuest(installCmd, 300000);
        results.cpp = { required: cppRequired, current: hasGcc ? 'ok' : 'missing', installed: r.stdout?.includes('__CPP_OK__') };
    } else {
        results.cpp = { required: cppRequired || 'system', current: hasGcc ? 'ok' : 'missing', installed: false };
    }

    // ============ 10) Swift ============
    // 版本来源：Package.swift // swift-tools-version:X.Y / .swift-version / .tool-versions
    let swiftRequired = null;
    const packageSwiftResult = await findVersionFile(hostWorkspacePath, 'swift');
    if (packageSwiftResult.found && packageSwiftResult.file === 'Package.swift') {
        log(`[ensureGuestRuntimeVersions] Package.swift found in ${packageSwiftResult.subdir || 'root'}`);
        const m = packageSwiftResult.content.match(/\/\/\s*swift-tools-version\s*:?\s*(\d+\.\d+)/);
        if (m) swiftRequired = m[1];
    }
    if (!swiftRequired) {
        const swiftVerResult = await findVersionFile(hostWorkspacePath, 'swift');
        if (swiftVerResult.found && swiftVerResult.file === '.swift-version') {
            swiftRequired = swiftVerResult.content.trim().replace(/^v/, '');
        }
    }
    if (!swiftRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'swift');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^swift\s+(\S+)/m);
            if (m) swiftRequired = m[1];
        }
    }
    if (swiftRequired) {
        const current = await execGuest('swift --version 2>/dev/null | head -1', 10000);
        const curVer = current.stdout?.match(/Swift\s+(\d+\.\d+(?:\.\d+)?)/)?.[1] || null;
        if (!curVer || !versionSatisfies(curVer, swiftRequired)) {
            log(`swift ${curVer || 'missing'} < required ${swiftRequired}: installing via swiftly (CN mirror)`);
            const installCmd = `export SWIFTLY_HOME_DIR="/usr/local/swiftly"; export PATH="${SWIFTLY_HOME_DIR}/bin:$PATH"; ` +
                `curl -fsSL https://swiftly.swiftlang.org/install.sh | bash -s -- --assume-yes && ` +
                `source "${SWIFTLY_HOME_DIR}/env.sh" && swiftly install ${swiftRequired} && swift --version && echo "__SWIFT_OK__"`;
            const r = await execGuest(installCmd, 400000);
            results.swift = { required: swiftRequired, current: curVer, installed: r.stdout?.includes('__SWIFT_OK__') };
        } else {
            log(`swift ok (${curVer} >= ${swiftRequired})`);
            results.swift = { required: swiftRequired, current: curVer, installed: false };
        }
    }

    // ============ 11) Zig ============
    // 版本来源：build.zig / zig.mod / .tool-versions
    let zigRequired = null;
    const buildZigResult = await findVersionFile(hostWorkspacePath, 'zig');
    if (buildZigResult.found && buildZigResult.file === 'build.zig') {
        log(`[ensureGuestRuntimeVersions] build.zig found in ${buildZigResult.subdir || 'root'}`);
        // build.zig 通常不硬编码版本，依赖 zig.mod
    }
    if (!zigRequired) {
        const zigModResult = await findVersionFile(hostWorkspacePath, 'zig');
        if (zigModResult.found && zigModResult.file === 'zig.mod') {
            // zig.mod 可能包含版本信息
            const m = zigModResult.content.match(/zig\s*=\s*['"]([^'"]+)['"]/);
            if (m) zigRequired = m[1];
        }
    }
    if (!zigRequired) {
        const toolVersionsResult = await findVersionFile(hostWorkspacePath, 'zig');
        if (toolVersionsResult.found && toolVersionsResult.file === '.tool-versions') {
            const m = toolVersionsResult.content.match(/^zig\s+(\S+)/m);
            if (m) zigRequired = m[1];
        }
    }
    if (zigRequired) {
        const current = await execGuest('zig version 2>/dev/null', 10000);
        const curVer = current.stdout?.trim() || null;
        if (!curVer || !versionSatisfies(curVer, zigRequired)) {
            log(`zig ${curVer || 'missing'} < required ${zigRequired}: installing via CN mirror`);
            const installCmd = `curl -fsSL https://ziglang.org/builds/zig-linux-x86_64-${zigRequired}.tar.xz -o /tmp/zig.tar.xz && ` +
                `tar -xf /tmp/zig.tar.xz -C /usr/local --strip-components=1 && zig version && echo "__ZIG_OK__"`;
            const r = await execGuest(installCmd, 300000);
            results.zig = { required: zigRequired, current: curVer, installed: r.stdout?.includes('__ZIG_OK__') };
        } else {
            log(`zig ok (${curVer} >= ${zigRequired})`);
            results.zig = { required: zigRequired, current: curVer, installed: false };
        }
    }

    log(`[ensureGuestRuntimeVersions] END results=${JSON.stringify(results)}`);
    return results;
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

// ── 通用：宿主侧 DB 配置发现（与 DB 类型无关）──
// 读 spring/.env/docker-compose → dbAdapt 解析出 app 自身的 {host,port,db,user,password}。
// 目的：把"平台预配"从 postgres 单点泛化为"按 app 配置适配任意 DB 类型"。
const DB_CONFIG_FILE_RE = /(^|\/)(application[\w.-]*\.(ya?ml|properties)|bootstrap[\w.-]*\.(ya?ml|properties)|\.env(\..+)?|[\w.-]+\.env|docker-compose[\w.-]*\.ya?ml)$/i;
const DB_SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.next', 'out', 'coverage', '.cache', '.venv', 'venv']);

function _walkFiles(root, { depth = 5, maxFiles = 60, match, collect }) {
    const out = [];
    if (!root || !fs.existsSync(root)) return out;
    const walk = (dir, d) => {
        if (d > depth || out.length >= maxFiles) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
            if (out.length >= maxFiles) return;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (DB_SCAN_SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
                walk(full, d + 1);
            } else if (match(ent.name)) {
                collect(full, ent.name, out);
            }
        }
    };
    walk(root, 0);
    return out;
}

function collectHostDbConfigFiles(hostWorkspacePath) {
    return _walkFiles(hostWorkspacePath, {
        match: (n) => DB_CONFIG_FILE_RE.test(n),
        collect: (full, name, out) => {
            try {
                if (fs.statSync(full).size > 512 * 1024) return; // 跳过超大文件
                out.push({ path: path.relative(hostWorkspacePath, full), text: fs.readFileSync(full, 'utf8') });
            } catch { /* ignore */ }
        },
    });
}

function collectHostSqlFiles(hostWorkspacePath) {
    return _walkFiles(hostWorkspacePath, {
        maxFiles: 40,
        match: (n) => /\.sql$/i.test(n),
        collect: (full, name, out) => out.push(path.relative(hostWorkspacePath, full)),
    });
}

// preview DB 模式：默认 local（沙箱内起库并本地化 host）；remote 需显式开启
// （项目级 .xensemble/preview.json 的 dbMode > 平台级 env/setting）。不硬编码。
async function resolvePreviewDbMode(hostWorkspacePath) {
    try {
        const p = path.join(hostWorkspacePath || '', '.xensemble', 'preview.json');
        if (fs.existsSync(p)) {
            const v = JSON.parse(fs.readFileSync(p, 'utf8'))?.dbMode;
            if (v === 'local' || v === 'remote') return v;
        }
    } catch { /* ignore */ }
    const env = String(process.env.XENSEMBLE_PREVIEW_DB_MODE || '').trim().toLowerCase();
    if (env === 'local' || env === 'remote') return env;
    try {
        const v = await require('../admin/PlatformSettings').get('preview_db_mode');
        if (v === 'local' || v === 'remote') return v;
    } catch { /* ignore */ }
    return 'local';
}

// 通用"应用数据库预配"：按 dialect 用 app 自身凭据建库/建用户 + 导 schema，返回本地 DSN。
// 与具体 DB 类型无关（新增类型只需在 dbAdapt.DIALECTS 补一档）。
async function provisionAppDatabase({ runtime, runtimeRef, workspacePath, dialect, conn, schemaFiles, onLog }) {
    const log = (m) => { if (onLog) onLog(m); };
    const d = dbAdapt.DIALECTS[dialect];
    if (!d) return { adapted: false };
    const c = dbAdapt.fillDefaults(dialect, conn || {});
    const localized = dbAdapt.isRemoteHost(c.host);
    const dsn = d.dsn({ host: '127.0.0.1', port: c.port, db: c.database, user: c.user, password: c.password });
    let provisioned = false;
    const cmd = dbAdapt.buildProvisionCommand(dialect, c);
    if (cmd) {
        try {
            const r = await runtime.exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 90000 });
            // 解析命令内的真实退出码（不能用 r.exitCode —— 命令末尾有 echo，恒 0）
            const m = String(r.stdout || '').match(/__DBPROV_EXIT__=(-?\d+)/);
            provisioned = (m ? Number(m[1]) : r.exitCode) === 0;
            log(`db ${dialect} provision(app-adapted): ${provisioned ? 'ok' : 'FAILED'} db=${c.database} user=${c.user}${localized ? ` (app host ${c.host} → 127.0.0.1)` : ''}${provisioned ? '' : ` out=${String(r.stdout || '').replace(/__DBPROV_EXIT__=-?\d+/, '').trim().slice(-200)}`}`);
        } catch (e) {
            log(`db ${dialect} provision error: ${String(e.message || e).slice(0, 160)}`);
        }
    }
    let schemaImported = 0;
    if (provisioned) {
        for (const rel of (schemaFiles || [])) {
            const importCmd = dbAdapt.buildSchemaImportCommand(dialect, c, rel);
            if (!importCmd) continue;
            try {
                const r = await runtime.exec.exec('sh', ['-c', importCmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 120000 });
                const m = String(r.stdout || '').match(/__DBIMP_EXIT__=(-?\d+)/);
                if ((m ? Number(m[1]) : r.exitCode) === 0) schemaImported++;
            } catch { /* ignore */ }
        }
        if (schemaImported) log(`db ${dialect}: imported ${schemaImported} schema file(s)`);
        else if ((schemaFiles || []).length) log(`db ${dialect}: schema import produced no success (${(schemaFiles || []).length} file(s))`);
    }
    return { adapted: true, database: c.database, user: c.user, password: c.password, host: '127.0.0.1', port: c.port, dsn, localized, schemaImported };
}

// 沙箱内镜像源系统级配置（幂等）：apt / npm+pnpm / pip / go / cargo / maven 全部指向国内镜像。
// 目的：guest 出国带宽受限，官方源安装动辄数分钟（go tarball 4min+、apt 大包慢、npm 全量
// workspace install 更慢），国内镜像通常 1 分钟内完成，是首次部署超时的主要性能杠杆。
// 配置全部写入持久文件而非环境变量——verify 的 run_shell 是每次全新 `sh -c`，不读 profile，
// 文件级配置（go env -w / .npmrc / pip.conf / cargo config / maven settings）对 agent 与
// plan 命令透明生效。任何一步失败都不阻断部署（best-effort，退回官方源只是慢）。
async function configureGuestMirrors(runtimeRef, workspacePath, onLog) {
    const runtime = getRuntime();
    // npm 私有 scope registry 注入（平台级配置，通用）：XENSEMBLE_NPM_SCOPE_REGISTRIES
    // 格式 `scope=url;scope2=url2`（如 @schkzy=https://npm-registry.schkzy.com/）。
    // 沙箱默认源 npmmirror 不含私有包，私有 scope 必须指向私有源，否则 pnpm/npm install
    // 报 ERR_PNPM_FETCH_404（server-manage-frontend 实测 verify 60 轮全耗在绕私有包）。
    // 只对声明的 scope 追加 :registry，不改变默认源、不强制任何项目；任何私有源配一行即可。
    const scopeShell = String(process.env.XENSEMBLE_NPM_SCOPE_REGISTRIES || '')
        .split(';').map((kv) => kv.trim()).filter(Boolean)
        .map((kv) => {
            const idx = kv.indexOf('=');
            if (idx <= 0) return '';
            const scope = kv.slice(0, idx).trim();
            const url = kv.slice(idx + 1).trim();
            return (scope && url) ? `printf '%s\\n' '${scope}:registry=${url}' >> /root/.npmrc 2>/dev/null || true` : '';
        })
        .filter(Boolean)
        .join('\n');
    const script = `
# 1) apt 源：deb.debian.org/security.debian.org → mirrors.aliyun.com（兼容传统 list 与 bookworm deb822）
if [ -f /etc/apt/sources.list ]; then
  grep -q mirrors.aliyun.com /etc/apt/sources.list 2>/dev/null || \\
    sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com/debian|g; s|https://deb.debian.org|https://mirrors.aliyun.com/debian|g; s|http://security.debian.org|https://mirrors.aliyun.com/debian-security|g; s|https://security.debian.org|https://mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list 2>/dev/null || true
fi
for f in /etc/apt/sources.list.d/*.sources; do
  [ -f "$f" ] || continue
  grep -q mirrors.aliyun.com "$f" 2>/dev/null || \\
    sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com/debian|g; s|https://deb.debian.org|https://mirrors.aliyun.com/debian|g; s|http://security.debian.org|https://mirrors.aliyun.com/debian-security|g; s|https://security.debian.org|https://mirrors.aliyun.com/debian-security|g' "$f" 2>/dev/null || true
done
# 2) npm / pnpm registry
printf 'registry=https://registry.npmmirror.com\\n' > /root/.npmrc 2>/dev/null || true
# electron 二进制默认从 github releases 下载（国内网络卡死，实测 AgentHarness monorepo
# 的 apps/desktop 使 pnpm install 卡满 20 分钟超时）；.npmrc 的 electron_mirror 会被
# electron/@electron/get 读取，走 npmmirror 镜像
printf 'electron_mirror=https://npmmirror.com/mirrors/electron/\\n' >> /root/.npmrc 2>/dev/null || true
# 平台级 npm 私有 scope registry（XENSEMBLE_NPM_SCOPE_REGISTRIES，格式 scope=url;scope2=url2）：
# 向 /root/.npmrc 追加 <scope>:registry=<url>，pnpm/npm 安装私有 scope 包时走私有源，
# 否则私有包（如 @schkzy/*）会去 npmmirror 取 → 404。此前 scopeShell 只计算未写入脚本（死代码）。
${scopeShell}
# pnpm 预装：base 镜像无 pnpm 二进制，corepack 按需下载走官方源常中断（缓存残缺），
# 且 corepack prepare --activate 在此镜像上激活行为异常（实测只写缓存不铺 shim，
# pnpm 仍 not found）。确定性方案：npm 全局装 pnpm 并显式 --prefix /usr/local——
# 本镜像 npm 默认 prefix=/usr（bin 落 /usr/bin，PATH 优先 /usr/local/bin 的 corepack
# shim 会盖住），--prefix /usr/local 强制落 /usr/local/bin（PATH 最前），实测可用。
if ! pnpm -v >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  npm install -g pnpm@9.15.9 --prefix /usr/local --no-audit --no-fund --registry=https://registry.npmmirror.com >/dev/null 2>&1 || true
fi
# pnpm 专用配置：corepack pnpm 可能不读取 /root/.npmrc，显式写 pnpm config
if command -v pnpm >/dev/null 2>&1 || command -v corepack >/dev/null 2>&1; then
  pnpm config set registry https://registry.npmmirror.com --global 2>/dev/null || true
fi
# 3) pip 全局源（/etc/pip.conf）
printf '[global]\\nindex-url = https://pypi.tuna.tsinghua.edu.cn/simple\\ntrusted-host = pypi.tuna.tsinghua.edu.cn\\n' > /etc/pip.conf 2>/dev/null || true
# 4) Go modules 代理（go env -w 写持久配置；go 未装则跳过，装完后可再跑一次本配置）
if command -v go >/dev/null 2>&1; then
  go env -w GOPROXY=https://goproxy.cn,direct 2>/dev/null || true
  go env -w GOSUMDB=sum.golang.google.cn 2>/dev/null || true
fi
# 5) cargo 镜像（rsproxy sparse index；仅 cargo 已存在时）
if command -v cargo >/dev/null 2>&1 && [ ! -f /root/.cargo/config.toml ]; then
  mkdir -p /root/.cargo 2>/dev/null || true
  printf '[source.crates-io]\\nreplace-with = "rsproxy"\\n\\n[source.rsproxy]\\nregistry = "sparse+https://rsproxy.cn/index/"\\n\\n[registries.rsproxy]\\nindex = "sparse+https://rsproxy.cn/index/"\\n' > /root/.cargo/config.toml 2>/dev/null || true
fi
# 6) maven 阿里云镜像（无条件写：mvn 可能 provision 后才装/由 agent 装，先写好 settings.xml
#    装完即生效——否则 Maven 走中央仓库下载依赖极慢，mvn package 打满 600s 超时反复重试，
#    Java 项目 verify 卡死在构建阶段）
if [ ! -f /root/.m2/settings.xml ]; then
  mkdir -p /root/.m2 2>/dev/null || true
  printf '%s\\n' '<settings>' '  <mirrors>' '    <mirror>' '      <id>aliyunmaven</id>' '      <mirrorOf>*</mirrorOf>' '      <url>https://maven.aliyun.com/repository/public</url>' '    </mirror>' '  </mirrors>' '</settings>' > /root/.m2/settings.xml 2>/dev/null || true
fi
# 7) ruby gem 镜像（Gemfile 项目 bundle install 走国内源；.gemrc 持久化，装完 gem 即生效）
if [ ! -f /root/.gemrc ]; then
  printf '%s\\n' '---' ':update_sources: true' ':sources:' '- https://gems.ruby-china.com/' '- https://mirrors.aliyun.com/rubygems/' > /root/.gemrc 2>/dev/null || true
fi
if command -v gem >/dev/null 2>&1; then
  gem sources --remove https://rubygems.org/ 2>/dev/null || true
  gem sources --add https://gems.ruby-china.com/ 2>/dev/null || true
fi
# 8) composer (PHP) packagist 镜像（composer install 走阿里云镜像）
if command -v composer >/dev/null 2>&1; then
  composer config -g repo.packagist composer https://mirrors.aliyun.com/composer/ 2>/dev/null || true
fi
echo MIRRORS_DONE
`;
    try {
        const r = await runtime.exec.exec('sh', ['-c', script], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 });
        if (String(r.stdout || '').includes('MIRRORS_DONE')) {
            onLog?.('guest 镜像源已配置（apt/npm/pip/go/cargo/maven → 国内源）');
        } else {
            onLog?.('guest 镜像源配置未完成（非致命，退回官方源）');
        }
    } catch (e) {
        onLog?.(`guest 镜像源配置失败（非致命）: ${String(e.message || e).slice(0, 120)}`);
    }
}

// 把依赖/构建产物目录写入 workspace 的 .git/info/exclude（幂等、非致命）。
// 必须在 verify agent 执行任何 install 之前完成：node_modules/dist 等装进
// 项目目录后对 git 隐身——git 变更面板不再被上万依赖文件淹没（干扰 + 卡顿）。
// 写在 .git/ 内部，不碰用户工作区文件，也不会被 commit 带走。
// 同时兼容旧 workspace（clone 早于此功能上线的）：每次部署幂等重跑自动补齐。
async function ensureDependencyExcludeInGuest(runtimeRef, workspacePath, onLog) {
    const runtime = getRuntime();
    try {
        const r = await runtime.exec.exec('sh', ['-c', DEPENDENCY_EXCLUDE_SCRIPT], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
        if (String(r.stdout || '').includes('EXCLUDE_OK')) {
            onLog?.('依赖/构建产物已写入 .git/info/exclude（变更面板不再显示依赖文件）');
        } else {
            onLog?.('.git/info/exclude 写入未完成（非致命，变更面板可能显示依赖目录）');
        }
    } catch (e) {
        onLog?.(`.git/info/exclude 写入失败（非致命）: ${String(e.message || e).slice(0, 120)}`);
    }
}

// 系统侧自动 provision PostgreSQL：检测项目是否需要 PG，需要则启动沙箱内 PG，
// 并尝试从配置解析出连接信息后直接建库建用户（幂等），使 verify agent 只需跑 migration。
// k3s 控制面预配（k8s 依赖应用，方案 A 实测可行 2026-09-10）：
// boxlite VM 内容器不能 mount overlay/fuse（guest OCI spec 剔除 CAP_SYS_ADMIN），
// 但 k3s **纯控制面**（--disable-agent）完全不创建容器 → 绕开该限制：
// apiserver/etcd/controller-manager 以普通进程运行，实测 /readyz 正常、CRD 可写。
// gpustack 类应用只需 k8s API 写 Higress 资源（--gateway-mode external），不需要
// 真 Pod 调度 → 该模式完全满足。判定用 apiserver /readyz（无 node 注册是预期）。
async function ensureK3sIfNeeded(runtimeRef, workspacePath, systemDeps) {
    const needs = systemDeps && Array.isArray(systemDeps.services) && systemDeps.services.includes('k3s');
    if (!needs) return { ready: false, reason: 'not needed' };
    const runtime = getRuntime();
    try {
        const readyProbe = '/usr/local/bin/k3s kubectl get --raw /readyz 2>/dev/null | grep -q ok && echo READY || echo NO';
        // 已装且 Ready？（幂等快速路径）
        const chk = await runtime.exec.exec('sh', ['-c',
            'if [ -x /usr/local/bin/k3s ] && ' + readyProbe.replace('/usr/local/bin/k3s kubectl', '/usr/local/bin/k3s kubectl') + '; then echo READY; else echo NO; fi'],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 20000 });
        if (String(chk.stdout || '').includes('READY')) {
            return { ready: true, kubeconfig: '/etc/rancher/k3s/k3s.yaml' };
        }
        // 安装二进制（ghfast.top 加速 github release，实测 200；github 直连兜底）
        console.error('[twoStage] k3s provision: installing k3s binary (control-plane only)...');
        const inst = await runtime.exec.exec('sh', ['-c',
            'mkdir -p /usr/local/bin && '
            + 'curl -sfL --retry 2 -o /usr/local/bin/k3s https://ghfast.top/https://github.com/k3s-io/k3s/releases/download/v1.30.5%2Bk3s1/k3s || curl -sfL --retry 2 -o /usr/local/bin/k3s https://github.com/k3s-io/k3s/releases/download/v1.30.5%2Bk3s1/k3s; '
            + 'chmod +x /usr/local/bin/k3s && /usr/local/bin/k3s --version && echo BINARY_OK'],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 300000 });
        if (!/BINARY_OK/.test(String(inst.stdout || ''))) {
            console.error(`[twoStage] k3s binary download failed: ${String(inst.stdout || '').slice(0, 200)}`);
            return { ready: false, reason: 'k3s binary download failed' };
        }
        // 清掉旧状态（半初始化的 db/token 残留会导致 "failed to normalize server token" fatal）
        await runtime.exec.exec('sh', ['-c',
            'pkill -9 k3s 2>/dev/null; sleep 1; rm -rf /var/lib/rancher/k3s /etc/rancher/k3s /tmp/k3s-cp.log; echo PURGED'],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 });
        // 启动纯控制面：--disable-agent 不创建任何容器（绕开 guest 容器 overlay/fuse
        // mount EPERM 限制）；--snapshotter native 双保险；TRAEFIK/SERVICELB 关闭瘦身。
        await runtime.exec.exec('sh', ['-c',
            'setsid nohup /usr/local/bin/k3s server --disable traefik --disable servicelb --disable-agent --write-kubeconfig-mode 644 --https-listen-port 6443 --snapshotter native > /tmp/k3s-cp.log 2>&1 & echo STARTED'],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 });
        // 等 apiserver Ready（/readyz 返回 ok；控制面冷启动实测 ~40s，给 180s）
        let ready = false;
        for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            const rdy = await runtime.exec.exec('sh', ['-c', readyProbe], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
            if (String(rdy.stdout || '').includes('READY')) { ready = true; break; }
            if (i > 0 && i % 20 === 0) console.error(`[twoStage] k3s provision: waiting for control-plane ready... ${Math.round((i + 1) * 3 / 60 * 10) / 10}min`);
        }
        if (!ready) {
            const diag = await runtime.exec.exec('sh', ['-c',
                'curl -sk -m 5 -o /dev/null -w "readyz:%{http_code}" https://127.0.0.1:6443/readyz; echo; grep -iE "fatal|error" /tmp/k3s-cp.log | tail -5'],
                {}, { runtimeRef, cwd: workspacePath, timeoutMs: 20000 });
            console.error(`[twoStage] k3s provision: control-plane not ready after 180s. diag: ${String(diag.stdout || '').slice(0, 400)}`);
            return { ready: false, reason: 'k3s control-plane not ready' };
        }
        // CRD 写入冒烟：gpustack 只需要 k8s API 写资源，验证创建/删除 namespace 通过
        const smoke = await runtime.exec.exec('sh', ['-c',
            '/usr/local/bin/k3s kubectl create namespace gpustack-smoke >/dev/null 2>&1 && /usr/local/bin/k3s kubectl delete namespace gpustack-smoke >/dev/null 2>&1 && echo SMOKE_OK || echo SMOKE_FAIL'],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 });
        if (!/SMOKE_OK/.test(String(smoke.stdout || ''))) {
            console.error('[twoStage] k3s provision: control-plane up but CRD write smoke failed');
            return { ready: false, reason: 'k3s CRD write failed' };
        }
        // 预注册 Higress CRD（gpustack 启动时用 NetworkingHigressIoV1Api create/edit
        // McpBridge——CRD 未注册会抛 non-404 ApiException → RuntimeError → 启动失败）。
        // 只 apply CRD 定义（纯 YAML，不跑容器——兼容无 agent 控制面）；数据面
        // (envoy) 不装：预览场景不产生真实流量路由。
        const hg = await runtime.exec.exec('sh', ['-c',
            'curl -sfL --retry 2 -o /tmp/higress-crds.yaml https://ghfast.top/https://raw.githubusercontent.com/higress-group/higress/main/helm/core/crds/customresourcedefinitions.gen.yaml || curl -sfL --retry 2 -o /tmp/higress-crds.yaml https://raw.githubusercontent.com/higress-group/higress/main/helm/core/crds/customresourcedefinitions.gen.yaml; '
            + 'grep -q "kind: CustomResourceDefinition" /tmp/higress-crds.yaml && '
            + '/usr/local/bin/k3s kubectl apply -f /tmp/higress-crds.yaml >/dev/null 2>&1 && '
            + '/usr/local/bin/k3s kubectl get crd mcpbridges.networking.higress.io >/dev/null 2>&1 && echo HIGRESS_CRDS_OK || echo HIGRESS_CRDS_FAIL'],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 90000 });
        if (!/HIGRESS_CRDS_OK/.test(String(hg.stdout || ''))) {
            console.error(`[twoStage] k3s provision: Higress CRD registration failed (non-fatal, app can fall back to --gateway-mode disabled): ${String(hg.stdout || '').slice(0, 150)}`);
        } else {
            console.error('[twoStage] k3s provision: Higress CRDs registered (mcpbridge/wasmplugin) — external gateway mode fully usable');
        }
        console.error('[twoStage] k3s control-plane provisioned and Ready (agent-less, CRD write verified)');
        return { ready: true, kubeconfig: '/etc/rancher/k3s/k3s.yaml', higressCrds: /HIGRESS_CRDS_OK/.test(String(hg.stdout || '')) };
    } catch (e) {
        console.error(`[twoStage] k3s provision error (non-fatal): ${e.message?.slice(0, 150)}`);
        return { ready: false, reason: e.message?.slice(0, 120) || 'error' };
    }
}

// 修复已安装 wheel 的 _integrity.json（上游 gpustack/cubex fork 打包 bug：
// build hook 生成的 manifest 没被 hatchling 打进 wheel——pyproject artifacts
// 只列 *.so——装出的包 license 自检必失败 exit 78）。用 hook 相同算法对安装
// 目录的 .so 重算 sha256 写 manifest，然后 import 冒烟。返回 true = 自检通过。
async function repairWheelManifest(runtime, runtimeRef, workspacePath, pkg) {
    try {
        const fix = await runtime.exec.exec('sh', ['-c',
            `python3 - <<'PYEOF'\n`
            + `import hashlib, json, sysconfig\nfrom pathlib import Path\n`
            + `d = Path("/usr/local/lib/python3.11/dist-packages/${pkg}/license")\n`
            + `suffix = sysconfig.get_config_var("EXT_SUFFIX") or ".so"\n`
            + `digests = {}\n`
            + `for so in sorted(d.glob(f"*{suffix}")):\n`
            + `    digests[so.name[: -len(suffix)]] = hashlib.sha256(so.read_bytes()).hexdigest()\n`
            + `if digests:\n`
            + `    (d / "_integrity.json").write_text(json.dumps(digests, indent=2) + "\\n")\n`
            + `    print("MANIFEST_OK", len(digests))\n`
            + `else:\n`
            + `    print("MANIFEST_NO_SO")\n`
            + `PYEOF`],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 60000 });
        const smoke = await runtime.exec.exec('sh', ['-c',
            'cd /tmp && python3 -c "import gpustack; print(gpustack.__name__ + \' IMPORT_OK\')" 2>&1 | tail -2'],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 60000 });
        return /MANIFEST_OK/.test(String(fix.stdout || '')) && /IMPORT_OK/.test(String(smoke.stdout || ''));
    } catch (e) {
        console.error(`[twoStage] wheel manifest repair error: ${e.message?.slice(0, 120)}`);
        return false;
    }
}

// UI 目录预置（wheel-integrity 类 fork 的确定性问题，同 manifest 修复）：fork 的
// routes/ui.py 启动时挂载 <pkg安装目录>/ui/{css,js,static,images} 并要求目录存在
// （不存在 raise → 启动失败）。wheel 不带 ui，前端 dist 又在 frontend/ 下构建——
// 预配阶段直接把构建产物拷到安装目录，agent 的 20+ 轮 UI 考古（实测）归零。
// 幂等：ui/index.html 已在则跳过。dist 在 repo 的常见位置中找。
async function provisionWheelUi(runtime, runtimeRef, workspacePath, pkg) {
    try {
        const r = await runtime.exec.exec('sh', ['-c',
            `UI=/usr/local/lib/python3.11/dist-packages/${pkg}/ui; `
            + `[ -f "$UI/index.html" ] && echo ALREADY && exit 0; `
            + `DIST=$(ls -d /workspace/frontend/dist /workspace/web/dist /workspace/dist /workspace/*/dist 2>/dev/null | head -1); `
            + `[ -n "$DIST" ] && [ -f "$DIST/index.html" ] || { echo NO_DIST; exit 0; }; `
            + `mkdir -p "$UI" && cp -r "$DIST"/. "$UI"/ && echo UI_OK:$(ls "$UI"/index.html 2>/dev/null | wc -l)`],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 120000 });
        const out = String(r.stdout || '').trim();
        if (/UI_OK/.test(out)) console.error(`[twoStage] wheel ui provision: ${pkg} ui mounted from built frontend dist`);
        else if (/ALREADY/.test(out)) console.error(`[twoStage] wheel ui provision: ${pkg} ui already present (idempotent skip)`);
        else console.error(`[twoStage] wheel ui provision: ${pkg} no built frontend dist yet — agent will copy it (non-fatal)`);
        return /UI_OK|ALREADY/.test(out);
    } catch (e) {
        console.error(`[twoStage] wheel ui provision error (non-fatal): ${e.message?.slice(0, 120)}`);
        return false;
    }
}

// 平台兜底：verify 失败后用预配的 wheel 入口确定性拉起后端并探活。
// 与 preview 复验同一套机制（manifest 补齐 + spawn 长命通道 + JSON 探测），
// 但在这里用于「把失败转成功」——agent 忘了起后端时平台保证最终可用性。
// 数据驱动：entry/port/dbUrl 全部由调用方传入（来自预配实况），无项目名硬编码。
async function platformRescueWheelBackend({ runtimeRef, workspacePath, entry, port, dbUrl }) {
    const runtime = getRuntime();
    try {
        // 0) manifest 幂等补齐（agent 自建 wheel 同样可能缺）
        await repairWheelManifest(runtime, runtimeRef, workspacePath, entry);
        // 1) 清理目标端口上的残留进程（静态 serve 等），避免端口冲突
        await runtime.exec.exec('sh', ['-c', `fuser -k ${port}/tcp 2>/dev/null; sleep 1; true`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
        // 2) spawn 长命通道拉起（与 blinkForwarder 同理：exec 起的 detached 进程会被会话收割）
        await runtime.exec.spawn(
            entry,
            ['start', '--port', String(port), '--data-dir', '/tmp/gsdata', '--gateway-mode', 'disabled', '--disable-update-check', '--database-url', dbUrl],
            { HOME: '/root', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
            { runtimeRef, cwd: workspacePath },
        );
        // 3) 探活：/version 等 API 路径返回 JSON（最长 40s）
        for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const rdy = await runtime.exec.exec('sh', ['-c',
                `for p in /version /health /api/health /; do ct=$(curl -s -m 4 -o /dev/null -w '%{content_type}' http://127.0.0.1:${port}$p 2>/dev/null); case "$ct" in *json*) echo API_JSON; break;; esac; done`],
                {}, { runtimeRef, cwd: workspacePath, timeoutMs: 20000 });
            if (/API_JSON/.test(String(rdy.stdout || ''))) {
                return { ok: true, port };
            }
        }
        return { ok: false, reason: `spawned ${entry} but no JSON API alive on :${port} within 40s (see /tmp/gs.log in guest)` };
    } catch (e) {
        return { ok: false, reason: e.message?.slice(0, 150) || 'spawn error' };
    }
}

// 后端 wheel 预构建（Python 私有构建要求代码化，方案同 k3s/PG 预配）：
// 检测 pyproject.toml 声明自定义 wheel 构建 hook（如 gpustack/cubex 的
// cythonize_license——编译 .so 并生成 _integrity.json，应用启动自检必需）的包，
// editable 安装（pip install -e .）永远没有这些产物 → 启动即 exit 78。
// 平台在 provision 阶段确定性执行：pip wheel . --no-deps（PEP 517 构建隔离自动
// 拉 cython/hatchling）→ pip install <wheel>；幂等（/tmp marker + wheel 文件）。
// 结果注入 plan.context.backendWheel，agent 只需直接运行入口。
async function ensureBackendWheelIfNeeded(runtimeRef, workspacePath) {
    const runtime = getRuntime();
    try {
        // 检测：根 + 一层子目录的 pyproject.toml 含自定义 wheel hook
        const find = await runtime.exec.exec('sh', ['-c',
            'for d in . */; do [ -f "${d}pyproject.toml" ] || continue; '
            + 'grep -qE "hooks\\.custom|cythonize_license" "${d}pyproject.toml" 2>/dev/null && echo "${d%/}"; done'],
            {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
        const dirs = String(find.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
        if (dirs.length === 0) return { ok: false, reason: 'no wheel-hook packages' };
        const built = [];
        for (const dir of dirs) {
            const meta = await runtime.exec.exec('sh', ['-c',
                `cd '${dir}' && pkg=$(grep -m1 '^name = ' pyproject.toml | sed 's/^name = "\\(.*\\)"/\\1/'); `
                + `entry=$(sed -n '/\\[project.scripts\\]/,/^\\[/p' pyproject.toml | grep -m1 '=' | sed 's/ *=.*//; s/"//g'); echo "PKG=$pkg ENTRY=$entry"`],
                {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
            const m = String(meta.stdout || '').match(/PKG=(\S+) ENTRY=(\S*)/);
            if (!m || !m[1]) continue;
            const pkg = m[1], entry = m[2] || pkg;
            // 幂等：marker + wheel 文件已在 → 跳过构建（同会话 VM 跨部署复用）
            const idem = await runtime.exec.exec('sh', ['-c',
                `test -f /tmp/.wheel-built-${pkg} && ls /tmp/wheels/${pkg}-*.whl >/dev/null 2>&1 && echo ALREADY || echo BUILD`],
                {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
            const alreadyBuilt = String(idem.stdout || '').includes('ALREADY');
            if (alreadyBuilt) {
                built.push({ pkg, entry, dir });
                // 旧版本 marker 只记录「构建过」，不保证 manifest 修复过（上游 fork 的
                // wheel 缺 _integrity.json）——安装目录没有 manifest 就补，天然幂等。
                const mf = await runtime.exec.exec('sh', ['-c',
                    `test -f /usr/local/lib/python3.11/dist-packages/${pkg}/license/_integrity.json && echo HAVE || echo MISSING`],
                    {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
                if (String(mf.stdout || '').includes('MISSING')) {
                    await repairWheelManifest(runtime, runtimeRef, workspacePath, pkg);
                }
                await provisionWheelUi(runtime, runtimeRef, workspacePath, pkg);
                continue;
            }
            console.error(`[twoStage] backend wheel provision: building ${pkg} (wheel-integrity hooks detected)...`);
            // gcc（cython 编译）；构建隔离自动拉 cython/hatchling（镜像已配 CN 源）
            const prep = await runtime.exec.exec('sh', ['-c',
                'command -v gcc >/dev/null 2>&1 || apt-get install -y -qq gcc >/tmp/gcc-install.log 2>&1; command -v gcc >/dev/null && echo GCC_OK || echo GCC_FAIL; '
                + 'python3 -m pip --version >/dev/null 2>&1 && echo PIP_OK || { apt-get install -y -qq python3-pip >/tmp/pip-install.log 2>&1 && python3 -m pip --version >/dev/null 2>&1 && echo PIP_OK || echo PIP_FAIL; }'],
                {}, { runtimeRef, cwd: workspacePath, timeoutMs: 300000 });
            if (!/GCC_OK/.test(String(prep.stdout || '')) || !/PIP_OK/.test(String(prep.stdout || ''))) {
                console.error(`[twoStage] backend wheel provision: gcc/pip prep failed (gcc=${/GCC_OK/.test(String(prep.stdout || ''))}, pip=${/PIP_OK/.test(String(prep.stdout || ''))}), skip (agent fallback covers)`);
                continue;
            }
            const build = await runtime.exec.exec('sh', ['-c',
                `cd '${dir}' && python3 -m pip wheel . -w /tmp/wheels --no-deps -q >/tmp/wheel-build.log 2>&1; `
                + `ec=$?; tail -3 /tmp/wheel-build.log; `
                + `[ $ec -eq 0 ] && python3 -m pip install --break-system-packages -q /tmp/wheels/${pkg}-*.whl >>/tmp/wheel-build.log 2>&1 && echo WHEEL_INSTALLED || echo WHEEL_FAIL`],
                {}, { runtimeRef, cwd: workspacePath, timeoutMs: 360000 });
            if (!/WHEEL_INSTALLED/.test(String(build.stdout || ''))) {
                console.error(`[twoStage] backend wheel provision: ${pkg} build failed (non-fatal, agent fallback covers): ${String(build.stdout || '').slice(0, 200)}`);
                continue;
            }
            // 补 _integrity.json（上游 fork 打包 bug——hook 生成的 manifest 没被
            // 打进 wheel）+ UI 目录预置 + import 自检冒烟。
            const postFix = await repairWheelManifest(runtime, runtimeRef, workspacePath, pkg);
            await provisionWheelUi(runtime, runtimeRef, workspacePath, pkg);
            if (postFix) {
                console.error(`[twoStage] backend wheel provision: ${pkg} built, manifest repaired, import self-check passed (entry: ${entry})`);
                built.push({ pkg, entry, dir });
            } else {
                console.error(`[twoStage] backend wheel provision: ${pkg} post-fix failed (manifest/import smoke did not pass)`);
            }
        }
        const first = built[0];
        return { ok: Boolean(first), pkg: first?.pkg || null, entry: first?.entry || null, builtAll: built.map((b) => b.pkg) };
    } catch (e) {
        console.error(`[twoStage] backend wheel provision error (non-fatal): ${e.message?.slice(0, 150)}`);
        return { ok: false, reason: e.message?.slice(0, 120) || 'error' };
    }
}

async function provisionPostgresIfNeeded(runtimeRef, workspacePath, plan, appConn = null) {
    const runtime = getRuntime();
    // 单次 apt 安装 postgres 的预算（首次冷装 40 包约需 3~5 分钟；太短会在超时边界被杀，
    // 留下半装/锁残留——xensemble 实测 240s 恰好撞上边界）
    const PG_APT_TIMEOUT_MS = 240000;
    let needs = false;
    try {
        // 检测面覆盖多语言后端：Node（package.json 里的 pg/pg-promise）、Go（pgx / postgres:// 连接串、
        // go.mod）、docker-compose（postgres 服务）、启动脚本/Makefile（DATABASE_URL 写死在
        // start-server.sh 这类文件里，如 AgentHarness 的 Go 后端）。
        const r = await runtime.exec.exec('sh', ['-c', `
            grep -lE '\\"(pg|postgres)\\"|pg-promise|pgx|postgres://' package.json server/package.json apps/*/package.json */package.json go.mod */go.mod 2>/dev/null
            find . -maxdepth 3 \\( -name 'schema.sql' -o -name 'init.sql' \\) 2>/dev/null | grep -v node_modules | head -3
            grep -lE 'DATABASE_URL|POSTGRES_HOST|POSTGRES_DB|POSTGRES_USER' .env server/.env .env.example server/.env.example apps/*/.env apps/*/.env.example */.env */.env.example start-server.sh Makefile docker-compose.yml docker-compose.deploy.yml docker-compose.selfhost.yml 2>/dev/null
        `], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
        needs = Boolean(String(r.stdout || '').trim());
        // 与 detectSystemDeps 的结果互通：它的扫描面含 pyproject.toml（Python 后端的
        // psycopg2/asyncpg 写在那里，上面的 grep 面不覆盖）——gpustack 类项目实测：
        // systemDeps 检测到 postgres，但本函数自己的 grep 全空 → 静默跳过安装 →
        // agent 起后端时 migrations 连接被拒。两处任一命中即装。
        // （新架构下这个互通判定由 provisionDbServices 外层完成——services 列表本身
        // 已含 systemDeps 命中的服务，这里不再重复引用 systemDeps。）
    } catch { needs = false; }
    if (!needs) return { ready: false };

    try {
        // base 镜像可能未装 PostgreSQL（Debian bookworm 默认无）→ 先 apt 安装（防卡死：
        // 清残留锁 + DPkg::Lock::Timeout/Acquire 重试/超时，避免 verify agent 现场 apt 卡住）。
        // 幂等：已装则跳过，避免重复 update/install 浪费时间。
        const already = await runtime.exec.exec('sh', ['-c', 'command -v pg_isready >/dev/null 2>&1 && echo YES || echo NO'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 10000 }).catch(() => ({ stdout: 'NO' }));
        if (String(already.stdout || '').trim() !== 'YES') {
            const installRes = await aptSafeInstall({
                runtime, runtimeRef, workspacePath,
                packages: 'postgresql postgresql-contrib',
                onLog: (m) => console.error(`[twoStage] ${m}`),
                timeoutMs: PG_APT_TIMEOUT_MS,
            });
            if (!installRes.ok) {
                // 结构化归因（通用，非 PG 专用）：超时（exit=124）与 ENOSPC/dpkg 损坏等
                // 分别映射 code，供部署记录与 verify prompt 透传，避免 agent 盲目重试。
                const cls = installRes.exitCode === 124
                    ? { code: 'apt_timeout', reason: `apt 安装超时（>${Math.floor(PG_APT_TIMEOUT_MS / 1000)}s）被中止，可能留下半装/锁残留` }
                    : classifyAptFailure(installRes.logTail);
                console.error('[twoStage] postgres apt install failed:', installRes.logTail);
                return { ready: false, code: cls.code, reason: cls.reason, detail: installRes.logTail.slice(0, 400) };
            }
        }
        await runtime.exec.exec('sh', ['-c', `(service postgresql start 2>/dev/null || pg_ctlcluster $(ls /etc/postgresql 2>/dev/null | head -1) main start 2>/dev/null) || true`], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 });
        // 等 PG 真正就绪（最多 60s：新 VM 首次 apt 装完的冷启动 + initdb 可能偏慢，
        // 30s 实测不够——超时后 agent 要多花 2-3 轮手动 service start）
        let pgReady = false;
        for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            try {
                const chk = await runtime.exec.exec('sh', ['-c', 'pg_isready -q 2>/dev/null && echo UP || echo DOWN'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 8000 });
                if (String(chk.stdout || '').trim() === 'UP') { pgReady = true; break; }
            } catch { /* retry */ }
        }
        if (!pgReady) {
            // 已装但起不来：可能是集群未创建（dpkg 中断/安装半程被杀）。带真实原因返回，
            // 由上层透传；这里不再把半装环境甩给 verify agent 自行修复。
            const clusterInfo = await runtime.exec.exec('sh', ['-c', 'pg_lsclusters 2>&1; ls /etc/postgresql 2>/dev/null'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 10000 }).catch(() => ({ stdout: '' }));
            console.error('[twoStage] postgres start failed: pg_isready not UP after 30s (fallback to agent)');
            return {
                ready: false,
                code: 'service_not_up',
                reason: 'postgres 已安装但启动失败（pg_isready 30s 未 UP）',
                detail: String(clusterInfo.stdout || '').slice(0, 300),
            };
        }
        console.error('[twoStage] postgres provisioned and ready (pg_isready UP)');
    } catch (e) {
        console.error('[twoStage] postgres start failed (fallback to agent):', e.message);
        return { ready: false, code: 'provision_error', reason: String(e.message || '').slice(0, 200), detail: null };
    }

    // PG 已运行后，用**通用适配器**解析 app 自身 {db,user,password} 建库建用户（幂等）。
    // 优先用宿主侧 dbAdapt 解析结果（appConn），退回 plan/guest 的 postgres 解析。
    // 建库/建用户 SQL 走 dbAdapt.buildProvisionCommand（与 mysql 等同一接口，通用）。
    const raw = appConn
        ? { user: appConn.user, db: appConn.database, pass: appConn.password, port: appConn.port }
        : (parseDbInfoFromPlan(plan) || await parseDbInfoFromGuest(runtimeRef, workspacePath));
    if (raw) {
        const c = dbAdapt.fillDefaults('postgres', { user: raw.user, database: raw.db, password: raw.pass, port: raw.port });
        try {
            const cmd = dbAdapt.buildProvisionCommand('postgres', c);
            await runtime.exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 60000 });
            console.error(`[twoStage] postgres db provisioned user=${c.user} db=${c.database}`);
            // 密码一并返回（注入 verify prompt 的 dbPassword），让 agent 直接用预配凭据配置应用。
            return {
                ready: true, dbUser: c.user, dbName: c.database, dbPassword: c.password || null,
                dsn: dbAdapt.DIALECTS.postgres.dsn({ host: '127.0.0.1', port: c.port, db: c.database, user: c.user, password: c.password }),
                localized: dbAdapt.isRemoteHost(c.host),
            };
        } catch (e) {
            console.error('[twoStage] postgres db create failed (fallback to agent):', e.message);
            return { ready: true }; // PG 已运行，建库失败则让 agent 兜底
        }
    }
    return { ready: true };
}

// ──────────────────────────────────────────────────────────────────────────
// 数据库/缓存服务通用生命周期（装 → 启动 → 就绪），描述表驱动。
// detectSystemDeps 检测出的 services（postgres/mysql/redis/mongo，多语言驱动名）在此统一
// 前置处理：verify 开始前服务已就绪，agent 不再现场 apt/启动/认证试错（实测 mysql 未启动
// 时 agent 的建库命令 hang 满 600s）。加新服务只需在 DB_SERVICE_SPECS 补一项。
// 注意：mariadb/mysql 的 root 认证与 postgres 的建库建用户是各服务增强逻辑，不在通用闭环内。
// ──────────────────────────────────────────────────────────────────────────
const DB_SERVICE_SPECS = {
    postgres: {
        pkgs: ['postgresql', 'postgresql-contrib'],
        probeInstalled: 'command -v pg_isready >/dev/null 2>&1 && echo YES || echo NO',
        start: 'service postgresql start 2>/dev/null || pg_ctlcluster $(ls /etc/postgresql 2>/dev/null | head -1) main start 2>/dev/null || true',
        ready: 'pg_isready -q 2>/dev/null && echo UP || echo DOWN',
        // postgres 增强（建库建用户）由 provisionDbServices 里特判调用 provisionPostgresIfNeeded。
    },
    mysql: {
        pkgs: ['mariadb-server'],
        probeInstalled: '(command -v mariadbd >/dev/null 2>&1 || command -v mysqld >/dev/null 2>&1) && echo YES || echo NO',
        start: 'service mariadb start 2>/dev/null || service mysql start 2>/dev/null || (mysqld_safe >/dev/null 2>&1 &) || true',
        // Debian mariadb 默认 root 走 unix_socket auth（`mysql -u root` socket 免密，但 TCP
        // 连不上）——Spring Boot / 远程 JDBC（jdbc:mysql://127.0.0.1）用 root 密码会失败，
        // agent 只能现场改认证试错（实测）。平台启动后主动把 root 设为 mysql_native_password
        //（密码 root，应用配置不同时 agent 自行 ALTER 或改应用配置），verify 直接 TCP 连接。
        initRoot: "timeout 10 mysql -u root -e \"ALTER USER 'root'@'localhost' IDENTIFIED VIA mysql_native_password USING PASSWORD('root'); FLUSH PRIVILEGES;\" 2>/dev/null || true",
        ready: '(mysqladmin ping -h127.0.0.1 -uroot -proot 2>/dev/null | grep -qi alive) && echo UP || echo DOWN',
        connect: 'TCP 127.0.0.1:3306 root/root（平台已设 mysql_native_password 认证）；若应用配置其它密码，先 ALTER USER 或改应用配置',
    },
    redis: {
        pkgs: ['redis-server'],
        probeInstalled: 'command -v redis-server >/dev/null 2>&1 && echo YES || echo NO',
        start: 'redis-server --daemonize yes >/dev/null 2>&1 || service redis-server start 2>/dev/null || true',
        ready: '(redis-cli ping 2>/dev/null | grep -qi PONG) && echo UP || echo DOWN',
        connect: '默认 127.0.0.1:6379，无认证',
    },
    // mongodb：Debian bookworm apt 无官方包，不预装（由 agent/配置兜底）。
    mongodb: { pkgs: [], note: 'no official apt package in Debian bookworm, skipped' },
};

// 通用数据库/缓存服务 provision：遍历 detectSystemDeps 检测出的 services，
// 对每个服务执行"探活已装 → 缺则 apt 装 → 启动 → 等就绪（最多 30s）"闭环（幂等、non-fatal）。
// postgres 额外走 provisionPostgresIfNeeded 的建库建用户增强（返回凭据供 prompt 注入）。
// 返回 { results: [{ service, ready, ... }] }，prompt 按服务注入状态。
async function provisionDbServices({ runtimeRef, workspacePath, hostWorkspacePath, services, plan, onLog }) {
    const runtime = getRuntime();
    const log = (m) => { if (onLog) onLog(m); };
    const svcList = Array.isArray(services) ? services.filter((s) => DB_SERVICE_SPECS[s]) : [];
    if (svcList.length === 0) return { results: [] };
    log(`provision db services START: ${svcList.join(',')}`);
    // 通用（与 DB 类型无关）：从 app 自身配置解析连接信息 + 发现 schema + 解析 preview DB 模式
    const appConns = hostWorkspacePath ? dbAdapt.detectDbConnections(collectHostDbConfigFiles(hostWorkspacePath)) : {};
    const schemaAll = hostWorkspacePath ? collectHostSqlFiles(hostWorkspacePath) : [];
    const dbMode = await resolvePreviewDbMode(hostWorkspacePath);
    if (Object.keys(appConns).length) log(`app db config detected: ${Object.entries(appConns).map(([k, v]) => `${k}(${v.database}@${v.host}:${v.port}/${v.user})`).join(', ')}`);
    const results = [];
    for (const svc of svcList) {
        const spec = DB_SERVICE_SPECS[svc];
        try {
            let base = null;
            if (svc === 'postgres') {
                // 装 + 启 + 就绪 + 建库建用户（内部走通用 dbAdapt 命令，返回 ready/凭据/DSN）
                base = await provisionPostgresIfNeeded(runtimeRef, workspacePath, plan, appConns.postgres || null);
            } else if (!Array.isArray(spec.pkgs) || spec.pkgs.length === 0) {
                log(`db service ${svc}: ${spec.note || 'no apt package, leaving to agent'}`);
                results.push({ service: svc, ready: false, skipped: spec.note || 'no apt package' });
                continue;
            } else {
                // 1) 探活已装
                const ins = await runtime.exec.exec('sh', ['-c', spec.probeInstalled], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 }).catch(() => ({ stdout: 'NO' }));
                if (!String(ins.stdout || '').includes('YES')) {
                    const res = await aptSafeInstall({ runtime, runtimeRef, workspacePath, packages: spec.pkgs.join(' '), onLog, timeoutMs: 420000 });
                    if (!res.ok) {
                        log(`db service ${svc} apt install FAILED (non-fatal): ${(res.logTail || '').slice(0, 200)}`);
                        results.push({ service: svc, ready: false, reason: 'apt install failed' });
                        continue;
                    }
                }
                // 2) 启动 + 服务初始化（如 mariadb root 认证）
                await runtime.exec.exec('sh', ['-c', spec.start], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 30000 }).catch(() => {});
                if (spec.initRoot) {
                    await runtime.exec.exec('sh', ['-c', spec.initRoot], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 20000 }).catch(() => {});
                }
                // 3) 等就绪（最多 30s）
                let up = false;
                for (let i = 0; i < 30; i++) {
                    await new Promise((r) => setTimeout(r, 1000));
                    const chk = await runtime.exec.exec('sh', ['-c', spec.ready], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 8000 }).catch(() => ({ stdout: '' }));
                    if (String(chk.stdout || '').includes('UP')) { up = true; break; }
                }
                base = { ready: up };
                log(`db service ${svc}: ${up ? 'ready' : 'started but not UP in 30s (agent will handle)'}`);
            }

            // 通用"应用数据库适配"：SQL 类型建 app 库/用户（沿用 app 凭据，host 本地化）+ 导 schema
            let enhanced = {};
            const dialect = (svc === 'postgres' || svc === 'mysql') ? svc : null;
            if (dialect && base?.ready) {
                const conn = appConns[dialect] || {};
                if (dbMode === 'remote') {
                    const c = dbAdapt.fillDefaults(dialect, conn);
                    enhanced = { adapted: false, remote: true, localized: false, database: c.database, user: c.user, dsn: conn.host ? dbAdapt.DIALECTS[dialect].dsn(c) : null };
                    log(`db ${dialect}: remote mode — keep app host ${c.host || '(unset)'}（不本地化）`);
                } else if (svc === 'postgres') {
                    // postgres 建库建用户已在 provisionPostgresIfNeeded 内完成，这里补 schema 导入 + DSN
                    const c = dbAdapt.fillDefaults(dialect, conn);
                    let schemaImported = 0;
                    for (const rel of dbAdapt.pickSchemaFiles(dialect, schemaAll)) {
                        const importCmd = dbAdapt.buildSchemaImportCommand(dialect, c, rel);
                        if (!importCmd) continue;
                        try {
                            const r = await runtime.exec.exec('sh', ['-c', importCmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 120000 });
                            const m = String(r.stdout || '').match(/__DBIMP_EXIT__=(-?\d+)/);
                            if ((m ? Number(m[1]) : r.exitCode) === 0) schemaImported++;
                        } catch { /* ignore */ }
                    }
                    enhanced = {
                        adapted: true, database: c.database, user: c.user, host: '127.0.0.1', port: c.port,
                        dsn: dbAdapt.DIALECTS.postgres.dsn({ host: '127.0.0.1', port: c.port, db: c.database, user: c.user, password: c.password }),
                        localized: dbAdapt.isRemoteHost(c.host), schemaImported,
                    };
                } else {
                    enhanced = await provisionAppDatabase({ runtime, runtimeRef, workspacePath, dialect, conn, schemaFiles: dbAdapt.pickSchemaFiles(dialect, schemaAll), onLog: log });
                }
            }
            results.push({ service: svc, ready: !!base?.ready, connect: spec.connect || null, ...base, ...enhanced });
        } catch (e) {
            log(`db service ${svc} provision error (non-fatal): ${e.message?.slice(0, 200)}`);
            results.push({ service: svc, ready: false, reason: String(e.message || '').slice(0, 200) });
        }
    }
    return { results };
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
        WORKSPACE_ROOT: workspace.WORKSPACE_ROOT,
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
    // 确保 server/ 依赖就绪：verify agent 常只装根目录依赖并静态 serve web/dist，从不安装
    // server/ 子包依赖，导致 node src/server.js 因缺 fastify 等模块无法启动 → 回退静态 →
    // /api 返回 404 HTML（登录界面 "Unexpected token '<' ... is not valid JSON"）。
    // 这里兜底装一次（幂等；失败不阻断，让下方 spawn 自己抛更真实的错误）。
    try {
        const nm = await runtime.exec.exec('sh', ['-c', 'test -d server/node_modules && echo YES || echo NO'], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 15000 });
        const hasServerDeps = String(nm.stdout || '').trim() === 'YES';
        if (!hasServerDeps) {
            if (onLog) onLog('server/ deps missing, installing before spawning nested backend');
            await runtime.exec.exec('sh', ['-c', 'cd server && npm ci --no-audit --no-fund > /tmp/server-deps.log 2>&1; echo EXIT=$?; tail -3 /tmp/server-deps.log'], spawnEnv, { runtimeRef, cwd: workspacePath, timeoutMs: 600000 });
        }
    } catch (e) {
        if (onLog) onLog(`nested server deps install failed (continuing): ${e.message}`);
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
                // 目录列表页（serve 在无 index.html 的目录起的 "Files within ..."）不算成功——
                // 多仓库布局下 serve 起在仓库根会列出各仓库目录（用户看到的"项目目录"页）。
                if (/<html|<head|<!doctype/i.test(out) && !/could not be found/i.test(out)
                    && !/(Directory listing for|Files within|Index of \/)/i.test(out)) {
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
async function startRewriteProxy({ runtimeRef, workspacePath, upstreamPort, listenPort, base, backendPort = 0, apiPrefixes = [], onLog }) {
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
            [proxyPath, '--upstream', String(upstreamPort), String(listenPort), base || '',
                ...(backendPort ? [`--backend-port=${backendPort}`] : []),
                ...(Array.isArray(apiPrefixes) && apiPrefixes.length ? [`--api-prefixes=${apiPrefixes.join(',')}`] : [])],
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

/**
 * verify 前清理过期的前端构建产物。
 *
 * verify agent 常因"看到构建产物目录已存在"而跳过重新构建，复用上一个部署残留的
 * 不完整/过期产物（xensemble 实测：login 页引用的 2 个 chunk 在 .next 产物中缺失，
 * next 返回 500 → 前端 JS 加载失败 → 白屏；首页 chunk 齐全所以首页正常）。
 * 每次 verify 前清掉这些目录，agent 必须重新构建，产物必然与当前源码一致。
 *
 * 覆盖主流前端框架的标准产物/缓存目录（全部可再生成）：
 *   - Next.js：.next / out
 *   - Nuxt：.nuxt / .output
 *   - SvelteKit：.svelte-kit
 *   - Vite/webpack/CRA/Angular：dist / build / .vite
 *   - Parcel：.parcel-cache
 *   - Docusaurus / VuePress：.docusaurus / .vuepress
 *   - Electron：dist-electron / dist_electron
 * 排除 node_modules/.pnpm-store/.git（npm 包自身的 dist 不删、源码仓库不动）。
 * 纯后端/静态项目通常无这些目录，零影响。
 */
async function clearStaleBuildArtifacts(runtimeRef, workspacePath) {
    const runtime = getRuntime();
    const dirs = '.next .nuxt .output .svelte-kit .vite .parcel-cache .angular .docusaurus .vuepress dist build out dist-electron dist_electron';
    const names = dirs.split(' ').map((d) => `-name "${d}"`).join(' -o ');
    const cmd = `find . -maxdepth 5 -type d \\( ${names} \\) -prune `
        + '-not -path "*/node_modules/*" -not -path "*/.pnpm-store/*" -not -path "*/.git/*" '
        + '-exec rm -rf {} +; echo "__CLEAR_BUILD_ARTIFACTS_DONE__"';
    try {
        const r = await runtime.exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 90000 });
        console.error(`[twoStage] stale build artifacts cleared (exit=${r.exitCode})`);
        return String(r.stdout || '').includes('__CLEAR_BUILD_ARTIFACTS_DONE__');
    } catch (e) {
        console.error(`[twoStage] clear stale build artifacts failed (non-fatal): ${e.message?.slice(0, 120)}`);
        return false;
    }
}

// 部署前清理陈旧监听（长寿 VM 实测隐患：多次部署积累 serve 尸体——npx serve/
// http.server/python -m http.server 等静态服务器残留监听 8000/3000/9000 等常见
// 端口，verify agent 会被"端口已被占"误导进 pkill 循环，端口扫描兜底也可能把
// 尸体误判为应用。只杀通用静态服务进程模式，不碰 DB/应用后端（那些由 PG 预配
// 与本次部署自己管理）。幂等、best-effort：清理失败不阻塞部署。
async function clearStaleListeners(runtimeRef, workspacePath) {
    const runtime = getRuntime();
    const cmd = `pkill -f "npx --yes serve" 2>/dev/null; pkill -f "serve -s" 2>/dev/null; `
        + `pkill -f "serve dist" 2>/dev/null; pkill -f "http.server" 2>/dev/null; `
        + `pkill -f "caddy file-server" 2>/dev/null; sleep 1; echo "__STALE_LISTENERS_CLEARED__"`;
    try {
        const r = await runtime.exec.exec('sh', ['-c', cmd], {}, { runtimeRef, cwd: workspacePath, timeoutMs: 20000 });
        console.error('[twoStage] stale static listeners cleared (serve/http.server remnants)');
        return String(r.stdout || '').includes('__STALE_LISTENERS_CLEARED__');
    } catch (e) {
        console.error(`[twoStage] clear stale listeners failed (non-fatal): ${e.message?.slice(0, 120)}`);
        return false;
    }
}

/**
 * 孤儿部署记录回收。
 *
 * 进程被强杀（systemd 重启 / 崩溃 / SIGTERM 超时 force exit）时，进行中的
 * kind='deploy' 记录永久停留在 building——没有进程推进它，前端永远轮询到
 * building 显示"部署中"，且该记录永远不会被 supersede 逻辑清理（那里只处理
 * running）。判定标准：DB 有 building 记录，但其 (projectId, sessionId) 键
 * 不在内存 activeDeploys 注册表中——注册表随进程启动为空，本进程存活的部署
 * 必然在册（registerDeploy 于部署开始时注册、finally 注销）。
 *
 * sameKeyLive：本次请求 registerDeploy 返回 created=false 时为 true，表示
 * 同键部署已在本进程在飞——同键 building 记录可能是它的（也可能是更早请求
 * 刚插入还没到终态），跳过不动。created=true 时本次部署的记录尚未插入，
 * 同键的既有 building 记录必为孤儿。
 *
 * 返回回收的记录数；调用方据此让本次部署走 resume（断点续修：有保存的
 * verify 对话则接回继续修，没有则自动回退到计划缓存/全新分析）。
 */
async function reclaimOrphanedDeployRecords({ projectId, userId, ourKey, sameKeyLive }) {
    try {
        const rows = await db.select({
            id: schema.deployments.id,
            sessionId: schema.deployments.sessionId,
            userId: schema.deployments.userId,
        })
            .from(schema.deployments)
            .where(and(
                eq(schema.deployments.projectId, projectId),
                eq(schema.deployments.kind, 'deploy'),
                eq(schema.deployments.status, 'building'),
            ));
        const orphanIds = rows
            .filter((r) => {
                if (userId && r.userId && r.userId !== userId) return false; // 不动其他用户的记录
                if (sameKeyLive && deployKey(projectId, r.sessionId) === ourKey) return false; // 同键活部署
                return true;
            })
            .map((r) => r.id);
        if (!orphanIds.length) return 0;
        await db.update(schema.deployments)
            .set({ status: 'stopped', stoppedBy: 'orphan_reclaim', updatedAt: Date.now() })
            .where(inArray(schema.deployments.id, orphanIds));
        console.error(`[twoStage] reclaimed ${orphanIds.length} orphaned building deploy record(s) project=${projectId}: ${orphanIds.join(',')}`);
        return orphanIds.length;
    } catch (e) {
        console.error('[twoStage] orphan reclaim failed:', e?.message || e);
        return 0;
    }
}

/**
 * 查同 project+session 最新一条 building 中的 kind='deploy' 记录。
 * 可重入判定用：注册表有在飞条目时，据此把第二次点击接到进行中的部署上。
 */
async function findBuildingDeployRecord(projectId, sessionId, userId) {
    try {
        const conds = [
            eq(schema.deployments.projectId, projectId),
            eq(schema.deployments.kind, 'deploy'),
            eq(schema.deployments.status, 'building'),
        ];
        if (sessionId) conds.push(eq(schema.deployments.sessionId, sessionId));
        if (userId) conds.push(eq(schema.deployments.userId, userId));
        const rows = await db.select({
            id: schema.deployments.id,
            stage: schema.deployments.stage,
            createdAt: schema.deployments.createdAt,
        }).from(schema.deployments)
            .where(and(...conds))
            .orderBy(desc(schema.deployments.createdAt))
            .limit(1);
        return rows[0] || null;
    } catch (e) {
        console.error('[twoStage] findBuildingDeployRecord failed:', e?.message || e);
        return null;
    }
}

// 查同项目 status='running' 的部署（预览服务存活）。用于：
//  - "打开预览"(/preview, reuseRunning=true)：已有 running 预览直接复用，绝不重复部署——
//    重复部署会在同一沙箱并发 verify，互相清 worktree/杀服务/占端口（16:55 实测两个
//    running 部署并发，后起的清了前一个的 next → chunk 全 500）；
//  - 主动部署(/auto-deploy, reuseRunning=false)：先停旧 running 再新部署，独占沙箱。
async function findRunningDeployRecord(projectId, sessionId, userId) {
    try {
        const conds = [
            eq(schema.deployments.projectId, projectId),
            eq(schema.deployments.kind, 'deploy'),
            eq(schema.deployments.status, 'running'),
        ];
        if (sessionId) conds.push(eq(schema.deployments.sessionId, sessionId));
        if (userId) conds.push(eq(schema.deployments.userId, userId));
        const rows = await db.select().from(schema.deployments)
            .where(and(...conds))
            .orderBy(desc(schema.deployments.createdAt))
            .limit(1);
        return rows[0] || null;
    } catch (e) {
        console.error('[twoStage] findRunningDeployRecord failed:', e?.message || e);
        return null;
    }
}

async function runAutoTwoStageDeploy({ projectId, userId, role, getProjectForUser, onProgress, onStarted, resume, sessionId, reuseRunning = false }) {
    const project = await getProjectForUser(userId, projectId);
    if (!project) return { ok: false, error: 'Project not found' };
    if (!process.env.LLM_ANALYZE_API_KEY && !process.env.LLM_ANALYZE_API_URL) {
        return { ok: false, error: 'LLM_ANALYZE_* env not configured.' };
    }
    // ── 可重入判定（必须在 registerDeploy 之前：registerDeploy 的覆盖语义会
    // 重置在飞部署的 aborted 标志，把用户刚下的停止指令弄丢）──
    // 同键部署已在飞时，第二次点击不新起部署：
    //   - 正常在飞 → 重入（reattach）：返回已有 deploymentId，前端回到进行中进度；
    //   - 正在停止（aborted=true，agent 尚未退出）→ 拒绝，避免与收尾中的旧部署抢 workspace。
    const peeked = peekDeploy(project.id, sessionId);
    if (peeked) {
        if (peeked.aborted) {
            console.error(`[twoStage] deploy_stopping: project=${project.id} session=${sessionId || '-'} second click while previous deploy is winding down`);
            return {
                ok: false,
                code: 'deploy_stopping',
                error: '上次部署正在停止，请几秒后重试',
            };
        }
        const inFlight = await findBuildingDeployRecord(project.id, sessionId, userId);
        if (inFlight) {
            console.error(`[twoStage] reattach: project=${project.id} session=${sessionId || '-'} deploy=${inFlight.id} (second click absorbed by in-flight deploy)`);
            return {
                ok: true,
                reattached: true,
                deploymentId: inFlight.id,
                stage: inFlight.stage || 'A',
                elapsedMs: Date.now() - Number(inFlight.createdAt || Date.now()),
            };
        }
        // 注册表有条目但没有本 session 的 building 记录 → 其他 session 正在本项目上
        // 部署（项目级互斥）：拒绝而不是并发跑第二条流水线——部署操作的是项目级共享
        // 沙箱，并发会互相清 worktree/杀服务/损坏并发安装的临时文件。
        const otherSessionInFlight = await findBuildingDeployRecord(project.id, null, userId);
        if (otherSessionInFlight) {
            console.error(`[twoStage] deploy_in_progress: project=${project.id} requested by session=${sessionId || '-'} but in-flight deploy=${otherSessionInFlight.id} (other session)`);
            // 与 quota_exceeded 同构：附 occupants 让前端展示「谁在占用」而不是一句冷冰冰的拒绝
            const occupants = await buildConcurrencyOccupants(userId, getProjectForUser, { projectId: project.id, sessionId });
            return {
                ok: false,
                code: 'deploy_in_progress',
                error: '该工作区已有部署/预览在进行中',
                occupants,
            };
        }
        // 注册表有条目但项目内无任何 building 记录（陈旧注册）→ 走新部署并接管该键
    }
    // ── running 预览互斥（项目级全生命周期，不只 building）──
    // 注册表键已注销（上一次部署已 preview 完成）时，该项目可能仍有 running 部署
    // （预览服务存活）。此时：
    //  - /preview（reuseRunning=true，打开预览面板）：直接复用现有 running 预览——
    //    再起部署会在同一沙箱并发 verify，互相清 worktree/杀服务/占端口（16:55 实测
    //    两个 running 并发 → chunk 全 500 白屏）。
    //  - /auto-deploy（reuseRunning=false，主动重新部署）：先真正停掉旧 running 的
    //    沙箱服务（stopPreview 杀进程 + 标记 stopped），再开始新部署，独占沙箱。
    const runningExisting = await findRunningDeployRecord(project.id, sessionId, userId);
    if (runningExisting) {
        if (reuseRunning) {
            console.error(`[twoStage] reuse_preview: project=${project.id} session=${sessionId || '-'} deploy=${runningExisting.id} (existing running preview reused, no re-deploy)`);
            return {
                ok: true,
                reattached: true,
                deploymentId: runningExisting.id,
                stage: runningExisting.stage || 'preview',
                publicUrl: runningExisting.publicUrl || undefined,
                elapsedMs: 0,
            };
        }
        // 主动部署：停掉旧预览服务，避免同一沙箱并发（后起的 verify 会清 worktree/杀服务）
        console.error(`[twoStage] stop_old_running: project=${project.id} session=${sessionId || '-'} deploy=${runningExisting.id} (stopping before new deploy)`);
        try {
            await deploymentService.stopPreview(userId, runningExisting);
        } catch (e) {
            console.error(`[twoStage] stop_old_running failed (non-fatal): ${e?.message || e}`);
        }
    } else {
        // 其他 session 有 running 预览 → 拒绝（避免跨会话在同一沙箱并发）
        const otherRunning = await findRunningDeployRecord(project.id, null, userId);
        if (otherRunning) {
            console.error(`[twoStage] preview_in_use: project=${project.id} requested by session=${sessionId || '-'} but running deploy=${otherRunning.id} (other session)`);
            return {
                ok: false,
                code: 'deploy_in_progress',
                error: '该项目已有运行中的预览，请到对应会话查看或停止后再试',
            };
        }
    }
    // per-user 并发闸门：进行中的部署 + 运行中的预览 ≤ 该用户个人配额（admin 无限制，
    // 跳过并发检查；普通用户在用户管理/个人配额里配置，避免无限制并发部署同时跑多个 VM 耗尽沙箱资源）。
    // 先注册（内存计数原子）再校验，避免多个并发请求同时通过；超限则注销并拒绝。
    const registerCreated = registerDeploy(project.id, userId, sessionId);
    if (!registerCreated) {
        // 抢注失败：peek 与 register 之间有 DB await 窗口，并发第二次点击可能
        // 在这里才发现键已被占。对方是本次部署的真正持有者——重试找它的
        // building 记录并重入（对方注册后 ~100ms 内会插入记录）；始终找不到
        // （极端：对方在插入记录前死亡）才接管该键继续新部署。
        let inFlight = null;
        for (let i = 0; i < 3 && !inFlight; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, 300));
            inFlight = await findBuildingDeployRecord(project.id, sessionId, userId);
        }
        if (inFlight) {
            console.error(`[twoStage] reattach(race): project=${project.id} session=${sessionId || '-'} deploy=${inFlight.id}`);
            return {
                ok: true,
                reattached: true,
                deploymentId: inFlight.id,
                stage: inFlight.stage || 'A',
                elapsedMs: Date.now() - Number(inFlight.createdAt || Date.now()),
            };
        }
        // 抢注窗口内没有本 session 的 building 记录 → 其他 session 的部署刚起步（项目级
        // 互斥）：拒绝。注意不能 unregister——键属于在飞部署，注销会破坏它的 abort 通道；
        // 它自己结束时 finally 会注销。仅当项目内确实无任何 building 记录（对方在插入
        // 记录前死亡）才接管该键继续新部署。
        const otherSessionRace = await findBuildingDeployRecord(project.id, null, userId);
        if (otherSessionRace) {
            console.error(`[twoStage] deploy_in_progress(race): project=${project.id} requested by session=${sessionId || '-'} but in-flight deploy=${otherSessionRace.id} (other session)`);
            return {
                ok: false,
                code: 'deploy_in_progress',
                error: '该工作区已有部署/预览在进行中',
                occupants: await buildConcurrencyOccupants(userId, getProjectForUser, { projectId: project.id, sessionId }),
            };
        }
        // 接管：registerDeploy 已把条目覆盖为新鲜状态（aborted=false），继续新部署
    }
    // 孤儿 building 记录回收（进程被杀遗留）：清理后让本次部署自动走 resume，
    // 有保存的 verify 状态则断点续修，没有则回退到计划缓存/全新分析。
    let reclaimedOrphans = 0;
    try {
        reclaimedOrphans = await reclaimOrphanedDeployRecords({
            projectId: project.id,
            userId,
            ourKey: deployKey(project.id, sessionId),
            sameKeyLive: !registerCreated,
        });
    } catch (_) { /* reclaim 内部已兜底 */ }
    // 真正的中止通道：用户中止（activeDeploys.aborted）或部署总超时（deployState.cancelled）
    // 都使该函数返回 true，让阶段 A/B 的 agent 循环在下一轮退出，而不是只丢弃结果继续跑。
    const deployState = { cancelled: false };
    const aborted = () => deployState.cancelled || isAborted(project.id, sessionId);
    try {
        if (role === 'admin') {
            // admin 无预览并发限制，直接跳过并发检查
        } else {
            const limit = Number((await ensureUserQuota(userId)).maxPreviews ?? 0);
            const usage = await getUsage(userId);
            const current = countByUser(userId) + usage.previews;
            if (current > limit) {
                unregisterDeploy(project.id, sessionId);
                const occupants = await buildConcurrencyOccupants(userId, getProjectForUser, { projectId: project.id, sessionId });
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
        // 中止后停止一切进度写库/SSE：Stop 已把记录标 stopped，心跳与子阶段
        // 上报若继续写会把状态翻回 building（刷新页面又显示"部署中"）。
        // verify agent 退出前（单轮 LLM 调用可达几十秒）这是唯一的回跳源头。
        if (aborted()) return;
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
    // 持久化"进行中部署"记录（kind='deploy'）——提前到请求入口（原先在
    // runDeployInner 内、ensureProjectRuntime 之后才创建）：
    //  (1) 前端在 <1s 内收到 started 确认事件，明确"点击已生效"；
    //  (2) 冷启动开 VM 期间记录已存在，进程若在此窗口被杀，孤儿回收也能兜住；
    //  (3) 同键重入判定可精确找到它。runtimeId 待运行时就绪后由 runDeployInner 回填。
    const now0 = Date.now();
    const deployId = `dep_${crypto.randomBytes(8).toString('hex')}`;
    try {
        await db.insert(schema.deployments).values({
            id: deployId, userId, projectId: project.id, sessionId: sessionId || null,
            runtimeId: null, kind: 'deploy', status: 'building', stage: 'A',
            createdAt: now0, updatedAt: now0, createdBy: userId,
        });
        deployRef.id = deployId;
        if (onStarted) {
            try { onStarted(deployId); } catch (_) { /* SSE 断开不影响部署 */ }
        }
    } catch (e) {
        console.error('[twoStage] failed to persist deploy record:', e.message);
    }
    let result;
    try {
        result = await runDeployInner({ project, userId, projectId, sessionId, resume: Boolean(resume) || reclaimedOrphans > 0, report, startedAt, deployRef, isAborted: aborted, deployState });
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
                    // 失败/中止都落 last_error_*（前端据此展示真实原因；超时与用户中止均 status=stopped，
                    // 用 code 区分）。错误信息取 result.error（已优先透传系统依赖预配归因）。
                    ...(result && !result.ok && !result.aborted ? {
                        lastErrorCode: String(result.code || 'verify_failed').slice(0, 80),
                        lastErrorMessage: String(result.error || result.finalStderr || result.verify?.warning || '部署失败').slice(0, 500),
                    } : {}),
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
    const deployStart = Date.now();
    let stageAMs = 0;
    let verifyStart = 0;
    let provisionMs = 0;
    // 函数级声明：provision 裸块（L3051 起）内的 let 是块作用域，verify 失败分支（裸块外）
    // 引用会 ReferenceError: dbProvision is not defined（xensemble 实测部署因此崩溃）。
    let dbProvision = { ready: false, reason: 'not needed' };
    // 同理函数级：preview 复验（backendWheel.built）在 plan 缓存路径下也要拿到本次
    // provision 实况（缓存 plan 不含 backendWheel 字段——白屏复现实测）。
    let k3sProvision = { ready: false, reason: 'not needed' };
    let backendWheel = { built: false, pkg: null, entry: null };

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

    // 部署记录已在 runAutoTwoStageDeploy 入口提前创建（deployRef.id），这里仅回填
    // runtimeId（创建时运行时未就绪，只能置空）。
    if (deployRef.id && runtimeId) {
        db.update(schema.deployments)
            .set({ runtimeId, updatedAt: Date.now() })
            .where(eq(schema.deployments.id, deployRef.id))
            .catch((e) => console.error('[twoStage] backfill deploy runtimeId:', e.message));
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

    // 方案乙（续修干净化）：上次失败的 agent 对源码的半成品修改全部回滚。
    // 失败部署的 agent 修改通常是未完成/错误的（sed 乱改 auth.js、随手降级依赖等），
    // 带着它们续修 = agent 在错误认知 + 脏状态上继续，越修越糟（实测续修 17 轮打转）。
    // 只回滚已跟踪文件的修改（git checkout -- .）；未跟踪内容（.env、node_modules、
    // 构建产物、.agents、.pnpm-store）全部保留——依赖缓存与用户配置不丢，重装秒级。
    // 同时清掉上次部署起的残留服务进程，避免端口占用污染本次 verify。
    if (resumeState && ref) {
        try {
            // 多仓库布局：.git 在各子目录（frontend/.git、backend/.git），/workspace 本身
            // 不是 git 仓库——对每个含 .git 的目录分别回滚；单仓库则 /workspace/.git 命中。
            await runtime.exec.exec('sh', ['-c',
                'if [ -d .git ]; then git checkout -- . 2>&1 | head -3; fi; '
                + 'for d in */; do if [ -d "$d.git" ]; then (cd "$d" && git checkout -- . 2>&1 | head -3); fi; done; '
                + 'pkill -f "node src/server.js" 2>/dev/null; pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; '
                + 'pkill -f uvicorn 2>/dev/null; pkill -f gunicorn 2>/dev/null; pkill -f "npx serve" 2>/dev/null; '
                + 'pkill -f "python3 -m http.server" 2>/dev/null; pkill -f "vite --host" 2>/dev/null; sleep 1; true'],
                {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 30000 });
            console.error('[twoStage] resume: worktree tracked changes reverted + stale service processes killed (clean continuation env)');
        } catch (e) {
            console.error(`[twoStage] resume: worktree reset failed (non-fatal): ${e.message}`);
        }
    }

    // 先查跨次部署的计划缓存：命中则跳过 opencode/LLM 探索分析（二次部署省 1~4 分钟）。
    // 用项目内容指纹做失效判断：内容变了即使 TTL 内也会重新分析。
    // 用真实 host 路径（hostPath）而非 hostWs/wsPath —— boxlite 下 hostWs 可能 undefined、
    // wsPath 是沙箱内路径（宿主上不存在），会导致 fingerprint 恒为 null、缓存永不失效。
    let planFingerprint = computeProjectFingerprint(hostPath, wsPath);
    if (!plan) {
        const cached = await loadPlanCache(project.id, planFingerprint);
        if (cached && cached.context?.lastVerifyFailed) {
            // 失败降级：上次用此计划验证未通过 → 视同缓存未命中，重新走阶段 A 分析，
            // 不再复用（成功后回写会自动清掉该标记）。
            console.error(`[twoStage] plan cache degraded by lastVerifyFailed (${cached.context?.lastVerifyError || 'unknown'}), re-analyzing`);
            report({ stage: 'A', message: '上次部署验证失败，跳过计划缓存重新分析' });
        } else if (cached) {
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
        // 传 hostPath（真实 host 项目目录）而非 hostWs：attach-only 部署路径
        // （ensureProjectRuntime 早退分支）不返回 hostWorkspacePath，hostWs 可能为
        // undefined → analyzeDeploy 内部 detectStack 退化成 detectStack('/workspace')，
        // 而 host 的 /workspace 是平台 seed 的欢迎页目录（index.html "Workspace ready"），
        // 会把任意项目误判成 static（startCmd=python3 -m http.server），生成的 fallback
        // plan serve 步骤变成 python3，verify 阶段误判工具链缺失（AgentHarness/multica 实测）。
        const planResult = await analyzeProjectDeploy({ workspacePath: wsPath, hostWorkspacePath: hostPath, runtimeRef: ref, isAborted: () => isAborted() });
        if (planResult?.aborted) {
            return { ok: false, aborted: true, error: '部署已中止', elapsedMs: Date.now() - startedAt };
        }
        if (!planResult || !planResult.steps?.length) {
            return { ok: false, error: '阶段 1 失败：未生成计划', planResult };
        }
        plan = { steps: planResult.steps, configFiles: planResult.configFiles || [], source: planResult.source, warning: planResult.warning, _tree: planResult.contextTree || null };
        planFresh = true;
        report({ stage: 'A', message: `阶段 1 完成: ${plan.steps.length} 步, ${plan.configFiles.length} configs (${planResult.source || 'fallback'})` });
        stageAMs = Date.now() - deployStart;
        console.error(`[twoStage] project=${projectId} stage A done in ${stageAMs}ms`);
    }

    report({ stage: 'B', message: resumeState ? '阶段 2：续修（接回上次对话继续修复）' : '阶段 2：调用 LLM 2（agent）准备环境 + 测试 + 自动修复' });
    // 多仓库导入的 clone 是后台异步任务——verify 前必须等所有仓库 clone 到达终态
    // （ready/failed），否则 backend/ 等副仓库目录不存在/不完整 → 结构探测全部漏判
    // （hasBackend=false）→ 后端没起也被静默放行 → 白屏部署（frontend+backend 实测）。
    // 上限 3 分钟：clone 正常几十秒；超时不阻塞部署（按当前状态继续，backend 缺失由
    // verify 的 backendEvidence/nudge 机制兜底提示）。
    try {
        const repoRows = await db.select().from(schema.projectRepos).where(eq(schema.projectRepos.projectId, project.id));
        const pending = repoRows.filter((r) => r.cloneStatus === 'pending' || r.cloneStatus === 'cloning');
        if (pending.length) {
            console.error(`[twoStage] waiting for multi-repo clone (${pending.map((r) => r.subPath).join(', ')} still cloning)...`);
            const waitStart = Date.now();
            for (let i = 0; i < 60; i++) {
                await new Promise((r) => setTimeout(r, 3000));
                const rows2 = await db.select().from(schema.projectRepos).where(eq(schema.projectRepos.projectId, project.id));
                const stillPending = rows2.filter((r) => r.cloneStatus === 'pending' || r.cloneStatus === 'cloning');
                if (!stillPending.length) break;
                if (isAborted?.()) break;
                if (Date.now() - waitStart > 180000) {
                    console.error(`[twoStage] multi-repo clone wait timeout after 3min (${stillPending.map((r) => r.subPath).join(', ')} still cloning) — continuing with current state`);
                    break;
                }
            }
            console.error(`[twoStage] multi-repo clone wait done in ${Math.round((Date.now() - waitStart) / 1000)}s`);
        }
    } catch (e) {
        console.error(`[twoStage] multi-repo clone wait failed (non-fatal): ${e.message?.slice(0, 150)}`);
    }
    verifyStart = Date.now();
    console.error(`[twoStage] project=${projectId} verify agent START after ${verifyStart - deployStart}ms`);
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
        // 镜像源提速：apt/npm/pip/go/cargo/maven 统一切国内源（幂等、best-effort），
        // 必须在 verify agent 执行任何 install 之前完成——这是首次部署超时的主要性能杠杆。
        await configureGuestMirrors(ref, wsPath, (m) => console.error(`[twoStage] ${m}`));
        // 依赖目录写入 .git/info/exclude（幂等、非致命），同样必须在 install 之前：
        // install 一旦落盘 node_modules，git 变更面板立即被污染。
        await ensureDependencyExcludeInGuest(ref, wsPath, (m) => console.error(`[twoStage] ${m}`));
        // 并行前置：workspace ownership fix + deps cached check + postgres provision。
        // 必须在 verify agent 执行任何 install 之前完成——这是首次部署超时的主要性能杠杆。
        // needsPostgres 判定：**不再信任 plan.needsPostgres**（来自阶段 A 的 LLM 输出，会漏标
        // ——xensemble 实测：plan 漏标 → PG 未预配 → 后端 login/register 5xx → agent 自己
        // 装 PG + 乱改源码，烧掉全部轮数）。一律调用 provisionPostgresIfNeeded，由它内部的
        // 沙箱 grep 权威判定（毫秒级，不需要 DB 时立即返回 not needed）。
        const provisionStart = Date.now();
        // 系统服务依赖探测（宿主侧确定性扫描）兜底 LLM 的 needsPostgres：LLM plan 漏判/走
        // fallback plan 时仍能命中需要 postgres 的项目，把安装提前到 verify 之前，
        // 避免 verify agent 现场 apt 试错卡死（实测 60 轮耗尽 → 部署失败）。
        let systemDeps = { services: [], signals: [] };
        // 启动命令候选探测（启发式、可能不准）：注入 verify，失败时引导 agent 重新探测
        // 项目文档找真实启动命令，避免猜错启动命令后陷入重复循环（multica 类项目实测）。
        let startCandidates = { candidates: [], ports: [], hints: [] };
        try {
            const { detectSystemDeps: detectSysDeps, detectStartCandidates: detectStarts } = require('./detectStack');
            systemDeps = detectSysDeps(hostPath) || systemDeps;
            startCandidates = detectStarts(hostPath) || startCandidates;
        } catch { /* 探测失败不阻塞 */ }
        const needsPg = Boolean(plan?.needsPostgres) || systemDeps.services.includes('postgres');
        console.error(`[twoStage] project=${project.id} provision parallel START (needsPostgres=${needsPg}, systemDeps=${systemDeps.services.join(',') || 'none'}, toolchains=${(systemDeps.toolchains || []).map((t) => t.tool).join(',') || 'none'}, startCandidates=${startCandidates.candidates.length})`);
        // 并行前置：工具链预装（Java/Maven 等）+ 数据库/缓存服务（postgres/mysql/redis）并行跑，
        // apt/启动时间不阻塞 verify。aptSafeInstall 内部有清锁 + DPkg::Lock::Timeout=300，
        // 多个 apt 并行最多互相等待，不会死锁。
        const results = await Promise.allSettled([
            repairHostWorkspaceOwnership(hostPath), // host 侧 chown，同步快
            detectDepsCached(ref, wsPath, detected), // guest 侧 deps 探测（改动 2：传入 stack 选对应语言脚本）
            provisionDbServices({ runtimeRef: ref, workspacePath: wsPath, hostWorkspacePath: hostPath, services: systemDeps.services, plan, onLog: (m) => { console.error(`[twoStage] ${m}`); report({ stage: 'B', substage: 'prepare', message: m }); } }),
            ensureK3sIfNeeded(ref, wsPath, systemDeps), // k8s 依赖应用：预装 k3s 单节点（幂等）
            ensureBackendWheelIfNeeded(ref, wsPath), // wheel-integrity 类 Python 包：预构建+安装 wheel（幂等）
            ensureGuestToolchains({
                runtimeRef: ref, workspacePath: wsPath, toolchains: systemDeps.toolchains || [],
                onLog: (m) => { console.error(`[twoStage] ${m}`); report({ stage: 'B', substage: 'prepare', message: m }); },
            }),
        ]);
        provisionMs = Date.now() - provisionStart;
        console.error(`[twoStage] project=${project.id} provision parallel done in ${provisionMs}ms`);

        // 解析并行结果
        const ownershipResult = results[0];
        const depsResult = results[1];
        const pgResult = results[2];
        const k3sResult = results[3];
        if (k3sResult.status === 'fulfilled') k3sProvision = k3sResult.value || k3sProvision;
        else console.error(`[twoStage] k3s provision rejected: ${k3sResult.reason}`);
        if (k3sProvision.ready) {
            console.error(`[twoStage] k3s ready: kubeconfig at ${k3sProvision.kubeconfig}`);
        } else if (k3sProvision.reason === 'k3s_unavailable_overlay_forbidden') {
            console.error('[twoStage] k3s confirmed unavailable in this sandbox (nested overlay forbidden) — verify prompt will steer the agent to the app no-k8s mode');
        }
        const wheelResult = results[4];
        if (wheelResult.status === 'fulfilled') {
            const w = wheelResult.value || {};
            backendWheel = { built: Boolean(w.ok), pkg: w.pkg || null, entry: w.entry || null };
            if (backendWheel.built) console.error(`[twoStage] backend wheel ready: ${w.pkg} (entry: ${w.entry}) — agent runs it directly`);
        } else {
            console.error(`[twoStage] backend wheel provision rejected: ${wheelResult.reason}`);
        }
        const toolchainsResult = results[5];

        if (ownershipResult.status === 'rejected') {
            console.error(`[twoStage] ownership fix failed: ${ownershipResult.reason}`);
        }
        const depsRes = depsResult.status === 'fulfilled' ? depsResult.value : { overallCached: false, perPackage: {} };
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
        // dbProvision 从上方并行 provision 的结果解析（PG 预配由 provisionPostgresIfNeeded
        // 内部权威判定，这里只解析结果）。变量已在函数顶部声明（裸块外），这里仅赋值。
        // 通用 db 服务结果（postgres/mysql/redis 各服务就绪状态）→ dbServices 注入 prompt；
        // postgres 增强结果（建库建用户凭据）→ dbProvision（兼容旧结构）。
        let dbServices = [];
        dbProvision = { ready: false, reason: 'not needed' };
        if (pgResult.status === 'fulfilled' && Array.isArray(pgResult.value.results)) {
            dbServices = pgResult.value.results;
            const pgEntry = dbServices.find((r) => r.service === 'postgres');
            if (pgEntry) {
                dbProvision = { ready: !!pgEntry.ready, code: pgEntry.code || null, reason: pgEntry.reason || null };
                if (pgEntry.dbUser) dbProvision.dbUser = pgEntry.dbUser;
                if (pgEntry.dbName) dbProvision.dbName = pgEntry.dbName;
                if (pgEntry.dbPassword) dbProvision.dbPassword = pgEntry.dbPassword;
            }
        } else if (pgResult.status === 'rejected') {
            console.error(`[twoStage] db provision failed: ${pgResult.reason}`);
            dbProvision = { ready: false, code: 'provision_error', reason: pgResult.reason?.message || String(pgResult.reason), detail: null };
        }
        console.error(`[twoStage] db provision: ${dbServices.map((r) => `${r.service}=${r.ready ? 'UP' : 'down'}`).join(' ') || 'none'} (postgres ready=${dbProvision.ready} code=${dbProvision.code || '-'})`);
        // 平台侧确定性 install（在 agent 启动前把依赖装齐）：结果注入 verify prompt，
        // agent 不再重复 install——这是部署时长最大的单项优化（实测 install 占 60%+）。
        let platformInstall = { ran: false };
        try {
            platformInstall = await runPlatformInstall({
                runtimeRef: ref, workspacePath: wsPath, hostWorkspacePath: hostPath, stack: detected, depsStatus,
                onLog: (m) => { console.error(`[twoStage] ${m}`); report({ stage: 'B', substage: 'prepare', message: m }); },
            });
            if (platformInstall.ran && platformInstall.finalStatus && Object.keys(platformInstall.finalStatus.perPackage || {}).length) {
                // 用 install 后的重探测结果刷新依赖状态（prompt 拿到的是装完后的真实状态）
                depsStatus = platformInstall.finalStatus.perPackage;
                depsCached = platformInstall.finalStatus.overallCached;
            }
        } catch (e) {
            console.error(`[twoStage] platform install error (non-fatal, agent will install): ${e.message?.slice(0, 200)}`);
        }
        // Go 工具链版本预检与预装：go.mod 要求版本高于沙箱时平台直接装好（npmmirror 镜像），
        let goToolchain = { ran: false };
        try {
            goToolchain = await ensureGuestGoToolchain({
                runtimeRef: ref, workspacePath: wsPath, hostWorkspacePath: hostPath,
                onLog: (m) => { console.error(`[twoStage] ${m}`); report({ stage: 'B', substage: 'prepare', message: m }); },
            });
        } catch (e) {
            console.error(`[twoStage] go toolchain ensure error (non-fatal): ${e.message?.slice(0, 200)}`);
        }
        // 统一运行时版本预装：Node / Python / Rust / Java（与 Go 同理，CN 镜像，避免 agent 试错）。
        let runtimeVersions = { ran: false };
        try {
            runtimeVersions = await ensureGuestRuntimeVersions({
                runtimeRef: ref, workspacePath: wsPath, hostWorkspacePath: hostPath,
                onLog: (m) => { console.error(`[twoStage] ${m}`); report({ stage: 'B', substage: 'prepare', message: m }); },
            });
        } catch (e) {
            console.error(`[twoStage] runtime versions ensure error (non-fatal): ${e.message?.slice(0, 200)}`);
        }
        // 注入 unigateway 二进制：仅对被部署应用是 xensemble 类（server/src/gateway 存在）时执行，
        // 使后端能自动拉起网关，预览里「配网关」可用。非此类项目跳过（避免无谓的 11MB 传输）。
        if (isXensemble) {
            await injectGatewayBinary(ref, wsPath, (m) => console.error(`[twoStage] ${m}`));
        }
        // 改动 2：plan.context 同时存 depsCached (boolean, 向后兼容) + depsStatus (per-subpackage)
        plan = { ...plan, context: { tree, depsCached, depsStatus, platformInstall: platformInstall.ran ? { ran: true, ok: !!platformInstall.ok, cmds: platformInstall.cmds || [], remainingStale: platformInstall.remainingStale ?? null } : null, goToolchain: goToolchain.ran ? { ok: !!goToolchain.ok, version: goToolchain.version || null, installed: !!goToolchain.installed } : null, runtimeVersions: runtimeVersions.ran ? runtimeVersions : null, stack: { type: detected?.type, framework: detected?.framework }, systemDeps: systemDeps.services, toolchains: systemDeps.toolchains || [], toolchainResults: toolchainsResult.status === 'fulfilled' ? toolchainsResult.value : null, startCandidates, dbServices, dbReady: dbProvision.ready, dbProvision: dbProvision.ready ? { ready: true } : { ready: false, code: dbProvision.code || null, reason: dbProvision.reason || null }, dbUser: dbProvision.dbUser || null, dbName: dbProvision.dbName || null, dbPassword: dbProvision.dbPassword || null, k3sReady: k3sProvision.ready, k3sKubeconfig: k3sProvision.kubeconfig || null, k3sHigressCrds: k3sProvision.higressCrds === true, backendWheel, successRun: plan._successRun || null } };
        delete plan._successRun;
        // 新分析出的计划回写缓存，供二次部署跳过阶段 A（depsCached 是本次检测结果，不固化）。
        // 缓存策略：只缓存真正从 LLM 出的 plan（source='opencode'/'ai'）。detectStack 兜底
        // 的 plan（source 含 'detectstack' / 'opencode-rejected'）不缓存——兜底是纯文件探测的产物
        // （detectStack < 100ms），重算成本几乎为零；缓存会污染二次部署（heuristic 与
        // LLM 意图可能不一致）。
        if (planFresh && plan.source && !/detectstack|rejected/i.test(plan.source || '')) {
            await savePlanCache(project.id, { steps: plan.steps, configFiles: plan.configFiles, source: plan.source, context: { tree, fingerprint: planFingerprint } });
        } else if (planFresh) {
            console.error(`[twoStage] skip caching plan (source=${plan.source || 'unknown'}) — heuristic or fallback plan, recompute on next deploy`);
        }
    }
    // backendWheel 等预配实况必须在 planFresh 分支之外补写：二次部署走 plan 缓存时
    // 不会进入上面的注入点，而 preview 复验（backendWheel.built）依赖它判断是否为
    // wheel-integrity 项目——缓存 plan 缺字段会导致复验被跳过（白屏复现实测）。
    // 注意：这里只引用函数级变量（backendWheel/k3sProvision/dbProvision），绝不引用
    // planFresh 分支内的局部变量（tree/depsCached 等）——否则走缓存路径必然
    // ReferenceError 且被外层 catch 吞掉，后续 preview 全部失效（两轮白屏实测）。
    plan = { ...plan, context: { ...(plan.context || {}), backendWheel: { built: Boolean(backendWheel.built), pkg: backendWheel.pkg || null, entry: backendWheel.entry || null }, k3sReady: plan?.context?.k3sReady ?? k3sProvision.ready, dbReady: plan?.context?.dbReady ?? dbProvision.ready } };
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

    // 总超时默认 60 分钟（DEPLOY_TOTAL_TIMEOUT_MS 可配）。40min 实测不够重型项目
    // （multi-repo + gpustack 依赖安装 4min + umi 构建 3min + agent 深思考每轮至 100s）。
    // 超时不加时——性能问题通过镜像源提速（configureGuestMirrors）与断点续修解决。
    const totalTimeoutMs = DEPLOY_TOTAL_TIMEOUT_MS;

    // 超时语义：到点触发 cancelled 让 verify agent 在下一轮检查点优雅退出（带回
    // messages/trail 进度）。fallback 先行返回保证前端及时收到超时结果；agent 的
    // 收尾结果在后台落地 saveVerifyState，供“继续部署”断点续修（工具链/依赖已装
    // 一半的进度不丢，续跑通常几分钟内完成）。
    const verifyTimeoutPayload = {
        ok: false,
        aborted: true,
        code: 'deploy_timeout',
        error: `部署验证超时（超过 ${Math.round(totalTimeoutMs / 60000)} 分钟）已自动中止`,
        warning: '部署验证超时已中止。可点击“继续部署”从上次进度断点续修（已完成的安装/构建不会重跑）。',
    };
    // 清掉残留的前端构建产物（.next/out/dist），迫使 verify 重新构建——
    // 避免 agent 看到 .next 已存在就跳过 build、复用残缺产物导致预览白屏（见函数注释）。
    await clearStaleBuildArtifacts(ref, wsPath);
    await clearStaleListeners(ref, wsPath);

    let verifySettled = false;
    const verify = await new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (verifySettled) return;
            deployState.cancelled = true;
            console.error(`[twoStage] deploy total timeout (${Math.round(totalTimeoutMs / 60000)}min), cancelling verify agent project=${project.id}`);
            verifySettled = true;
            resolve(verifyTimeoutPayload);
        }, totalTimeoutMs);
        analyzeProjectVerify({
            workspacePath: wsPath,
            hostWorkspacePath: hostPath,
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
        }).then(
            (v) => {
                if (verifySettled) {
                    // 超时已先行返回：把 agent 的收尾进度异步落库供断点续修
                    if (v && Array.isArray(v.messages) && v.messages.length) {
                        saveVerifyState(project.id, { plan, messages: v.messages, trail: v.trail, roundsUsed: v.roundsUsed, runtimeRef: ref, workspacePath: wsPath })
                            .then(() => console.error('[twoStage] verify progress saved after timeout (resume ready)'))
                            .catch((e) => console.error('[twoStage] late saveVerifyState error:', e.message));
                    }
                    return;
                }
                verifySettled = true;
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                if (verifySettled) return;
                verifySettled = true;
                clearTimeout(timer);
                // verify promise reject（如 ReferenceError）≠ 用户超时：error 单独标记
                // verify_crash 并打全堆栈——此前复用 deploy_timeout 语义把代码崩溃
                // 伪装成"部署超时"（p is not defined / runtime is not defined 均实测），
                // 堆栈不落日志导致无从定位。
                console.error(`[twoStage] verify promise rejected: ${e?.message}\n${e?.stack || '(no stack)'}`);
                resolve({
                    ok: false,
                    aborted: true,
                    code: 'verify_crash',
                    error: `验证过程内部错误：${e?.message || e}（可点击“继续部署”重试）`,
                    warning: String(e?.message || e),
                });
            },
        );
    });
    clearInterval(substageHeartbeat);
    if (verify.aborted) {
        // 手动中止或 agent 优雅超时退出：带上进度落库，前端可“继续部署”断点续修
        if (Array.isArray(verify.messages) && verify.messages.length) {
            try {
                await saveVerifyState(project.id, { plan, messages: verify.messages, trail: verify.trail, roundsUsed: verify.roundsUsed, runtimeRef: ref, workspacePath: wsPath });
                console.error('[twoStage] aborted verify progress saved (resume ready)');
            } catch (e) {
                console.error('[twoStage] saveVerifyState error (aborted):', e.message);
            }
        }
        return { ok: false, aborted: true, code: verify.code || undefined, error: verify.error || '部署已中止', elapsedMs: Date.now() - startedAt };
    }
    report({
        stage: 'B',
        message: `阶段 2 ${verify.ok ? '✓ 通过' : '✗ 失败'}（agent: ${verify.source || 'opencode'}）`,
    });
    // 平台兜底（代码级，数据驱动）：verify 失败但平台预构建了 wheel-integrity 后端时，
    // 不立即判死——平台确定性拉起后端（spawn 长命通道）+ 探活，成功则部署转成功。
    // 触发条件全部来自预配实况（backendWheel.built），无 wheel 的项目零感知；
    // 拉起失败维持原失败结果（不掩盖 agent 的真实错误）。
    if (!verify.ok && !verify.aborted && backendWheel?.built && backendWheel?.entry) {
        const rescuePort = Number(verify?.appPort) || Number(plan?.context?.startCandidates?.ports?.[0]) || 8000;
        const rUser = dbProvision?.dbUser || plan?.context?.dbUser || backendWheel.entry;
        const rDb = dbProvision?.dbName || plan?.context?.dbName || backendWheel.entry;
        const rPass = dbProvision?.dbPassword || plan?.context?.dbPassword || backendWheel.entry;
        console.error(`[twoStage] verify failed but wheel backend available — platform rescue attempt: spawn ${backendWheel.entry} on :${rescuePort}`);
        try {
            const rescue = await platformRescueWheelBackend({ runtimeRef: ref, workspacePath: wsPath, entry: backendWheel.entry, port: rescuePort, dbUrl: `postgresql://${rUser}:${rPass}@127.0.0.1:5432/${rDb}` });
            if (rescue.ok) {
                console.error(`[twoStage] platform rescue SUCCESS: backend alive on :${rescuePort} — converting verify failure to success`);
                verify = {
                    ...verify,
                    ok: true,
                    appPort: rescuePort,
                    apiVerdict: 'platform_rescued',
                    apiEndpoints: verify.apiEndpoints?.length ? verify.apiEndpoints : ['/version'],
                    source: verify.source || 'ai',
                    warning: `${verify.warning || ''} [平台兜底：agent 未启动后端，平台已通过预配的 ${backendWheel.entry} 确定性拉起并探活]`.slice(0, 400),
                };
            } else {
                console.error(`[twoStage] platform rescue failed (${rescue.reason}) — keeping original verify failure`);
            }
        } catch (e) {
            console.error(`[twoStage] platform rescue error (non-fatal): ${e.message?.slice(0, 150)}`);
        }
    }
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
        // 失败降级：给 plan cache 打上 lastVerifyFailed 标记（覆盖写入，同时清掉旧
        // successRun——失败的部署不应保留任何"成功轨迹"）。下次部署命中缓存时视同
        // 未命中、重新走阶段 A 分析，切断"缓存固化的坏计划被反复复用"的继承链。
        try {
            await savePlanCache(project.id, {
                steps: plan.steps,
                configFiles: plan.configFiles || [],
                source: plan.source,
                context: {
                    tree: plan.context?.tree || null,
                    fingerprint: planFingerprint,
                    lastVerifyFailed: true,
                    lastVerifyError: String(verify.warning || verify.finalStderr || 'verify failed').slice(0, 300),
                },
            });
            console.error(`[twoStage] plan cache marked lastVerifyFailed: ${String(verify.warning || '').slice(0, 120)}`);
        } catch (e) {
            console.error('[twoStage] mark plan cache failed error:', e.message);
        }
        // 失败优先透传"平台系统依赖预配失败"的真实归因（ENOSPC/dpkg_broken/service_not_up 等），
        // 其次是 verify agent 的 warning——让部署记录/前端展示可操作的原因，而不是笼统文案。
        const dbFailReason = (!dbProvision.ready && dbProvision.code)
            ? `系统依赖 postgres 平台预配失败（${dbProvision.code}）：${dbProvision.reason || ''}`
            : null;
        const primaryError = dbFailReason || verify.warning || '阶段 2 验证失败';
        return {
            ok: false,
            stage: 'verify',
            plan,
            verify,
            code: dbFailReason ? `system_dep_provision_failed` : undefined,
            error: primaryError,
            finalStderr: dbFailReason ? `${dbFailReason}\n${verify.finalStderr || ''}` : verify.finalStderr,
            elapsedMs: Date.now() - startedAt,
        };
    }

    // 通过 → 清理可续状态
    await clearVerifyState(project.id);
    // 提取并回写「成功执行轨迹」，供二次部署直接把成功命令注入 verify agent 快速复现。
    // serve/启动类命令仅在 API 探测确认后端可用（或项目无后端）时才入缓存（见 SERVE_CMD_RE）：
    // "根 200 但 API 死"的部署不再把坏启动命令固化为成功轨迹。
    try {
        const { detectBackendSignature } = require('./detectStack');
        const apiAlive = verify.apiVerdict === 'alive' || verify.apiVerdict === 'backend_listening';
        const hasBackend = detectBackendSignature(hostPath || null).hasBackend;
        // 质量门槛：appPort 必须是内容探测确认的真前端（frontendServed）。端口扫描兜底
        // 判活的部署（backend_listening），其 appPort 可能指向只返回 "ok" 的健康服务
        // （dify 实测：预览整页只有一个 "ok"）——这类部署照常成功展示，但 serve 类命令
        // 与 successRun 不进缓存，防止坏部署污染二次部署的重放轨迹。
        const frontendVerified = verify.frontendServed !== false; // undefined（正常内容探测路径）= 通过
        const allowServe = (apiAlive || !hasBackend) && frontendVerified;
        const successRun = extractSuccessCommands(verify.trail, allowServe);
        if (successRun.length) {
            await savePlanCache(project.id, {
                steps: plan.steps,
                configFiles: plan.configFiles || [],
                source: plan.source,
                context: { tree: plan.context?.tree || null, fingerprint: planFingerprint, successRun },
            });
            console.error(`[twoStage] success run cached (${successRun.length} commands, apiVerdict=${verify.apiVerdict || 'none'}, allowServe=${allowServe})`);
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
        // 多前缀 API 分流：verify agent 上报的非标准 API 前缀（如 dify 的 /console/api）
        // 与其后端端口（agent 起的后端 / 端口扫描兜底发现）→ 传给 preview 代理分流，
        // 前端的 /console/api/* 请求才能到达独立的后端进程。
        const apiPrefixes = Array.isArray(verify?.apiPrefixes) ? verify.apiPrefixes : [];
        const backendPortFromVerify = Number(verify?.backendPort) || 0;
        let served = null;
        let mode = 'static';
        const previewLog = (m) => console.error(`[twoStage] ${m}`);
        console.error(`[twoStage] preview: verify.ok=${verify.ok} verify.appPort=${verify?.appPort ?? 'null'} -> using port ${port}`);

        // preview 时刻复验：verify 通过（apiVerdict=alive）≠ preview 时刻后端还活着——
        // 实测 gpustack 在 verify 结束到 preview 之间死掉（boxlite exec 会话收割后台
        // 进程），其 UI 目录被静态 serve 接管（全部 API 路径回 index.html）→ 前端 JS
        // 拿 HTML 当 JSON → orgs.filter/nodes.forEach 白屏。
        // 触发条件【不依赖】backendWheel.built：wheel 可能是 agent 兜底构建的（预配
        // 失败时），其 wheel 同样缺 _integrity.json（上游打包 bug 与谁构建无关，实测
        // agent 构建 → exit 78 → cp 修复被熔断 → 阶段 2 失败）。流程：
        //   1) 探 appPort 是否 JSON；2) 检测安装目录缺 manifest → 幂等补；3) spawn 拉起。
        // 重启用 runtime.exec.spawn（长命通道，同 blinkForwarder 的教训：exec 起的
        // detached 进程随 exec 会话 WS 关闭被收割——spawn 起的才与预览同生命周期）。
        previewLog(`preview: recheck gate: backendWheel.built=${backendWheel?.built} verify.ok=${verify?.ok} appPort=${verify?.appPort} (diag)`);
        let previewBackendRestarted = false;
        if (verify?.ok && verify?.appPort) {
            const bePort = backendPortFromVerify || verify.appPort;
            const chk = await runtime.exec.exec('sh', ['-c',
                `for p in /version /health /api/health /auth/config /; do `
                + `ct=$(curl -s -m 4 -o /dev/null -w '%{content_type}' http://127.0.0.1:${bePort}$p 2>/dev/null); `
                + `case "$ct" in *json*) echo API_JSON; break;; esac; done; echo CHK_DONE; `
                + `ls /usr/local/lib/python3.11/dist-packages/gpustack/license/_integrity.json >/dev/null 2>&1 && echo MANIFEST_HAVE || echo MANIFEST_MISSING`],
                {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 30000 });
            const apiAlive = /API_JSON/.test(String(chk.stdout || ''));
            const manifestMissing = /MANIFEST_MISSING/.test(String(chk.stdout || ''));
            if (!apiAlive) {
                // manifest 缺失（无论 wheel 谁装的）→ 平台补（幂等；上游打包 bug 的确定性修复）
                if (manifestMissing) {
                    previewLog('preview: manifest missing in installed wheel (agent-built fallback path) — repairing');
                    await repairWheelManifest(runtime, ref, wsPath, 'gpustack');
                }
                previewLog(`preview: port ${bePort} serves no JSON at preview time — backend died after verify; restarting via spawn (long-lived channel)`);
                const entry = backendWheel?.entry || plan?.context?.backendWheel?.entry || 'gpustack';
                // DB 凭据优先用本次预配实况（dbProvision 函数级变量——provisionDbServices
                // 解析 app 自身配置得出的 user/db/password），plan.context.dbUser 只作兜底
                // （走 plan 缓存的部署里是旧值或缺失——实测导致 spawn 的后端 DB 认证失败起不来）。
                const dbUser = dbProvision?.dbUser || plan?.context?.dbUser || entry;
                const dbName = dbProvision?.dbName || plan?.context?.dbName || entry;
                const dbPassword = dbProvision?.dbPassword || plan?.context?.dbPassword || entry;
                const dbUrl = `postgresql://${dbUser}:${dbPassword}@127.0.0.1:5432/${dbName}`;
                try {
                    await runtime.exec.exec('sh', ['-c', `fuser -k ${bePort}/tcp 2>/dev/null; sleep 1; true`], {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 15000 });
                    await runtime.exec.spawn(
                        entry,
                        ['start', '--port', String(bePort), '--data-dir', '/tmp/gsdata', '--gateway-mode', 'disabled', '--disable-update-check', '--database-url', dbUrl],
                        { HOME: '/root', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
                        { runtimeRef: ref, cwd: wsPath },
                    );
                    previewBackendRestarted = true;
                    // 等后端就绪：轮询 API JSON（最长 90s——gpustack 冷启动要跑 DB 迁移 +
                    // 种子化内置后端，实测 40s 不够；探针从单一路径扩为多路径 + content-type 判定）
                    let up = false;
                    for (let i = 0; i < 45; i++) {
                        await new Promise((r) => setTimeout(r, 2000));
                        const rdy = await runtime.exec.exec('sh', ['-c',
                            `for p in /version /health /; do ct=$(curl -s -m 4 -o /dev/null -w '%{content_type}' http://127.0.0.1:${bePort}$p 2>/dev/null); case "$ct" in *json*) echo UP; break;; esac; done`],
                            {}, { runtimeRef: ref, cwd: wsPath, timeoutMs: 20000 });
                        if (/UP/.test(String(rdy.stdout || ''))) { up = true; break; }
                    }
                    previewLog(up ? `preview: backend restarted via spawn, API alive on :${bePort}` : `preview: backend spawn did not come up within 90s — check /tmp/gs-preview.log in guest`);
                } catch (e) {
                    previewLog(`preview: backend spawn failed (non-fatal): ${e.message?.slice(0, 150)}`);
                }
            }
        }

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
                const backendForApi = xensBackend?.port || backendPortFromVerify || verify?.appPort || 0;
                const aggOk = aggPort ? await startViteAggregateProxy({
                    runtimeRef: ref, workspacePath: wsPath,
                    devPort: live.port, backendPort: backendForApi, listenPort: aggPort,
                    base: `/preview/${deploymentId}/`, apiPrefixes,
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
            // rewrite proxy 起不来就"直接隧道 verify 端口"是白屏来源之一（实测 10:13：
            // rewrite proxy failed → 直连 → HTML 无 shim/base → Next Router 用带前缀
            // pathname 匹配失败 → 白屏且网络层无任何 4xx/5xx）。此处失败换端口重试，
            // 重试耗尽才允许直连兜底。
            let proxyPort = 0;
            let proxyOk = false;
            for (let attempt = 0; attempt < 3 && !proxyOk; attempt++) {
                proxyPort = (await getGuestFreePort(ref)) || 0;
                if (!proxyPort) break;
                proxyOk = await startRewriteProxy({
                    runtimeRef: ref, workspacePath: wsPath,
                    upstreamPort: verify.appPort, listenPort: proxyPort,
                    base: staticBase,
                    backendPort: backendPortFromVerify, apiPrefixes,
                    onLog: (m) => console.error(`[twoStage] ${m}`),
                });
                if (!proxyOk) console.error(`[twoStage] preview: rewrite proxy attempt ${attempt + 1} failed on :${proxyPort}, retrying`);
            }
            if (proxyOk) {
                port = proxyPort;
                console.error(`[twoStage] preview: rewrite proxy -> verify app :${verify.appPort}`);
            } else {
                console.error(`[twoStage] preview: rewrite proxy failed after retries, tunneling verify port ${verify.appPort} directly`);
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
    const totalMs = Date.now() - deployStart;
    console.error(`[twoStage] project=${projectId} TOTAL ${totalMs}ms (stageA=${stageAMs}ms provision=${provisionMs}ms verify=${Date.now() - verifyStart}ms)`);
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
                // started 确认事件：部署记录创建即推送，前端据此确认"点击已生效"
                onStarted: (deploymentId) => send({ type: 'started', deploymentId }),
            });
            if (result?.reattached) {
                // 重入：第二次点击命中在飞部署——发 started(reattached) 让前端
                // 把 recoveredId 指向已有部署，回到进行中进度，而不是误报终态。
                send({ type: 'started', deploymentId: result.deploymentId, reattached: true, stage: result.stage || null });
            } else {
                send({ type: 'result', result });
            }
        } catch (err) {
            request.log.error(err);
            send({ type: 'error', error: err.message || String(err) });
        } finally {
            try { reply.raw.end(); } catch (_) {}
        }
    });
}

module.exports = { registerAutoDeployRoutes, runAutoTwoStageDeploy, detectProjectType };
