const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getRuntime } = require('../runtime/registry');
const previewRegistry = require('../runtime/localPreviewRegistry');
const { resolveControlPlanePublicUrlSync } = require('../llm/publicUrl');

const TUNNEL_CLIENT_SCRIPT = fs.readFileSync(path.join(__dirname, 'tunnelClient.js'), 'utf8');

const tunnels = new Map();

// 隧道帧协议（与 tunnelClient.js 保持一致）：4 字节大端长度 + UTF-8 JSON payload。
function encodeFrame(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(payload.length, 0);
    return Buffer.concat([head, payload]);
}

// 处理 TCP 粘包/半包：累积 chunk，循环取出完整帧后回调。
function createFrameParser(onMessage) {
    let buf = Buffer.alloc(0);
    return (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (buf.length >= 4) {
            const len = buf.readUInt32BE(0);
            if (len > 64 * 1024 * 1024) return; // 异常帧，丢弃连接剩余数据
            if (buf.length < 4 + len) break;
            const payload = buf.slice(4, 4 + len);
            buf = buf.slice(4 + len);
            try { onMessage(JSON.parse(payload.toString('utf8'))); } catch { /* skip bad frame */ }
        }
    };
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close((err) => (err ? reject(err) : resolve(port)));
        });
    });
}

function getTunnelHostIp() {
    const explicit = process.env.TUNNEL_HOST_IP?.trim();
    if (explicit) return explicit;
    const publicUrl = process.env.CONTROL_PLANE_PUBLIC_URL?.trim();
    if (publicUrl) {
        try { return new URL(publicUrl).hostname; } catch { /* ignore */ }
    }
    return '127.0.0.1';
}

async function waitForVmPort(runtimeRef, workspacePath, vmPort, timeoutMs = 60000) {
    const runtime = getRuntime();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const r = await runtime.exec.exec(
                'sh', ['-c', `curl -sf -o /dev/null http://127.0.0.1:${vmPort}/ || exit 1`], {},
                { runtimeRef, cwd: workspacePath },
            );
            if (r.exitCode === 0) return true;
        } catch { /* not ready */ }
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

