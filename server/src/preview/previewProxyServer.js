// 通用单端口预览代理（部署后由 twoStage spawn 到沙箱）。
//   静态模式（默认）: node previewProxyServer.js <distDir> <listenPort> <backendPort> [spaFallback(默认1)] [base]
//     - 静态 serve 前端构建产物（dist 目录），含 SPA history 路由 fallback；
//     - 把 /api/* 反向代理到本地后端端口；
//     - base（如 /preview/<id>/）注入 HTML <base>，让前端相对 URL 自动带预览前缀
//   反代模式: node previewProxyServer.js --upstream <upstreamPort> <listenPort> [base]
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
    liveBase = args[3] || '';
} else if (args[0] === '--live') {
    devPort = Number(args[1]);
    backendPort = Number(args[2]);
    listenPort = Number(args[3]);
    liveBase = args[4] || '';
} else {
    [distDirArg, listenPort, backendPort, spaFallbackArg, liveBase] = args;
    distDir = path.resolve(distDirArg);
    spaFallback = spaFallbackArg !== '0';
    liveBase = liveBase || '';
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
                    html = rewriteHtml(html);
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

// 统一 HTML 改写：
//  1) 注入 <base href="/preview/<id>/">（若提供了 base 且 HTML 里没有 <base>），让前端所有
//     相对 URL（webpack 动态 chunk、fetch 相对路径等）自动落到预览子路径，不脱离前缀。
//  2) 把绝对资源路径改为相对（/assets/… → ./assets/…），不改 /api、/preview、/@vite 等。
//  3) 注入运行时 URL 改写脚本：很多前端（vite dev、axios/fetch、WebSocket）会写死沙箱内地址
//     （http://localhost:9000/api 之类）。浏览器无法访问沙箱 localhost → ERR_CONNECTION_REFUSED。
//     这里把这类请求改写为相对路径，让它们走预览网关 → 隧道 → 沙箱后端，通用修复所有项目。
const PREVIEW_RUNTIME_SCRIPT = `<script>
(function () {
  if (window.__xensemblePreviewPatched) return; window.__xensemblePreviewPatched = true;
  var localRe = /^https?:\\/\\/(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(:\\d+)?/i;
  // 当前页面若挂在 /preview/<id>/ 子路径下，改写时保留该前缀（如 /preview/<id>/api/...），
  // 否则浏览器把 http://127.0.0.1:3888/api/... 直接打向宿主根 → 401。
  function previewBase() {
    var m = /^\\/preview\\/[^/?#]+\\//.exec(location.pathname);
    return m ? m[0] : '';
  }
  function strip(url) {
    if (typeof url !== 'string') return url;
    try {
      var u = new URL(url, location.href);
      if (localRe.test(u.origin)) return previewBase() + u.pathname.replace(/^\\//, '') + u.search + u.hash;
    } catch (e) {}
    return url;
  }
  var of = window.fetch;
  if (of) window.fetch = function (input, init) {
    if (typeof input === 'string') input = strip(input);
    else if (input && input.url) input = new Request(strip(input.url), input);
    return of.call(this, input, init);
  };
  var oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    return oo.call(this, method, strip(url), arguments.length > 2 ? arguments[2] : true,
      arguments.length > 3 ? arguments[3] : null, arguments.length > 4 ? arguments[4] : null);
  };
  var WS = window.WebSocket;
  if (WS) {
    var W = function (url, protocols) { return new WS(strip(url), protocols); };
    W.prototype = WS.prototype; W.CONNECTING = WS.CONNECTING; W.OPEN = WS.OPEN;
    W.CLOSING = WS.CLOSING; W.CLOSED = WS.CLOSED;
    window.WebSocket = W;
  }
})();
</script>`;

const zlib = require('zlib');

// 解压响应体：代理到 dev server / 后端时常见 gzip/br/deflate 压缩。
// 必须解压后再做 HTML 改写，否则改写后的内容与 content-encoding 头不匹配，
// 浏览器按压缩解包会失败（ERR_CONTENT_DECODING_FAILED）→ 白屏。
function decompressBody(buf, encoding) {
    const enc = String(encoding || '').toLowerCase();
    try {
        if (enc.includes('gzip')) return zlib.gunzipSync(buf);
        if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
        if (enc.includes('deflate')) return zlib.inflateSync(buf);
    } catch (e) {
        // 解压失败：保留原字节（可能是代理层未真正压缩但头误标），交由下游决定。
    }
    return buf;
}

function rewriteHtml(html) {
    if (liveBase && !/<base\s/i.test(html)) {
        const base = liveBase.replace(/\/$/, '') + '/';
        html = html.replace(/(<head[^>]*>)/i, `$1\n    <base href="${base}">`);
    }
    html = html.replace(/(src|href)="\/(?!api\/|preview\/|@vite\/)/g, '$1="./');
    if (!html.includes('__xensemblePreviewPatched')) {
        html = html.replace(/(<\/head>)/i, `${PREVIEW_RUNTIME_SCRIPT}\n$1`);
    }
    return html;
}

// 改写 HTML 并回写响应（含解压与编码头清理）：
//  - 解压 gzip/br/deflate → 改写 → 去掉 content-encoding / content-length，按明文回写。
//  - 避免上游返回压缩 HTML 时，改写后的明文仍带压缩头 → ERR_CONTENT_DECODING_FAILED。
function rewriteAndSendHtml(res, pRes, chunks) {
    const enc = String(pRes.headers['content-encoding'] || '').toLowerCase();
    let html;
    if (enc.includes('gzip') || enc.includes('br') || enc.includes('deflate')) {
        html = decompressBody(Buffer.concat(chunks), enc).toString('utf8');
    } else {
        html = Buffer.concat(chunks).toString('utf8');
    }
    html = rewriteHtml(html);
    const headers = stripFrameBlockingHeaders(pRes.headers);
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    delete headers['content-encoding'];
    res.writeHead(pRes.statusCode || 200, headers);
    res.end(html);
}

// Origin 同源改写：浏览器发来的 Origin 是预览入口地址（如 http://IP:8099），但转发给
// 应用后端时 Host 已改写为 127.0.0.1:<port>。被部署应用若做 Origin↔Host 一致性校验
// （DNS-rebinding / CSRF 围栏，如 deepseek-harness 的 api-request-trust：Origin host 必须
// 等于请求 Host，否则 /api 一律 403），会因两者不一致被拒。把 Origin 同步改写为与转发
// 目标同源，让"同源校验"类应用在预览反代下正常工作；正常应用不受影响（Origin 变为自身）。
function sameOriginHeaders(headers, port) {
    const out = { ...headers, host: `127.0.0.1:${port}` };
    if (out.origin !== undefined) out.origin = `http://127.0.0.1:${port}`;
    return out;
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
        headers: sameOriginHeaders(req.headers, port),
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
                rewriteAndSendHtml(res, pRes, chunks);
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
                rewriteAndSendHtml(res, pRes, chunks);
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
        headers: sameOriginHeaders(req.headers, port),
    });
    proxy.on('upgrade', (pRes, pSocket, pHead) => {
        if (pRes.statusCode !== 101) {
            socket.write(`HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage || ''}\r\n\r\n`);
            socket.destroy();
            pSocket.destroy();
            return;
        }
        // 透传 101 状态行 + 全部响应头。upgrade 响应必须包含 Connection/Upgrade 头，
        // 浏览器靠 Sec-WebSocket-Accept + Upgrade: websocket 完成握手，缺任一都会
        // 报 "Invalid frame header"。pRes.headers 已含 Sec-WebSocket-Accept。
        socket.write(`HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage || ''}\r\n`);
        for (const [k, v] of Object.entries(pRes.headers)) {
            if (k && v !== undefined) socket.write(`${k}: ${v}\r\n`);
        }
        // 兜底：若上游漏了 Connection/Upgrade 头则补上，否则浏览器端 WS 客户端
        // 无法确认升级成功，握手后的首个帧会被判 "Invalid frame header"。
        const lower = {};
        for (const k of Object.keys(pRes.headers)) lower[k.toLowerCase()] = k;
        if (!('connection' in lower)) socket.write('Connection: Upgrade\r\n');
        if (!('upgrade' in lower)) socket.write('Upgrade: websocket\r\n');
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
            headers: sameOriginHeaders(req.headers, Number(backendPort)),
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
