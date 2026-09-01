// 沙箱内 blink 转发器：监听 127.0.0.1:8787，把 blink-server 协议请求转发到宿主控制面
// 的 /preview/<id>/__blink 代理，并注入 x-blink-token 鉴权头。
// 背景：被部署的 xensemble 后端（可能为旧版本代码）默认连 BLINK_API_URL=http://127.0.0.1:8787，
// 而沙箱 guest 内无 blink-server（无 KVM 无法自身起 VM）。本转发器让旧代码无需感知代理与 token，
// 即可经宿主 blink-server 创建 boxlite 隔离的 agent session。
// 仅依赖 node 内置 http/https，零第三方依赖。
const http = require('http');
const https = require('https');

const UPSTREAM = (process.env.BLINK_UPSTREAM || '').replace(/\/+$/, ''); // 形如 http://host:8089/preview/dep_x/__blink
const TOKEN = process.env.BLINK_TOKEN || '';

if (!UPSTREAM) {
    console.error('[blinkForwarder] BLINK_UPSTREAM is required');
    process.exit(1);
}

let upstreamUrl;
try {
    upstreamUrl = new URL(UPSTREAM);
} catch {
    console.error('[blinkForwarder] invalid BLINK_UPSTREAM:', UPSTREAM);
    process.exit(1);
}

const isTls = upstreamUrl.protocol === 'https:';
const transport = isTls ? https : http;
const upstreamHost = upstreamUrl.hostname;
const upstreamPort = upstreamUrl.port ? Number(upstreamUrl.port) : (isTls ? 443 : 80);
const upstreamPathBase = upstreamUrl.pathname.replace(/\/+$/, ''); // /preview/dep_x/__blink

function joinUpstreamPath(reqUrl) {
    // reqUrl 如 /api/health?x=1；补到上游 base 路径之后。
    const raw = String(reqUrl || '/');
    return upstreamPathBase + (raw.startsWith('/') ? raw : '/' + raw);
}

function forwardHttp(req, res) {
    const options = {
        hostname: upstreamHost,
        port: upstreamPort,
        path: joinUpstreamPath(req.url),
        method: req.method,
        headers: {
            ...req.headers,
            host: upstreamHost,
            'x-blink-token': TOKEN,
        },
    };
    const preq = transport.request(options, (pres) => {
        res.writeHead(pres.statusCode, pres.headers);
        pres.pipe(res);
    });
    preq.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('blink upstream error');
    });
    req.pipe(preq);
}

function forwardUpgrade(req, socket, head) {
    const options = {
        hostname: upstreamHost,
        port: upstreamPort,
        path: joinUpstreamPath(req.url),
        method: 'GET',
        headers: {
            ...req.headers,
            host: upstreamHost,
            'x-blink-token': TOKEN,
            connection: 'Upgrade',
            upgrade: 'websocket',
        },
    };
    const preq = transport.request(options);
    preq.on('upgrade', (pres, psocket, phead) => {
        if (pres.statusCode !== 101) {
            socket.write(`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage || ''}\r\n\r\n`);
            socket.destroy();
            psocket.destroy();
            return;
        }
        socket.write(`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage || ''}\r\n`);
        for (const [k, v] of Object.entries(pres.headers)) {
            if (k && v !== undefined) socket.write(`${k}: ${v}\r\n`);
        }
        socket.write('\r\n');
        if (phead && phead.length) socket.write(phead);
        socket.pipe(psocket);
        psocket.pipe(socket);
    });
    preq.on('error', () => {
        if (!socket.destroyed) socket.destroy();
    });
    socket.on('error', () => preq.destroy());
    if (head && head.length) preq.write(head);
    preq.end();
}

const server = http.createServer(forwardHttp);
server.on('upgrade', forwardUpgrade);
server.on('error', (e) => console.error('[blinkForwarder]', e.message));
server.listen(8787, '127.0.0.1', () => {
    console.error(`[blinkForwarder] listening on 127.0.0.1:8787 -> ${UPSTREAM}`);
});
