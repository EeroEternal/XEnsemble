// 通用单端口聚合预览服务器（部署后由 twoStage spawn 到沙箱）。
//   - 静态 serve 前端构建产物（dist 目录），含 SPA history 路由 fallback；
//   - 把 /api/* 反向代理到本地后端端口；
// 这样 preview 只需 tunnel 一个端口，前后端就都可用（前端相对路径 /api 直连后端）。
// 用法: node previewProxyServer.js <distDir> <listenPort> <backendPort> [spaFallback(默认1)]
const http = require('http');
const fs = require('fs');
const path = require('path');

const [distDirArg, listenPort, backendPort, spaFallbackArg] = process.argv.slice(2);
const distDir = path.resolve(distDirArg);
const spaFallback = spaFallbackArg !== '0';
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

const server = http.createServer((req, res) => {
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
    console.error(`[previewProxy] listening :${listenPort} dist=${distDir} backend=:${backendPort}`);
});
