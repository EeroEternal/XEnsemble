// 隧道客户端（跑在 guest 内）：连接宿主隧道服务，把浏览器请求转发到 guest 内应用端口。
// 协议：裸 TCP + 4 字节大端长度前缀 JSON 帧（与 tunnelServer.js 一致）。
// 不用 WebSocket：全局 WebSocket 仅 Node v22.4+ 存在，guest 镜像 node 版本不一
// （v18/v20/v22），旧版本上会 ReferenceError 崩溃。纯 net 实现全版本兼容。
const net = require('net');

const [hostIp, wsPort, vmPort] = process.argv.slice(2);
if (!hostIp || !wsPort || !vmPort) {
    console.error('Usage: tunnelClient.js <hostIp> <wsPort> <vmPort>');
    process.exit(1);
}

const sockets = new Map();

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let attempt = 0;
let reconnectTimer = null;
let closed = false;

// 与 tunnelServer.js 相同的帧编解码
function encodeFrame(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(payload.length, 0);
    return Buffer.concat([head, payload]);
}

function createFrameParser(onMessage) {
    let buf = Buffer.alloc(0);
    return (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (buf.length >= 4) {
            const len = buf.readUInt32BE(0);
            if (len > 64 * 1024 * 1024) return;
            if (buf.length < 4 + len) break;
            const payload = buf.slice(4, 4 + len);
            buf = buf.slice(4 + len);
            try { onMessage(JSON.parse(payload.toString('utf8'))); } catch { /* skip bad frame */ }
        }
    };
}

function destroySockets() {
    for (const s of sockets.values()) {
        try { s.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
}

function connect() {
    if (closed) return;
    const sock = net.connect(Number(wsPort), hostIp);

    sock.on('connect', () => {
        attempt = 0;
        console.error('[tunnelClient] connected to', `${hostIp}:${wsPort}`);
    });

    sock.on('data', createFrameParser((msg) => {
        const { id, t, d } = msg;
        if (t === 'open') {
            const local = net.connect(Number(vmPort), '127.0.0.1');
            sockets.set(id, local);
            local.on('data', (data) => {
                if (!sock.destroyed) sock.write(encodeFrame({ id, t: 'data', d: data.toString('base64') }));
            });
            local.on('close', () => {
                sockets.delete(id);
                if (!sock.destroyed) sock.write(encodeFrame({ id, t: 'close' }));
            });
            local.on('error', () => {
                sockets.delete(id);
                if (!sock.destroyed) sock.write(encodeFrame({ id, t: 'close' }));
            });
        } else if (t === 'data') {
            const local = sockets.get(id);
            if (local) local.write(Buffer.from(d, 'base64'));
        } else if (t === 'close') {
            const local = sockets.get(id);
            if (local) { local.end(); sockets.delete(id); }
        }
    }));

    sock.on('close', () => {
        destroySockets();
        if (closed) return;
        // 断开后自动重连（指数退避，上限 30s）：控制面还在时能恢复隧道，
        // 避免一次网络抖动让预览永久 503 直到 TTL 到期。
        attempt += 1;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6), RECONNECT_MAX_MS);
        console.error(`[tunnelClient] disconnected, reconnect #${attempt} in ${delay}ms`);
        reconnectTimer = setTimeout(connect, delay);
    });

    sock.on('error', (e) => {
        console.error('[tunnelClient] error:', e.message || e);
        try { sock.destroy(); } catch { /* ignore */ }
    });
}

// 宿主 stopTunnel kill 时优雅退出（不再重连）
process.on('SIGTERM', () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    destroySockets();
    process.exit(0);
});
process.on('SIGINT', () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    destroySockets();
    process.exit(0);
});

connect();
