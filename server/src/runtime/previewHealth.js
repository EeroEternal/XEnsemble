const net = require('net');
const http = require('http');

function probePort(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port }, () => {
            socket.end();
            resolve(true);
        });
        socket.setTimeout(timeoutMs);
        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
    });
}

// 检查 preview 是否真的可用：请求应用根路径，若返回 "Tunnel not ready"（tunnel 进程活着
// 但到沙箱的隧道已断 / 沙箱应用已死）或连接失败，则视为孤儿（不可用）。
// 仅 TCP 端口连通不足以判断——tunnel 的 browserPort 在宿主监听即可 probe 通过，但预览实际打不开。
function probePreviewHealthy(host, port, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const req = http.get({ host, port, path: '/', timeout: timeoutMs }, (res) => {
            let body = '';
            res.on('data', (c) => {
                body += c;
                if (body.length > 8192) res.destroy();
            });
            res.on('end', () => {
                resolve(!/Tunnel not ready|Preview process not found/i.test(body));
            });
            res.on('error', () => resolve(false));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

function parseInternalRef(internalRef) {
    const raw = String(internalRef || '').trim();
    const idx = raw.lastIndexOf(':');
    if (idx <= 0) return null;
    const host = raw.slice(0, idx);
    const port = Number(raw.slice(idx + 1));
    if (!host || !Number.isInteger(port) || port <= 0) return null;
    return { host, port };
}

function isProcessAlive(pid) {
    if (!pid || !Number.isInteger(pid)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    probePort,
    probePreviewHealthy,
    parseInternalRef,
    isProcessAlive,
};
