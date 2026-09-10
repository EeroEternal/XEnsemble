const httpProxy = require('http-proxy');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { eq, and, sql } = require('drizzle-orm');
const deploymentService = require('../deployments/DeploymentService');
const previewRegistry = require('../runtime/localPreviewRegistry');
const { appendInboxLog } = require('../workspace/logInbox');
const { t } = require('../i18n');
const { db } = require('../db/index');
const schema = require('../db/schema');
const workspace = require('../workspace');
const { verifyBlinkToken } = require('./blinkToken');

// 沙箱后端经宿主控制面反向代理访问 blink-server（创建 boxlite session）的上游。
const BLINK_UPSTREAM = process.env.BLINK_PROXY_UPSTREAM || 'http://127.0.0.1:8787';
// 每个预览部署允许并发的 boxlite 会话数上限（防被部署应用滥用宿主执行平面）。
const BLINK_MAX_SESSIONS = Number(process.env.BLINK_PROXY_MAX_SESSIONS || 4);
const blinkSessionCounts = new Map(); // deploymentId -> 当前并发会话数

// 本地镜像 registry 主机（如 localhost:5000）。沙箱预览后端是旧代码、无 BLINK_BASE_IMAGE 配置，
// 会发送裸镜像名 xensemble/box-base:bookworm，blink 默认解析到公网 docker.io → 拉取 401。
// 网关据此把裸 xensemble/... 改写成 <registry>/xensemble/...（与宿主控制面一致）。
const BLINK_IMAGE_REGISTRY_HOST = (() => {
    const base = (process.env.BLINK_BASE_IMAGE || '').trim();
    const host = base.match(/^([^/]+)\//)?.[1];
    if (host && /[:.]/.test(host)) return host;
    const reg = (process.env.BLINK_IMAGE_REGISTRIES || '').split(',')[0].trim();
    if (reg) return reg.replace(/@.*$/, '');
    return 'localhost:5000';
})();

const DEFAULT_PREVIEW_HOSTS = ['localhost', '127.0.0.1'];

function loadAllowedPreviewHosts() {
    const hosts = new Set(DEFAULT_PREVIEW_HOSTS);
    const envHosts = process.env.PREVIEW_ALLOWED_HOSTS
        ? process.env.PREVIEW_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    envHosts.forEach((h) => hosts.add(h));

    const publicUrl = process.env.CONTROL_PLANE_PUBLIC_URL?.trim();
    if (publicUrl) {
        try {
            const u = new URL(publicUrl);
            if (u.host) hosts.add(u.host);
            if (u.hostname) hosts.add(u.hostname);
        } catch {
            /* ignore invalid public url */
        }
    }
    // 预览专用端口（PREVIEW_PUBLIC_URL，如 http://IP:8099）也纳入允许 host，
    // 否则 preview 请求带该 Host 会被 isAllowedPreviewHost 拒绝。
    const previewUrl = process.env.PREVIEW_PUBLIC_URL?.trim();
    if (previewUrl) {
        try {
            const u = new URL(previewUrl);
            if (u.host) hosts.add(u.host);
            if (u.hostname) hosts.add(u.hostname);
        } catch {
            /* ignore invalid preview url */
        }
    }
    return hosts;
}

const allowedPreviewHosts = loadAllowedPreviewHosts();

function isAllowedPreviewHost(request) {
    const host = request.headers.host;
    if (!host) return false;
    if (allowedPreviewHosts.has(host)) return true;
    const hostname = host.split(':')[0];
    return allowedPreviewHosts.has(hostname);
}

const proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: true,
    changeOrigin: true,
});

proxy.on('error', (err, req, res) => {
    if (res.writeHead) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Preview proxy error');
    }
    console.error('[preview-gateway]', err.message);
});

// 首次打开 preview 页面（带 token 校验通过）时种下会话 cookie，绑定浏览器到该部署。
// 之后 SPA 客户端路由导航（URL 丢失 preview_token）凭 cookie 免 token，避免深层导航 401。
// 只在 HTML 导航响应种 cookie，资源/API 不必重复种（同值幂等无害）。
proxy.on('proxyRes', (pRes, req) => {
    const deploymentId = req && req.__previewDeploymentId;
    if (!deploymentId) return;
    // 导航观测日志：非 2xx 或 HTML/RSC 响应（排查白屏时响应形态是否符合预期）
    const type = String(pRes.headers['content-type'] || '');
    if (String(req.__previewNavLog) === '1' || pRes.statusCode !== 200) {
        console.error(`[gateway] preview-res ${deploymentId} status=${pRes.statusCode} type=${type.slice(0, 60)} url=${req.url}`);
    }
    if (!/\btext\/html\b/i.test(type)) return;
    const existing = pRes.headers['set-cookie'] || [];
    pRes.headers['set-cookie'] = [...existing, previewCookieValue(deploymentId)];
});

