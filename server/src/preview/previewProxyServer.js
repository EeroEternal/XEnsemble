// 通用单端口预览代理（部署后由 twoStage spawn 到沙箱）。
//   静态模式（默认）: node previewProxyServer.js <distDir> <listenPort> <backendPort> [spaFallback(默认1)]
//     - 静态 serve 前端构建产物（dist 目录），含 SPA history 路由 fallback；
//     - 把 /api/* 反向代理到本地后端端口；
//   反代模式: node previewProxyServer.js --upstream <upstreamPort> <listenPort>
//     - 原样反代完整应用（upstream，如 verify 已 serve 的 bin.js web / uvicorn），
//       仅把 upstream 返回的 HTML 里的绝对资源路径改写为相对（/assets/… → ./assets/…），
//       适配 /preview/<id>/ 子路径，避免绝对路径泄漏到宿主源。
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let upstreamPort = null;
let distDirArg, listenPort, backendPort, spaFallbackArg;
let distDir = null;
let spaFallback = true;
if (args[0] === '--upstream') {
    upstreamPort = Number(args[1]);
    listenPort = Number(args[2]);
} else {
    [distDirArg, listenPort, backendPort, spaFallbackArg] = args;
    distDir = path.resolve(distDirArg);
    spaFallback = spaFallbackArg !== '0';
}
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'text/xml',
};

function serveStatic(req, res) {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://local').pathname); } catch { urlPath = '/'; }
    if (urlPath === '/') urlPath = '/index.html';
    let file = path.resolve(distDir, '.' + urlPath);
    if (file !== distDir && !file.startsWith(distDir + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }
    const send = (p) => {
        fs.stat(p, (err, st) => {
            if (!err && st.isFile()) {
                const type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
                // HTML：把资源绝对路径改写为相对（/assets/… → ./assets/…），适配 /preview/<id>/ 子路径部署。
                // 不改 /api、/preview、/@vite 等。这样前端资源请求带上 preview 前缀，由网关直接路由，
                // 不依赖 Referer 转发（否则部分资源请求落宿主根 /assets 会 401/text-html）。
                if (type.startsWith('text/html')) {
                    let html = fs.readFileSync(p, 'utf8');
                    html = html.replace(/(src|href)="\/(?!api\/|preview\/|@vite\/)/g, '$1="./');
                    res.writeHead(200, { 'Content-Type': type });
                    res.end(html);
                    return;
                }
                res.writeHead(200, { 'Content-Type': type });
                return fs.createReadStream(p).pipe(res);
            }
            if (!err && st.isDirectory()) return send(path.join(p, 'index.html'));
            // SPA history fallback
            const idx = path.join(distDir, 'index.html');
            if (spaFallback && fs.existsSync(idx)) {
                res.writeHead(200, { 'Content-Type': MIME['.html'] });
                return fs.createReadStream(idx).pipe(res);
            }
            res.writeHead(404); res.end('Not found');
        });
    };
    send(file);
}

// 反代模式：把全部请求转发给 upstream（完整应用），仅对 HTML 响应做资源路径改写。
function proxyToUpstream(req, res) {
    const proxy = http.request({
        host: '127.0.0.1',
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
    }, (pRes) => {
        const type = String(pRes.headers['content-type'] || '');
        if (type.startsWith('text/html')) {
            const chunks = [];
            pRes.on('data', (c) => chunks.push(c));
            pRes.on('end', () => {
                let html = Buffer.concat(chunks).toString('utf8');
                // 与静态模式同一改写规则：把绝对资源路径改为相对（/assets/… → ./assets/…），
                // 不改 /api、/preview、/@vite 等。
                html = html.replace(/(src|href)="\/(?!api\/|preview\/|@vite\/)/g, '$1="./');
                const headers = { ...pRes.headers };
                delete headers['content-length'];
                delete headers['transfer-encoding'];
                res.writeHead(pRes.statusCode || 200, headers);
                res.end(html);
            });
            pRes.on('error', () => {
                if (!res.headersSent) { res.writeHead(502); }
                res.end('Upstream error');
            });
        } else {
            res.writeHead(pRes.statusCode || 200, pRes.headers);
            pRes.pipe(res);
        }
    });
    proxy.on('error', () => {
        if (!res.headersSent) { res.writeHead(502); }
        res.end('Upstream unavailable');
    });
    req.on('error', () => proxy.destroy());
    req.pipe(proxy);
}

const server = http.createServer((req, res) => {
    if (upstreamPort) {
        proxyToUpstream(req, res);
        return;
    }
    let urlPath;
    try { urlPath = new URL(req.url, 'http://local').pathname; } catch { urlPath = '/'; }
    if (urlPath.startsWith('/api')) {
        const proxy = http.request({
            host: '127.0.0.1',
            port: Number(backendPort),
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
        }, (pRes) => {
            res.writeHead(pRes.statusCode, pRes.headers);
            pRes.pipe(res);
        });
        proxy.on('error', () => {
            if (!res.headersSent) { res.writeHead(502); }
            res.end('Backend unavailable');
        });
        req.pipe(proxy);
    } else {
        serveStatic(req, res);
    }
});

server.on('error', (e) => {
    console.error('[previewProxy] server error:', e.message);
    process.exit(1);
});

server.listen(Number(listenPort), '0.0.0.0', () => {
    if (upstreamPort) {
        console.error(`[previewProxy] upstream :${listenPort} -> :${upstreamPort}`);
    } else {
        console.error(`[previewProxy] listening :${listenPort} dist=${distDir} backend=:${backendPort}`);
    }
});
