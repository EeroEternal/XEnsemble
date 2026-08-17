#!/usr/bin/env node
const net = require('net');

const [hostIp, wsPort, vmPort] = process.argv.slice(2);
if (!hostIp || !wsPort || !vmPort) {
    console.error('Usage: tunnelClient.js <hostIp> <wsPort> <vmPort>');
    process.exit(1);
}

const wsUrl = `ws://${hostIp}:${wsPort}`;
const ws = new WebSocket(wsUrl);
const sockets = new Map();

ws.addEventListener('open', () => {
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
    sockets.forEach((s) => s.destroy());
    process.exit(0);
});

ws.addEventListener('error', (e) => {
    console.error('[tunnelClient] error:', e.message || e);
    process.exit(1);
});