function extractToken(request) {
    const previewHeader = request.headers['x-preview-token'];
    if (previewHeader) return previewHeader;
    try {
        const url = new URL(request.url, 'http://localhost');
        const q = url.searchParams.get('preview_token');
        if (q) return q;
    } catch {
        /* ignore */
    }
    // preview iframe 内前端发起相对请求（如 /api/... 或 /products/...）不会带 query token，
    // 但 Referer 是 preview 页面 URL（含 preview_token），可从中提取，避免网关 401。
    const referer = request.headers.referer || '';
    if (referer) {
        try {
            const refUrl = new URL(referer, 'http://localhost');
            const rt = refUrl.searchParams.get('preview_token');
            if (rt) return rt;
        } catch {
            /* ignore */
        }
    }
    return null;
}

// 预览会话 cookie：首次带 token 打开 preview 页面时种下，浏览器后续 SPA 导航/请求
// （客户端路由后 URL 丢失 ?preview_token=，Referer 也不再携带）凭此 cookie 免 token。
// 值 = base64url(JSON { id: deploymentId, exp })，仅用于确认"这个浏览器已通过该部署的
// token 校验"，不暴露原 token。
const PREVIEW_COOKIE = 'xe_preview';
const PREVIEW_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;

function previewCookieValue(deploymentId) {
    const payload = Buffer.from(JSON.stringify({ id: deploymentId, exp: Date.now() + PREVIEW_COOKIE_TTL_MS })).toString('base64url');
    return `${PREVIEW_COOKIE}=${payload}; Path=/; HttpOnly; SameSite=Lax`;
}

// 从 Cookie 头解析会话绑定的 deploymentId；无/过期返回 null。
function previewSessionId(request) {
    try {
        const cookie = String(request.headers.cookie || '');
        const m = cookie.match(/(?:^|;\s*)xe_preview=([^;]+)/);
        if (!m) return null;
        const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
        if (!payload || typeof payload.id !== 'string' || !payload.id) return null;
        if (payload.exp && Number(payload.exp) < Date.now()) return null;
        return payload.id;
    } catch {
        return null;
    }
}