async function createTunnel({ deploymentId, workspacePath, runtimeRef, vmPort, projectId }) {
    const runtime = getRuntime();
    const browserPort = await getFreePort();
    const wsPort = await getFreePort();
    const hostIp = getTunnelHostIp();

    await runtime.fs.fsWrite(workspacePath, '.agents/tunnelClient.cjs', TUNNEL_CLIENT_SCRIPT, { runtimeRef });

    // 写一个 supervisor 脚本：循环重启 tunnelClient，防止 BoxLiteStreamHandle 的
    // WebSocket 断连导致 onExit 触发后子进程彻底消失。supervisor 自身是 node 进程，
    // 不会被 blink 端的 close 事件杀掉（tty=true 的 exec attach 心跳维持）。
    // 注意：不能用 shebang（模板字符串首行空行会让 shebang 落在第二行 → guest node
    // 直接 SyntaxError 秒退，无限重启坏脚本 → tunnel 永远连不上 → 部署超时）。
    // 我们用 `node tunnelSupervisor.cjs` 显式调用，无需 shebang。
    const supervisorScript = `const { spawn } = require('child_process');
const path = require('path');
const args = process.argv.slice(2);
const [hostIp, wsPort, vmPort] = args;
const clientPath = path.join(__dirname, 'tunnelClient.cjs');
let attempt = 0;
let stopped = false;
function start() {
  if (stopped) return;
  const child = spawn(process.execPath, [clientPath, hostIp, wsPort, vmPort], {
    stdio: 'inherit',
    cwd: __dirname,
  });
  child.on('exit', (code) => {
    if (stopped) return;
    attempt += 1;
    const delay = Math.min(1000 * Math.pow(2, Math.min(attempt, 5)), 30000);
    console.error('[tunnelSupervisor] client exited code=' + code + ', restart in ' + delay + 'ms (attempt ' + attempt + ')');
    setTimeout(start, delay);
  });
}
process.on('SIGTERM', () => { stopped = true; process.exit(0); });
start();
setInterval(() => {}, 1 << 30);
`;
    await runtime.fs.fsWrite(workspacePath, '.agents/tunnelSupervisor.cjs', supervisorScript, { runtimeRef });

    let vmSocket = null;
    const pendingBrowsers = new Map();

    // 隧道协议：裸 TCP + 4 字节长度前缀 JSON 帧。不用 WebSocket——guest 内 node
    // 版本不一（v18/v20/v22 取决于镜像），全局 WebSocket 仅 v22.4+ 存在，旧镜像上
    // tunnelClient 会 ReferenceError 秒崩。net 帧协议全版本兼容且更简单。
    const server = net.createServer((socket) => {
        vmSocket = socket;
        socket.on('data', createFrameParser((msg) => {
            const { id, t, d } = msg;
            const browserSocket = pendingBrowsers.get(id);
            if (!browserSocket) return;
            if (t === 'data') browserSocket.write(Buffer.from(d, 'base64'));
            else if (t === 'close') { browserSocket.end(); pendingBrowsers.delete(id); }
        }));
        socket.on('close', () => {
            if (vmSocket === socket) vmSocket = null;
            pendingBrowsers.forEach((s) => s.destroy());
            pendingBrowsers.clear();
        });
    });
    server.listen(wsPort, '0.0.0.0');

    const vmSend = (obj) => {
        if (vmSocket && !vmSocket.destroyed) vmSocket.write(encodeFrame(obj));
    };
    const vmReady = () => vmSocket && !vmSocket.destroyed;

    const browserServer = net.createServer((browserSocket) => {
        if (!vmReady()) {
            browserSocket.end('HTTP/1.1 503 Service Unavailable\r\n\r\nTunnel not ready');
            return;
        }
        const id = crypto.randomUUID();
        pendingBrowsers.set(id, browserSocket);
        vmSend({ id, t: 'open' });
        browserSocket.on('data', (data) => {
            vmSend({ id, t: 'data', d: data.toString('base64') });
        });
        browserSocket.on('close', () => {
            pendingBrowsers.delete(id);
            vmSend({ id, t: 'close' });
        });
        browserSocket.on('error', () => { pendingBrowsers.delete(id); });
    });
    browserServer.listen(browserPort, '127.0.0.1');

    const child = await runtime.exec.spawn(
        'node',
        ['.agents/tunnelSupervisor.cjs', hostIp, String(wsPort), String(vmPort)],
        { TERM: 'xterm-256color' },
        { name: 'tunnel-supervisor', cwd: workspacePath, runtimeRef },
    );
    console.error(`[tunnelServer] tunnel supervisor spawned for ${deploymentId}`);

    // 建立失败（连接超时 / 应用端口起不来）时必须清理已监听的 wsServer/browserServer，
    // 否则 fd 泄漏：每次失败部署都会在宿主上留下一对孤儿监听端口。
    const failCleanup = () => {
        try { child?.kill?.(); } catch { /* ignore */ }
        try { browserServer.close(); } catch { /* ignore */ }
        try { server.close(); } catch { /* ignore */ }
    };

    try {
        await new Promise((resolve, reject) => {
            const timeoutMs = Number(process.env.TUNNEL_CONNECT_TIMEOUT_MS) || 30000;
            const timer = setTimeout(() => reject(new Error('Tunnel client connection timeout')), timeoutMs);
            const check = () => {
                if (vmSocket) { clearTimeout(timer); resolve(); }
                else setTimeout(check, 200);
            };
            check();
        });

        const ready = await waitForVmPort(runtimeRef, workspacePath, vmPort);
        if (!ready) throw new Error(`Preview service did not start on port ${vmPort}`);
    } catch (e) {
        failCleanup();
        throw e;
    }

    // 预览专用端口（PREVIEW_PUBLIC_URL）：与宿主控制台(8088)分开，避免地址栏混淆。
    // 未配置时回退到控制面 URL 的 /preview/<id>/ 路径。
    const previewBase = (process.env.PREVIEW_PUBLIC_URL || '').trim() || resolveControlPlanePublicUrlSync();
    const publicUrl = `${previewBase.replace(/\/+$/, '')}/preview/${deploymentId}/`;
    previewRegistry.set(deploymentId, {
        port: browserPort,
        workspacePath,
        startedAt: Date.now(),
    }, { persist: false });
    console.error(`[tunnelServer] registry set ${deploymentId} port=${browserPort} entries=${previewRegistry.listIds().length}`);

    tunnels.set(deploymentId, { browserServer, server, child, browserPort, projectId });

    return {
        browserPort,
        publicUrl,
        internalRef: `127.0.0.1:${browserPort}`,
        stop: () => stopTunnel(deploymentId),
    };
}

function stopTunnel(deploymentId) {
    const tunnel = tunnels.get(deploymentId);
    if (!tunnel) return;
    try { tunnel.child?.kill?.(); } catch { /* ignore */ }
    try { tunnel.browserServer?.close(); } catch { /* ignore */ }
    try { tunnel.server?.close(); } catch { /* ignore */ }
    previewRegistry.remove(deploymentId);
    tunnels.delete(deploymentId);
}

function stopByProjectId(projectId) {
    for (const [deploymentId, tunnel] of [...tunnels.entries()]) {
        if (tunnel.projectId === projectId) stopTunnel(deploymentId);
    }
}

module.exports = { createTunnel, stopTunnel, stopByProjectId };
