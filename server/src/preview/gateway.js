const httpProxy = require('http-proxy');
const { eq } = require('drizzle-orm');
const deploymentService = require('../deployments/DeploymentService');
const previewRegistry = require('../runtime/localPreviewRegistry');
const { appendInboxLog } = require('../workspace/logInbox');
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
        return url.searchParams.get('preview_token');
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
    const resolved = await resolveDeployment(request.raw, deploymentId);
    if (resolved.error) {
        const payload = { error: resolved.error };
        if (resolved.code) payload.code = resolved.code;
        return reply.code(resolved.status).send(payload);
    }

    const target = `http://127.0.0.1:${resolved.entry.port}`;
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

async function registerPreviewGateway(fastify) {
    fastify.post('/preview/:deploymentId/__dev/console', handleDevConsole);

    const proxyOpts = {
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        handler: proxyPreviewRequest,
    };
    fastify.route({ url: '/preview/:deploymentId', ...proxyOpts });
    fastify.route({ url: '/preview/:deploymentId/*', ...proxyOpts });

    fastify.server.on('upgrade', async (req, socket, head) => {
        try {
            const match = req.url?.match(/^\/preview\/([^/?]+)/);
            if (!match) return;

            const deploymentId = match[1];
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