async function assertDeploymentUserActive(userId) {
    const rows = await db.select({ status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
    const user = rows[0];
    if (!user || user.status !== 'active') {
        return { error: 'Account is inactive', status: 403, code: 'account_inactive' };
    }
    return null;
}

async function resolveDeployment(request, deploymentId) {
    if (!isAllowedPreviewHost(request)) {
        return { error: 'Invalid host', status: 400, code: 'invalid_host' };
    }

    const token = extractToken(request);
    if (!token) {
        // SPA 客户端路由后 URL 丢失 preview_token（深层导航 /guide/quickstart 等），
        // Referer 也可能已不带。若该浏览器此前已通过本部署 token 校验（会话 cookie 绑定
        // deploymentId），则放行——否则返回 401。
        const sessionId = previewSessionId(request);
        if (!sessionId || sessionId !== deploymentId) {
            return { error: 'Unauthorized', status: 401, code: 'missing_preview_token' };
        }
        // cookie 绑定有效，直接查部署记录（不再校验 token 哈希）
        const rows = await db.select().from(schema.deployments)
            .where(eq(schema.deployments.id, deploymentId));
        const row = rows[0];
        if (!row) return { error: 'Invalid preview token', status: 401, code: 'invalid_preview_token' };
        const inactive = await assertDeploymentUserActive(row.userId);
        if (inactive) return inactive;
        if (row.status !== 'running') {
            return { error: 'Preview is not running', status: 503, code: 'preview_not_running' };
        }
        const entry = previewRegistry.get(deploymentId);
        if (!entry) return { error: 'Preview process not found', status: 503, code: 'preview_process_not_found' };
        return { deployment: row, entry };
    }

    const row = await deploymentService.getByPreviewToken(deploymentId, token);
    if (!row) return { error: 'Invalid preview token', status: 401, code: 'invalid_preview_token' };

    const inactive = await assertDeploymentUserActive(row.userId);
    if (inactive) return inactive;

    if (row.status !== 'running') {
        return { error: 'Preview is not running', status: 503, code: 'preview_not_running' };
    }

    const entry = previewRegistry.get(deploymentId);
    if (!entry) return { error: 'Preview process not found', status: 503, code: 'preview_process_not_found' };

    return { deployment: row, entry };
}

function stripPreviewPrefix(url, deploymentId) {
    const prefix = `/preview/${deploymentId}`;
    const qIndex = url.indexOf('?');
    const pathname = qIndex >= 0 ? url.slice(0, qIndex) : url;
    const search = qIndex >= 0 ? url.slice(qIndex + 1) : '';
    let path = pathname;
    if (path === prefix || path === `${prefix}/`) {
        path = '/';
    } else if (path.startsWith(`${prefix}/`)) {
        path = path.slice(prefix.length) || '/';
    }
    // 只删除 preview_token 参数，其余 query 原样保留。不能用 URLSearchParams 重新序列化：
    // 它会把 ?worker 变成 ?worker=，破坏 vite 的 ?worker/?import 后缀语义（返回源文件而非模块 wrapper）。
    const rest = search.split('&')
        .filter((p) => p && p !== 'preview_token' && !p.startsWith('preview_token='))
        .join('&');
    return rest ? `${path}?${rest}` : path;
}

// 剥离 /preview/<deploymentId>/__blink 前缀，得到转发给 blink-server 的真实路径。
function stripBlinkPrefix(url, deploymentId) {
    const prefix = `/preview/${deploymentId}/__blink`;
    const qIndex = url.indexOf('?');
    const pathname = qIndex >= 0 ? url.slice(0, qIndex) : url;
    const search = qIndex >= 0 ? url.slice(qIndex + 1) : '';
    // 兜底：嵌套部署里沙箱 BoxLiteClient 可能把 /preview/<id>/__blink 前缀重复拼接
    // （base 带路径前缀 + attach pathname 也带），连续剥掉重复的同一前缀。
    // 用锚定 ^ 匹配，一次 replace 消费全部连续重复前缀；剥离后直接返回，不再走下方
    // "再剥一次"分支（否则剥离结果不以 prefix 开头 → 误落 null → __blink 被当普通 preview）。
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^(?:${escapedPrefix})+(?=/|$)`);
    const stripped = pathname.replace(re, '');
    if (stripped !== pathname) {
        return search ? `${stripped || '/'}?${search}` : (stripped || '/');
    }
    // 无重复前缀的普通 __blink 路径
    let path = pathname;
    if (path === prefix) {
        path = '/';
    } else if (path.startsWith(`${prefix}/`)) {
        path = path.slice(prefix.length) || '/';
    } else {
        return null; // 非 __blink 路径
    }
    return search ? `${path}?${search}` : path;
}

async function deploymentIsRunning(deploymentId) {
    try {
        const rows = await db.select({ id: schema.deployments.id })
            .from(schema.deployments)
            .where(and(eq(schema.deployments.id, deploymentId), eq(schema.deployments.status, 'running')))
            .limit(1);
        return rows.length > 0;
    } catch {
        return false;
    }
}

// 并发配额：openSession(POST /api/sessions) 增计数，deleteSession(DELETE /api/sessions/:name) 减计数。
function adjustBlinkQuota(deploymentId, method, blinkPath) {
    const base = blinkPath.split('?')[0];
    const count = blinkSessionCounts.get(deploymentId) || 0;
    if (method === 'POST' && base === '/api/sessions') {
        if (count >= BLINK_MAX_SESSIONS) return false;
        blinkSessionCounts.set(deploymentId, count + 1);
    } else if (method === 'DELETE' && /^\/api\/sessions\/[^/]+$/.test(base) && count > 0) {
        blinkSessionCounts.set(deploymentId, count - 1);
    }
    return true;
}

// 读取 raw 请求体（onRequest 阶段 fastify 尚未解析 body，流完整）。
function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// 解析外层部署的宿主工作目录：guest 的 /workspace 即挂载自此目录，
// 代理据此把 guest 内计算的 volume host_path 重写为宿主可达路径。
// 注意：部署若复用 session runtime（worktree 模式），VM 的 /workspace 实际挂载到
// `<project>.wt/<runtimeId>`，而 projects.serverPath 仍是主项目目录。必须用
// runtimes.specs.host_workspace_path 拿真实挂载点，否则重写基准错（卷路径不存在
// → boxlite "Volume host path does not exist" → box Failed → 复用时 panic）。
async function getDeploymentHostWorkspace(deploymentId) {
    try {
        const rows = await db.select({ userId: schema.deployments.userId, projectId: schema.deployments.projectId, runtimeId: schema.deployments.runtimeId })
            .from(schema.deployments)
            .where(eq(schema.deployments.id, deploymentId))
            .limit(1);
        if (!rows[0]) return null;
        if (rows[0].runtimeId) {
            const rtRows = await db.select({ specs: schema.runtimes.specs })
                .from(schema.runtimes)
                .where(eq(schema.runtimes.id, rows[0].runtimeId))
                .limit(1);
            const specs = rtRows[0]?.specs ? JSON.parse(rtRows[0].specs) : null;
            if (specs?.host_workspace_path) return specs.host_workspace_path;
        }
        return workspace.projectDir(rows[0].userId, rows[0].projectId);
    } catch { /* ignore */ }
    return null;
}

// guest 后端（被部署的 xensemble）在 guest 内起 session 时，用其自身的 WORKSPACE_ROOT
// （相对 ./data/workspaces，后端 cwd=/workspace/server）计算 volumes[].host_path，
// 这些是 guest 本地/相对路径，宿主 blink-server 无法挂载。此处把：
//   /workspace[/...] → <hostWorkspace>[/...]（guest 根即宿主项目目录挂载）
//   相对路径         → <hostWorkspace>/server/<相对>（后端 cwd 为 /workspace/server）
function rewriteVolumeHostPath(hostPath, hostWorkspace) {
    const raw = String(hostPath || '');
    if (!raw) return raw;
    if (raw === '/workspace') return hostWorkspace;
    if (raw.startsWith('/workspace/')) return path.join(hostWorkspace, raw.slice('/workspace'.length));
    if (raw.startsWith('/')) return raw; // 其它绝对路径保持原样（罕见，避免误伤）
    return path.join(hostWorkspace, 'server', raw);
}

// 代理沙箱后端对 blink-server 的请求：校验 scoped token → 透传 HTTP 到 BLINK_UPSTREAM。
async function handleBlinkProxy(request, reply, deploymentId, blinkPath) {
    const token = request.headers['x-blink-token'];
    if (!token || !verifyBlinkToken(String(token), deploymentId)) {
        return reply.code(401).send({ error: 'Unauthorized', code: 'invalid_blink_token' });
    }
    if (!(await deploymentIsRunning(deploymentId))) {
        return reply.code(503).send({ error: 'Preview is not running', code: 'preview_not_running' });
    }
    if (!adjustBlinkQuota(deploymentId, request.method, blinkPath)) {
        return reply.code(429).send({ error: 'Too many concurrent sandbox sessions', code: 'blink_quota_exceeded' });
    }

    // openSession：重写 volume host_path（guest 路径 → 宿主可达路径），否则宿主 blink 挂载失败。
    // 同时给嵌套 session 资源封顶：宿主共享同一批 KVM，被部署应用的默认 6GB 请求会打爆宿主内存。
    let buffer = null;
    if (request.method === 'POST' && blinkPath.split('?')[0] === '/api/sessions') {
        const hostWorkspace = await getDeploymentHostWorkspace(deploymentId);
        if (hostWorkspace) {
            const raw = await readRawBody(request.raw);
            try {
                const body = JSON.parse(raw.toString('utf8'));
                if (body && Array.isArray(body.volumes)) {
                    for (const v of body.volumes) {
                        if (v && v.host_path) {
                            const rewritten = rewriteVolumeHostPath(v.host_path, hostWorkspace);
                            // blink-server 要求 volume host_path 必须已存在（vmm_spawn 前 stat）。
                            // 嵌套部署时 guest 端可能未建 runtime 目录（如 git worktree add 失败），
                            // 宿主侧兜底 mkdir，避免 openSession 因目录缺失返回 500 → 前端 60s 超时。
                            // 仅当重写后仍在部署项目目录树内才补建（绝对路径保持原样的情况跳过，
                            // 防止 guest 用任意绝对路径在宿主乱建目录）。
                            const insideWorkspace = rewritten === hostWorkspace
                                || rewritten.startsWith(hostWorkspace + path.sep);
                            if (insideWorkspace) {
                                try {
                                    fs.mkdirSync(rewritten, { recursive: true });
                                } catch { /* 宿主只读/无权限时忽略，blink 会给出真实错误 */ }
                            }
                            v.host_path = rewritten;
                        }
                    }
                }
                // 镜像名改写：裸 xensemble/... → <registry>/xensemble/...（旧沙箱代码无本地 registry 配置，
                // 裸名会被 blink 解析到公网 docker.io 拉取失败 → "Not authorized"）。
                if (body && typeof body.image === 'string' && /^xensemble\//.test(body.image)) {
                    body.image = `${BLINK_IMAGE_REGISTRY_HOST}/${body.image}`;
                }
                if (body) {
                    const maxMem = Number(process.env.BLINK_PROXY_MAX_MEMORY_MIB || 2048);
                    const maxCpus = Number(process.env.BLINK_PROXY_MAX_CPUS || 2);
                    body.resources = {
                        ...(body.resources || {}),
                        memory_mib: Math.min(Number(body.resources?.memory_mib) || maxMem, maxMem),
                        cpus: Math.min(Number(body.resources?.cpus) || maxCpus, maxCpus),
                    };
                }
                const encoded = Buffer.from(JSON.stringify(body));
                buffer = Readable.from(encoded); // http-proxy 要求可 pipe 的流，原生 Buffer 无 .pipe()
                request.raw.headers['content-length'] = String(encoded.length);
                delete request.raw.headers['transfer-encoding'];
            } catch {
                buffer = raw; // 非 JSON body，原样透传（原始 Buffer 作为 body 直接 pipe）
                buffer = Readable.from(raw);
            }
        }
    }

    await new Promise((resolve, reject) => {
        reply.hijack();
        request.raw.url = blinkPath;
        request.raw.headers.host = 'localhost';
        proxy.web(
            request.raw,
            reply.raw,
            { target: BLINK_UPSTREAM, changeOrigin: false, ...(buffer ? { buffer } : {}) },
            (err) => (err ? reject(err) : resolve()),
        );
    });
}

/**
 * 注册 Preview Gateway（HTTP + WebSocket），对齐 Architecture.md Gateway 节。
 */
async function handleDevConsole(request, reply) {
    const deploymentId = request.params.deploymentId;
    const resolved = await resolveDeployment(request.raw, deploymentId);
    if (resolved.error) {
        const payload = { error: resolved.error };
        if (resolved.code) payload.code = resolved.code;
        return reply.code(resolved.status).send(payload);
    }

    const level = request.body?.level || 'log';
    const message = request.body?.message ?? '';
    // 浏览器端诊断上报（previewProxyServer 注入的 shim/RUNTIME_SCRIPT）：直接打到宿主
    // journalctl（browser 标签），不依赖 inbox workspacePath（resolveDeployment 的 entry
    // 可能无 workspacePath，inbox 会静默丢弃）。用户复现白屏后据此定位浏览器端真实行为。
    console.error(`[gateway] browser-console ${deploymentId} [${level}] ${String(message).slice(0, 500)}`);
    const workspacePath = resolved.entry.workspacePath;
    if (workspacePath) {
        appendInboxLog(workspacePath, 'browser', `${level}: ${message}`);
    }
    return reply.code(204).send();
}

// 预览专用端口（PREVIEW_PUBLIC_URL）的默认路由目标：最新 running 部署。
// 被预览的应用可能是"绝对路径 history 路由"SPA（如 react-router BrowserRouter 无 basename），
// 在 /preview/<id>/ 子路径下前端会把 URL 跳到无前缀的 /login、/api/...，脱离 /preview/ 前缀。
// 这些无前缀请求（Host = 预览专用端口）默认路由到最新部署，让此类 SPA 也能预览。
// 只返回 previewRegistry 里有真实 tunnel 条目的部署，避免重启后内存条目丢失的孤儿部署。
async function findLatestRunningPreview() {
    try {
        const rows = await db.select({ id: schema.deployments.id })
            .from(schema.deployments)
            .where(eq(schema.deployments.status, 'running'))
            .orderBy(sql`${schema.deployments.createdAt} desc`)
            .limit(5);
        for (const r of rows) {
            if (previewRegistry.get(r.id)) return r.id;
        }
        return null;
    } catch (e) {
        console.error('[gateway] findLatestRunningPreview error:', e.message);
        return null;
    }
}

async function registerPreviewGateway(fastify) {
    // 宿主根路径 + Referer/Origin 来自某个 preview 页面 → 转发到该 preview 的 tunnel。
    // 兼容前端使用根相对 API 地址（baseURL=/api 等）在 /preview/<id>/ 子路径下部署的场景。
    // 用 onRequest 钩子而非注册 '*' 路由，避免与已有通配路由冲突。
    // 关键：preview 的所有 HTTP 转发都在 onRequest 阶段 hijack —— 此时 fastify 尚未解析请求体，
    // request.raw 的 body 流完整，proxy.web 才能把 POST body 透传给后端（若走 fastify route，
    // body 已被 fastify 的 JSON parser 消费，转发时后端收不到 body → 408 超时，登录/注册全挂）。
    fastify.addHook('onRequest', async (request, reply) => {
        // WebSocket upgrade 请求（Connection: Upgrade / Upgrade: websocket）不能在此做 HTTP 转发：
        // 若 hijack + proxy.web 会把 upgrade 当普通 HTTP 代理，与 fastify.server.on('upgrade')
        // 里的 proxy.ws 双重处理同一连接，导致 WebSocket 帧数据互相污染 → 浏览器/vite 端
        // "Invalid frame header"。upgrade 统一交给 server.on('upgrade') 处理（含 __blink 与 preview WS）。
        if (String(request.headers.upgrade || '').toLowerCase() === 'websocket') return;

        const pathname = new URL(request.url, 'http://localhost').pathname;
        // __dev/console 需要 fastify 解析 body（写 inbox 日志），放行给 route 处理。
        if (pathname.includes('/__dev/console')) return;

        // __blink 代理：沙箱后端（被部署应用）经此路径访问宿主 blink-server 以创建 boxlite session。
        const blinkMatch = pathname.match(/^\/preview\/([^/]+)\/__blink(?:\/.*)?$/);
        if (blinkMatch) {
            const blinkPath = stripBlinkPrefix(request.url, blinkMatch[1]);
            if (blinkPath !== null) {
                await handleBlinkProxy(request, reply, blinkMatch[1], blinkPath);
                return;
            }
        }

        let deploymentId = null;
        let depSource = 'none';
        const previewMatch = pathname.match(/^\/preview\/([^/]+)(?:\/(.*))?$/);
        if (previewMatch) {
            deploymentId = previewMatch[1];
            depSource = 'path';
        } else {
            const referer = request.headers.referer || request.headers.origin || '';
            const m = referer.match(/\/preview\/([^/?#]+)/);
            // 预览专用端口识别：优先 nginx 打标的 X-Preview-Origin: 1 头（无论 Host 是否带端口都能识别）；
            // 兼容仅配置 $http_host（Host 含端口）的场景——精确匹配 PREVIEW_PUBLIC_URL 的 host:port，
            // 把 8088 控制台与 8099 预览分开，避免 SPA 绝对路由（/login、/api/*）落回宿主控制台。
            const previewHost = process.env.PREVIEW_PUBLIC_URL
                ? process.env.PREVIEW_PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '')
                : '';
            const isPreviewPort = request.headers['x-preview-origin'] === '1'
                || (!!previewHost && request.headers.host === previewHost);
            if (m) {
                deploymentId = m[1];
                depSource = 'referer';
            } else if (isPreviewPort) {
                // 预览专用端口上的无前缀请求（SPA 绝对路由 /login、/api/...、Next Link 整页导航后
                // 刷新等）：优先用会话 cookie 绑定的部署——iframe/pop-out 首次打开时网关已在 HTML
                // 响应种下 xe_preview（绑定实际部署），即使 URL/Referer 已无前缀也能精确路由回
                // 当前部署；比 findLatestRunningPreview（全局最新，多部署并存时可能选到别的部署）
                // 更准确。cookie 无绑定或绑定部署已不在 previewRegistry（进程退出/已停）才回退 latest。
                const cookieDep = previewSessionId(request);
                if (cookieDep && previewRegistry.get(cookieDep)) {
                    deploymentId = cookieDep;
                    depSource = 'cookie';
                } else {
                    deploymentId = await findLatestRunningPreview();
                    depSource = deploymentId ? 'latest' : 'none';
                }
            }
            if (!deploymentId) {
                // 预览专用端口上的无前缀请求若无法路由，返回 404/503，绝不落入宿主控制台（8088）。
                if (isPreviewPort) return reply.code(404).send({ error: 'Preview not found' });
                return;
            }
        }

        let entry = null;
        try {
            const realPath = stripPreviewPrefix(pathname, deploymentId);
            // 静态/模块资源不校验 preview_token：预览资源随页面公开，避免前端资源请求
            // （动态 import、vite 模块图深层 import 等）因不带 token / Referer 而 401。
            // vite dev 模式资源形态多样，必须覆盖：.js/.mjs/.jsx/.ts/.tsx/.vue/.css 源文件、
            // /node_modules/（依赖预构建产物）、/^@/（vite 运行时注入 @vite/client 等）。
            // /api、/ws 也不校验：被预览应用（尤其 BrowserRouter SPA）在 /preview/<id>/ 子路径下
            // 跳转绝对路由（如 /login）后，API 请求的 Referer 不再带 preview_token → 网关 401
            // 导致登录/注册失败。沙箱后端有自己的 JWT 鉴权：login/register 本就公开，其余接口
            // 由后端拦截，网关放行不构成数据泄露。
            const isAsset = /\.(js|mjs|jsx|ts|tsx|vue|svelte|css|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|ico|map|txt|json)$/i.test(realPath)
                || /\/assets\//.test(realPath)
                || /\/node_modules\//.test(realPath)
                || /^\/@/.test(realPath)
                || /^\/api(\/|$)/.test(realPath)
                || /^\/ws(\/|$)/.test(realPath);
            // 预览导航观测日志（诊断白屏/路由错配用，不影响行为）：
            // 记录非资源请求的解析路径与来源（path/referer/cookie/latest），重点看 Next.js <Link>
            // 客户端导航（RSC 头）与绝对路径跳转的实际请求序列与 Referer 形态。
            if (!isAsset && !pathname.includes('/__dev/console')) {
                const rsc = request.headers['rsc'] || request.headers['next-router-prefetch'] || request.headers['next-router-state-tree'] || '';
                const logLine = {
                    path: request.url, depSource, depId: deploymentId, referer: String(request.headers.referer || '').slice(0, 160),
                    host: request.headers.host, xPrev: request.headers['x-preview-origin'] || '', rsc: String(rsc).slice(0, 40), accept: String(request.headers.accept || '').slice(0, 80),
                };
                console.error(`[gateway] preview-nav ${request.method} ${JSON.stringify(logLine)}`);
                // 标记为导航类，让 proxyRes 钩子记录响应 status/content-type
                request.raw.__previewNavLog = '1';
            }
            if (isAsset) {
                entry = previewRegistry.get(deploymentId);
                if (!entry) return reply.code(503).send({ error: t('errors:preview_not_found', { defaultValue: 'Preview process not found' }, request.locale || 'en'), code: 'preview_not_found' });
            } else {
                const resolved = await resolveDeployment(request.raw, deploymentId);
                if (resolved.error) {
                    const payload = { error: resolved.error };
                    if (resolved.code) payload.code = resolved.code;
                    return reply.code(resolved.status).send(payload);
                }
                entry = resolved.entry;
            }
        } catch (e) {
            return reply.code(500).send({ error: t('errors:preview_proxy_error', { defaultValue: 'Preview proxy error' }, request.locale || 'en'), code: 'preview_proxy_error' });
        }

        const target = `http://127.0.0.1:${entry.port}`;
        const path = stripPreviewPrefix(request.url, deploymentId);

        await new Promise((resolve, reject) => {
            reply.hijack();
            request.raw.url = path;
            request.raw.headers.host = 'localhost';
            // X-Preview-Origin 是宿主 nginx 打在预览入口的内部标记，仅宿主网关消费。
            // 转发进隧道前必须剥离，否则被 preview 的应用（如 xensemble 自身）内置的
            // 同名网关会误读该头，在自己的空 preview registry 里路由 → 返回 503
            // "Preview not found"，导致 preview 页面永远打不开。
            delete request.raw.headers['x-preview-origin'];
            // 标记部署，供 proxyRes 钩子在 HTML 响应上种会话 cookie
            request.raw.__previewDeploymentId = deploymentId;
            // 标记本次请求为导航类（proxyRes 记录其响应 status/content-type，用于诊断）
            request.raw.__previewNavLog = request.raw.__previewNavLog || '0';
            proxy.web(
                request.raw,
                reply.raw,
                { target, changeOrigin: false },
                (err) => {
                    if (err) reject(err);
                    else resolve();
                },
            );
        });
    });

    fastify.post('/preview/:deploymentId/__dev/console', handleDevConsole);

    // 注意：/preview/* 的 HTTP 转发已全部由上面的 onRequest hook 处理（hijack 在 body 解析前，
    // 保证 POST body 透传），这里不再注册 /preview/:deploymentId 路由，避免与 onRequest 双重处理。

    // __blink / preview WebSocket 由本网关优先处理。
    // 关键：@fastify/websocket(server.js 早于本 gateway 注册)自带 upgrade 监听，对"未注册 WS
    // 路由"的 upgrade 会走 fastify 路由 → 无匹配 → 返回 404。若不处理，guest 的 __blink
    // attach WS 会在插件层被 404 掉（嵌套 session 创建时 exec/attach 全挂，表现为 60~120s 超时）。
    // 因此把插件监听器包装一层：本网关已处理的请求（打 __previewGatewayHandled 标记）直接跳过。
    const gatewayUpgrade = async (req, socket, head) => {
        try {
            // __blink WebSocket：沙箱后端与宿主 blink-server 的执行 attach 通道。
            const blinkWsMatch = req.url?.match(/^\/preview\/([^/?]+)\/__blink(?:\/.*)?$/);
            if (blinkWsMatch) {
                const deploymentId = blinkWsMatch[1];
                // 立即置标记（await 之前）：gatewayUpgrade 是 async，await deploymentIsRunning()
                // 期间事件循环会先跑 @fastify/websocket 插件的 upgrade 监听器（已包装成"标记跳过"）。
                // 若此处不抢先标记，插件会把 __blink attach 当未注册 WS 路由 → fastify 404，
                // 表现为嵌套 session 创建时 exec/attach 秒 404（"Unexpected server response: 404"）。
                req.__previewGatewayHandled = true;
                const token = req.headers['x-blink-token'];
                if (!token || !verifyBlinkToken(String(token), deploymentId)) {
                    console.error(`[preview-gateway] blink WS 401 dep=${deploymentId} url=${req.url} hasToken=${!!token}`);
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                if (!(await deploymentIsRunning(deploymentId))) {
                    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
                    socket.destroy();
                    return;
                }
                const blinkPath = stripBlinkPrefix(req.url, deploymentId);
                console.error(`[preview-gateway] blink WS dep=${deploymentId} path=${blinkPath} url=${req.url}`);
                if (blinkPath === null) {
                    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
                    socket.destroy();
                    return;
                }
                req.url = blinkPath;
                req.headers.host = 'localhost';
                proxy.ws(req, socket, head, { target: BLINK_UPSTREAM, changeOrigin: false }, (err) => {
                    if (err) socket.destroy();
                });
                return;
            }

            // preview WebSocket：有明确 /preview/<id>/ 前缀 → 走该部署；否则若来自 preview 端口
            // （nginx 打标 X-Preview-Origin 或 Host 精确匹配 PREVIEW_PUBLIC_URL）→ 强制路由到最新
            // running 部署，绝不落到宿主。
            let deploymentId = null;
            const previewWsMatch = req.url?.match(/^\/preview\/([^/?]+)/);
            if (previewWsMatch) {
                deploymentId = previewWsMatch[1];
            } else {
                const previewHost = process.env.PREVIEW_PUBLIC_URL
                    ? process.env.PREVIEW_PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '')
                    : '';
                if (req.headers['x-preview-origin'] === '1'
                    || (!!previewHost && (req.headers.host || '') === previewHost)) {
                    deploymentId = await findLatestRunningPreview();
                }
            }
            if (!deploymentId) return;

            // 立即置标记（await 之前）：与 __blink 分支同理，避免 await resolveDeployment 期间
            // @fastify/websocket 插件监听器抢先处理未注册 WS 路由 → fastify 404。
            req.__previewGatewayHandled = true;

            // 与 HTTP 一致：running 的 preview 资源（含 HMR/终端 WS）直接透传。
            // HMR WS 的 token 是 vite 自带的（?token=<hmr>），不是 preview_token；
            // 且 SPA 跳到绝对路由后 Referer 丢失 preview_token，走 resolveDeployment 会 401。
            let entry = previewRegistry.get(deploymentId);
            if (!entry) {
                const resolved = await resolveDeployment(req, deploymentId);
                if (resolved.error) {
                    socket.write(`HTTP/1.1 ${resolved.status} ${resolved.error}\r\n\r\n`);
                    socket.destroy();
                    return;
                }
                entry = resolved.entry;
            }

            const target = `http://127.0.0.1:${entry.port}`;
            req.url = stripPreviewPrefix(req.url, deploymentId);
            req.headers.host = 'localhost';
            delete req.headers['x-preview-origin'];
            proxy.ws(req, socket, head, { target, changeOrigin: false }, (err) => {
                if (err) socket.destroy();
            });
        } catch (err) {
            console.error('[preview-gateway] upgrade error:', err.message);
            if (!socket.destroyed) {
                socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                socket.destroy();
            }
        }
    };
    // 注册顺序关键：prepend 本网关监听，再把既有（插件的）监听器包装为跳过已处理请求。
    // 必须在 onReady 里做：@fastify/websocket 的 upgrade 监听是在插件函数体里
    // （ready 阶段）才注册到 fastify.server，若在 registerPreviewGateway 调用时捕获
    // existingUpgradeListeners 会是空数组，包装落空 → 插件监听仍最先触发，把未注册 WS
    // 路由（含 __blink attach）走 fastify 路由返回 404，嵌套 session 创建时 exec/attach
    // 全挂（表现为 60~120s 超时）。
    fastify.addHook('onReady', () => {
        const existingUpgradeListeners = fastify.server.listeners('upgrade');
        fastify.server.removeAllListeners('upgrade');
        fastify.server.prependListener('upgrade', gatewayUpgrade);
        for (const listener of existingUpgradeListeners) {
            fastify.server.on('upgrade', (req, socket, head) => {
                if (req && req.__previewGatewayHandled) return;
                listener.call(fastify.server, req, socket, head);
            });
        }
    });
}

module.exports = { registerPreviewGateway };
