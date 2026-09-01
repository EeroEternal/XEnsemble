// 通用单端口预览代理（部署后由 twoStage spawn 到沙箱）。
//   静态模式（默认）: node previewProxyServer.js <distDir> <listenPort> <backendPort> [spaFallback(默认1)]
//     - 静态 serve 前端构建产物（dist 目录），含 SPA history 路由 fallback；
//     - 把 /api/* 反向代理到本地后端端口；
//   反代模式: node previewProxyServer.js --upstream <upstreamPort> <listenPort>
//     - 原样反代完整应用（upstream，如 verify 已 serve 的 bin.js web / uvicorn），
//       仅把 upstream 返回的 HTML 里的绝对资源路径改写为相对（/assets/… → ./assets/…），
//       适配 /preview/<id>/ 子路径，避免绝对路径泄漏到宿主源。
//   live 模式: node previewProxyServer.js --live <devPort> <backendPort> <listenPort> <base>
//     - /api/* 反代到后端（前后端都可用）；其它反代到 dev server（实时预览），
//       转发时把 base（如 /preview/<id>/）补回请求路径——vite 配了该 base，请求不带 base 会 302。
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let upstreamPort = null;
let devPort = null;
let liveBase = '';
let distDirArg, listenPort, backendPort, spaFallbackArg;
let distDir = null;
let spaFallback = true;
if (args[0] === '--upstream') {
    upstreamPort = Number(args[1]);
    listenPort = Number(args[2]);
} else if (args[0] === '--live') {
    devPort = Number(args[1]);
    backendPort = Number(args[2]);
    listenPort = Number(args[3]);
    liveBase = args[4] || '';
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

// 剥掉限制 iframe 嵌入的响应头（Content-Security-Policy / X-Frame-Options），
// 否则被预览应用带 helmet 等安全头（frame-ancestors 'self'）会让控制台 iframe 被浏览器拦截。
function stripFrameBlockingHeaders(headers) {
    const h = { ...headers };
    delete h['content-security-policy'];
    delete h['x-frame-options'];
    return h;
}

// 通用反代：把请求转发给指定端口，仅对 HTML 响应做资源路径改写 + 剥 iframe 限制头。
// 并针对「前端 BrowserRouter」项目提供 SPA history 路由 fallback：命中 404 的浏览器导航
// （非 /api、非静态资源）回源取 index.html，避免刷新/直接访问子路由时 404。
// overridePath：转发给 upstream 时替换请求路径（live 模式需要把 base 补回去）。
function proxyTo(req, res, port, allowFallback = true, overridePath = null) {
    const targetPath = overridePath || req.url;
    const proxy = http.request({
        host: '127.0.0.1',
        port,
        path: targetPath,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${port}` },
    }, (pRes) => {
        const isNav = /\btext\/html\b/i.test(String(req.headers.accept || ''));
        const isApi = /^\/api(\/|$)/i.test(String(targetPath || ''));
        const hasExt = /\/[^/]+\.[A-Za-z0-9]+$/.test(String(targetPath || '').split('?')[0]);
        // 仅对 SPA history 路由（非 /api、非静态资源、浏览器导航请求）做 fallback，
        // 避免后端真实 404 / 缺失资源被 index.html 顶掉（返回 HTML 会破坏 JS/CSS 解析）
        if (allowFallback && pRes.statusCode === 404 && isNav && !isApi && !hasExt) {
            pRes.resume();
            proxyRoot(res, port);
            return;
        }
        const type = String(pRes.headers['content-type'] || '');
        if (type.startsWith('text/html')) {
            const chunks = [];
            pRes.on('data', (c) => chunks.push(c));
            pRes.on('end', () => {
                let html = Buffer.concat(chunks).toString('utf8');
                // 把绝对资源路径改为相对（/assets/… → ./assets/…），不改 /api、/preview、/@vite 等。
                html = html.replace(/(src|href)="\/(?!api\/|preview\/|@vite\/)/g, '$1="./');
                const headers = stripFrameBlockingHeaders(pRes.headers);
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
            res.writeHead(pRes.statusCode || 200, stripFrameBlockingHeaders(pRes.headers));
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

// 回源取指定端口根路径（GET /）作为 SPA index.html 返回，不再做二次 fallback。
function proxyRoot(res, port) {
    const proxy = http.request({
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, accept: 'text/html' },
    }, (pRes) => {
        const type = String(pRes.headers['content-type'] || '');
        if (type.startsWith('text/html')) {
            const chunks = [];
            pRes.on('data', (c) => chunks.push(c));
            pRes.on('end', () => {
                let html = Buffer.concat(chunks).toString('utf8');
                html = html.replace(/(src|href)="\/(?!api\/|preview\/|@vite\/)/g, '$1="./');
                const headers = stripFrameBlockingHeaders(pRes.headers);
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
            res.writeHead(pRes.statusCode || 200, stripFrameBlockingHeaders(pRes.headers));
            pRes.pipe(res);
        }
    });
    proxy.on('error', () => {
        if (!res.headersSent) { res.writeHead(502); }
        res.end('Upstream unavailable');
    });
    proxy.end();
}

// 反代模式：把全部请求转发给 upstream（完整应用），仅对 HTML 响应做资源路径改写。
function proxyToUpstream(req, res) {
    return proxyTo(req, res, upstreamPort, true);
}

// live 实时模式：/api/* → 后端；其它 → dev server（实时预览，前后端都可用）。
function handleLiveMode(req, res) {
    let pathname;
    let search = '';
    try {
        const u = new URL(req.url, 'http://local');
        pathname = u.pathname;
        search = u.search || '';
    } catch {
        const q = req.url.indexOf('?');
        pathname = q >= 0 ? req.url.slice(0, q) : req.url;
        search = q >= 0 ? req.url.slice(q) : '';
    }
    if (pathname.startsWith('/api')) {
        proxyTo(req, res, backendPort, false);
        return;
    }
    // 网关已把 /preview/<id> 前缀 strip 掉，vite 配了 base，请求不带 base 会 302 死循环，
    // 这里把 base 补回 vite 请求路径。query（如 ?import/?worker）必须保留：vite 对 .json?import
    // 返回 JS 模块，丢了 query 会返回原始 application/json，导致浏览器 MIME 错误白屏。
    const base = liveBase.replace(/\/$/, '');
    const devPath = (pathname === '/' ? `${base}/` : `${base}${pathname}`) + search;
    proxyTo(req, res, devPort, true, devPath);
}

// 把 upgrade（WebSocket）请求转发到目标端口，透传 socket 字节流。
function forwardUpgrade(req, socket, head, port, targetPath) {
    const proxy = http.request({
        host: '127.0.0.1',
        port,
        path: targetPath,
        method: req.method || 'GET',
        headers: { ...req.headers, host: `127.0.0.1:${port}` },
    });
    proxy.on('upgrade', (pRes, pSocket, pHead) => {
        if (pRes.statusCode !== 101) {
            socket.write(`HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage || ''}\r\n\r\n`);
            socket.destroy();
            pSocket.destroy();
            return;
        }
        socket.write(`HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage || ''}\r\n`);
        for (const [k, v] of Object.entries(pRes.headers)) {
            if (k && v !== undefined) socket.write(`${k}: ${v}\r\n`);
        }
        socket.write('\r\n');
        if (pHead && pHead.length) socket.write(pHead);
        socket.pipe(pSocket);
        pSocket.pipe(socket);
    });
    proxy.on('error', () => {
        if (!socket.destroyed) socket.destroy();
    });
    socket.on('error', () => proxy.destroy());
    if (head && head.length) proxy.write(head);
    proxy.end();
}

// live 模式 WS 分流：/api、/ws → 后端（终端等）；其它（如 /@vite 的 HMR）→ dev server。
function handleLiveUpgrade(req, socket, head) {
    let pathname;
    let search = '';
    try {
        const u = new URL(req.url, 'http://local');
        pathname = u.pathname;
        search = u.search || '';
    } catch {
        const q = req.url.indexOf('?');
        pathname = q >= 0 ? req.url.slice(0, q) : req.url;
        search = q >= 0 ? req.url.slice(q) : '';
    }
    if (pathname.startsWith('/api') || pathname.startsWith('/ws')) {
        forwardUpgrade(req, socket, head, backendPort, req.url);
        return;
    }
    // HMR 等 dev-server WS：补回 base 前缀并保留 query（vite 用 ?token 校验 HMR 连接）。
    const base = liveBase.replace(/\/$/, '');
    const devPath = (pathname === '/' ? `${base}/` : `${base}${pathname}`) + search;
    forwardUpgrade(req, socket, head, devPort, devPath);
}

const server = http.createServer((req, res) => {
    if (devPort) {
        handleLiveMode(req, res);
        return;
    }
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
            res.writeHead(pRes.statusCode, stripFrameBlockingHeaders(pRes.headers));
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

// WebSocket upgrade 转发：live 模式支持终端/SSE 的 /ws 反代到后端。
server.on('upgrade', (req, socket, head) => {
    if (devPort) {
        handleLiveUpgrade(req, socket, head);
    } else if (backendPort) {
        forwardUpgrade(req, socket, head, Number(backendPort), req.url);
    } else {
        socket.destroy();
    }
});

server.on('error', (e) => {
    console.error('[previewProxy] server error:', e.message);
    process.exit(1);
});

server.listen(Number(listenPort), '0.0.0.0', () => {
    if (devPort) {
        console.error(`[previewProxy] live :${listenPort} -> dev=:${devPort} backend=:${backendPort} base=${liveBase || '/'}`);
    } else if (upstreamPort) {
        console.error(`[previewProxy] upstream :${listenPort} -> :${upstreamPort}`);
    } else {
        console.error(`[previewProxy] listening :${listenPort} dist=${distDir} backend=:${backendPort}`);
    }
});
