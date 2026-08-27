#!/usr/bin/env node
const net = require('net');

const [hostIp, wsPort, vmPort] = process.argv.slice(2);
if (!hostIp || !wsPort || !vmPort) {
    console.error('Usage: tunnelClient.js <hostIp> <wsPort> <vmPort>');
    process.exit(1);
}

const wsUrl = `ws://${hostIp}:${wsPort}`;
const sockets = new Map();

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let attempt = 0;
let reconnectTimer = null;
let closed = false;

function destroySockets() {
    for (const s of sockets.values()) {
        try { s.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
}

function connect() {
    if (closed) return;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
        attempt = 0;
        console.error('[tunnelClient] connected to', wsUrl);
    });

    ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        const { id, t, d } = msg;
        if (t === 'open') {
            const local = net.connect(Number(vmPort), '127.0.0.1');
            sockets.set(id, local);
            local.on('data', (data) => {
                if (ws.readyState === 1) ws.send(JSON.stringify({ id, t: 'data', d: data.toString('base64') }));
            });
            local.on('close', () => {
                sockets.delete(id);
                if (ws.readyState === 1) ws.send(JSON.stringify({ id, t: 'close' }));
            });
            local.on('error', () => {
                sockets.delete(id);
                if (ws.readyState === 1) ws.send(JSON.stringify({ id, t: 'close' }));
            });
        } else if (t === 'data') {
            const local = sockets.get(id);
            if (local) local.write(Buffer.from(d, 'base64'));
        } else if (t === 'close') {
            const local = sockets.get(id);
            if (local) { local.end(); sockets.delete(id); }
        }
    });

    ws.addEventListener('close', () => {
        destroySockets();
        if (closed) return;
        // WS 断开后自动重连（指数退避，上限 30s）：控制面还在时能恢复隧道，
        // 避免一次网络抖动让预览永久 503 直到 TTL 到期。
        attempt += 1;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6), RECONNECT_MAX_MS);
        console.error(`[tunnelClient] disconnected, reconnect #${attempt} in ${delay}ms`);
        reconnectTimer = setTimeout(connect, delay);
    });

    ws.addEventListener('error', (e) => {
        console.error('[tunnelClient] error:', e.message || e);
        try { ws.close(); } catch { /* ignore */ }
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
