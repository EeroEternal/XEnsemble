const httpProxy = require('http-proxy');
const { eq, sql } = require('drizzle-orm');
const deploymentService = require('../deployments/DeploymentService');
const previewRegistry = require('../runtime/localPreviewRegistry');
const { appendInboxLog } = require('../workspace/logInbox');
const { t } = require('../i18n');
const { db } = require('../db/index');
const schema = require('../db/schema');

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
    if (!token) return { error: 'Unauthorized', status: 401, code: 'missing_preview_token' };

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
    const [pathname, search = ''] = url.split('?');
    let path = pathname;
    if (path === prefix || path === `${prefix}/`) {
        path = '/';
    } else if (path.startsWith(`${prefix}/`)) {
        path = path.slice(prefix.length) || '/';
    }
    const qs = new URLSearchParams(search);
    qs.delete('preview_token');
    const rest = qs.toString();
    return rest ? `${path}?${rest}` : path;
}

/**
 * 注册 Preview Gateway（HTTP + WebSocket），对齐 Architecture.md Gateway 节。
 */
async function proxyPreviewRequest(request, reply) {
    const deploymentId = request.params.deploymentId;
    let entry = null;
    try {
        const urlPath = new URL(request.raw.url, 'http://localhost').pathname;
        // 静态资源（js/css/图片/字体等）不校验 preview_token：预览资源随页面公开，
        // 避免前端资源请求（动态 import 等）因不带 token / Referer 而 401。
        const isAsset = /\.(js|css|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|ico|map|txt|json)$/i.test(urlPath) || /\/assets\//.test(urlPath);
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
}

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
    fastify.addHook('onRequest', async (request, reply) => {
        console.error(`[gateway] onRequest HIT url=${request.url} ref=${String(request.headers.referer || '').slice(0, 60)}`);
        if (request.url.startsWith('/preview/')) return;
        let deploymentId = null;
        const referer = request.headers.referer || request.headers.origin || '';
        const m = referer.match(/\/preview\/([^/?#]+)/);
        // 本实例 preview 专用端口（PREVIEW_PUBLIC_URL）由 nginx 打上 X-Preview-Origin: 1
        // 标记。只有真正经过本实例 8099 入口的请求才带此头 —— 其它厂商/机器上同端口的
        // 公共服务不经过本 nginx，不会带此头，因此绝不会被误路由到 preview。
        // 注意：不能靠 Host/hostname 判断「是否 preview 端口」—— nginx 用
        // `proxy_set_header Host $host` 转发，$host 不含端口，8088 与 8099 的
        // hostname 相同，用 hostname 判断会把宿主控制台(8088)误判为 preview。
        // 所以「强制 preview」唯一以标记头为准；无标记头请求一律视为宿主侧。
        const isPreviewOrigin = request.headers['x-preview-origin'] === '1';
        if (isPreviewOrigin) {
            // 强制 preview：referer 命中 /preview/<id>/ 用该部署，否则用最新 running 部署。
            if (m) {
                deploymentId = m[1];
            } else {
                deploymentId = await findLatestRunningPreview();
            }
            // 找不到可路由的 preview：明确报错，绝不落宿主控制面。
            if (!deploymentId) {
                return reply.code(503).send({ error: 'Preview not found', code: 'preview_not_found' });
            }
            const entry = previewRegistry.get(deploymentId);
            if (!entry) {
                console.error(`[gateway] onRequest NO ENTRY url=${request.url} dep=${deploymentId} ref=${String(referer).slice(0, 80)} registry=${previewRegistry.listIds().join(',')}`);
                return reply.code(503).send({ error: 'Preview not running', code: 'preview_not_running' });
            }
            const target = `http://127.0.0.1:${entry.port}`;
            await new Promise((resolve, reject) => {
                reply.hijack();
                request.raw.headers.host = 'localhost';
                proxy.web(request.raw, reply.raw, { target, changeOrigin: false }, (err) => (err ? reject(err) : resolve()));
            });
            return;
        }
        // 非 preview 标记（宿主控制台 8088 等）：仅当 referer 明确来自某个 preview 页面
        // （SPA 绝对路由产生的无前缀请求）时转发到该 preview；否则一律走宿主，绝不用
        // hostname/host 猜测 preview 端口（会误伤宿主）。
        if (m) {
            deploymentId = m[1];
        }
        if (!deploymentId) {
            return;
        }
        const entry = previewRegistry.get(deploymentId);
        if (!entry) {
            console.error(`[gateway] onRequest NO ENTRY url=${request.url} dep=${deploymentId} ref=${String(referer).slice(0, 80)} registry=${previewRegistry.listIds().join(',')}`);
            return;
        }
        const target = `http://127.0.0.1:${entry.port}`;
        await new Promise((resolve, reject) => {
            reply.hijack();
            request.raw.headers.host = 'localhost';
            proxy.web(request.raw, reply.raw, { target, changeOrigin: false }, (err) => (err ? reject(err) : resolve()));
        });
    });

    fastify.post('/preview/:deploymentId/__dev/console', handleDevConsole);

    const proxyOpts = {
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        handler: proxyPreviewRequest,
    };
    fastify.route({ url: '/preview/:deploymentId', ...proxyOpts });
    fastify.route({ url: '/preview/:deploymentId/*', ...proxyOpts });

    fastify.server.on('upgrade', async (req, socket, head) => {
        try {
            // 有明确 /preview/<id>/ 前缀 → 走该部署；否则若来自 preview 端口（nginx 打标）
            // 则强制路由到最新 running 部署，绝不落到宿主。
            let deploymentId = null;
            const m = req.url?.match(/^\/preview\/([^/?]+)/);
            if (m) {
                deploymentId = m[1];
            } else if (req.headers['x-preview-origin'] === '1') {
                deploymentId = await findLatestRunningPreview();
            }
            if (!deploymentId) return;

            const resolved = await resolveDeployment(req, deploymentId);
            if (resolved.error) {
                socket.write(`HTTP/1.1 ${resolved.status} ${resolved.error}\r\n\r\n`);
                socket.destroy();
                return;
            }

            const target = `http://127.0.0.1:${resolved.entry.port}`;
            req.url = stripPreviewPrefix(req.url, deploymentId);
            req.headers.host = 'localhost';
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
    });
}

module.exports = { registerPreviewGateway };
