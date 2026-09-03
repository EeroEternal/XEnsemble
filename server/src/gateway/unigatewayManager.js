const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
    generateGatewayKey,
    generateAdminToken,
    buildDefaultToml,
} = require('./defaultConfig');
const gatewaySettings = require('../admin/GatewaySettings');

const DATA_DIR = process.env.UNIGATEWAY_DATA_DIR
    || '/var/lib/xensemble/unigateway';
const CONFIG_PATH = path.join(DATA_DIR, 'unigateway.toml');
const ADMIN_TOKEN_PATH = path.join(DATA_DIR, 'unigateway.admin.token');
const GATEWAY_KEY_PATH = path.join(DATA_DIR, 'unigateway.gateway.key');

const ENV_BIND = process.env.UNIGATEWAY_BIND_ADDR || null;
const ENABLED = process.env.UNIGATEWAY_ENABLED !== '0';

function gatewayBinaryPath() {
    if (process.env.UNIGATEWAY_BIN) {
        return process.env.UNIGATEWAY_BIN;
    }
    const release = path.join(__dirname, '../../../gateway/target/release/xensemble-unigateway');
    const debug = path.join(__dirname, '../../../gateway/target/debug/xensemble-unigateway');
    const candidates = [release, debug].filter((p) => fs.existsSync(p));
    if (candidates.length === 0) return debug;
    if (candidates.length === 1) return candidates[0];
    const releaseMtime = fs.statSync(release).mtimeMs;
    const debugMtime = fs.statSync(debug).mtimeMs;
    return debugMtime > releaseMtime ? debug : release;
}

function baseUrlFromBind(bind) {
    const host = bind.includes(':') ? bind.slice(0, bind.lastIndexOf(':')) : bind;
    const port = bind.includes(':') ? bind.slice(bind.lastIndexOf(':') + 1) : '8741';
    const normalizedHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    return `http://${normalizedHost}:${port}`;
}

function readTextFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
        return null;
    }
}

function ensureGatewaySecrets() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    let gatewayKey = readTextFile(GATEWAY_KEY_PATH);
    let adminToken = readTextFile(ADMIN_TOKEN_PATH);

    if (!gatewayKey) {
        gatewayKey = generateGatewayKey();
        fs.writeFileSync(GATEWAY_KEY_PATH, `${gatewayKey}\n`, { mode: 0o600 });
    }

    const envToken = process.env.UNIGATEWAY_ADMIN_TOKEN;
    if (process.env.NODE_ENV === 'production') {
        if (!envToken) {
            throw new Error('UNIGATEWAY_ADMIN_TOKEN is required in production');
        }
        adminToken = envToken;
        fs.writeFileSync(ADMIN_TOKEN_PATH, `${adminToken}\n`, { mode: 0o600 });
    } else if (!adminToken) {
        adminToken = envToken || generateAdminToken();
        fs.writeFileSync(ADMIN_TOKEN_PATH, `${adminToken}\n`, { mode: 0o600 });
    }

    if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(
            CONFIG_PATH,
            buildDefaultToml({ gatewayKey, adminToken }),
            { mode: 0o600 },
        );
    }

    return { gatewayKey, adminToken, configPath: CONFIG_PATH };
}

function waitForHealth(baseUrl, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    const healthUrl = new URL('/health', baseUrl);

    return new Promise((resolve, reject) => {
        const attempt = () => {
            const req = http.get(healthUrl, (res) => {
                res.resume();
                if (res.statusCode === 200) {
                    resolve(true);
                    return;
                }
                retry();
            });
            req.on('error', retry);
            req.setTimeout(2000, () => {
                req.destroy();
                retry();
            });
        };

        const retry = () => {
            if (Date.now() >= deadline) {
                reject(new Error('UniGateway health check timed out'));
                return;
            }
            setTimeout(attempt, 300);
        };

        attempt();
    });
}

let child = null;
let status = {
    running: false,
    baseUrl: baseUrlFromBind(gatewaySettings.DEFAULTS.bind_addr),
    bindAddr: gatewaySettings.DEFAULTS.bind_addr,
    autoStart: gatewaySettings.DEFAULTS.auto_start,
    configPath: CONFIG_PATH,
    binary: null,
    gatewayKey: null,
    adminToken: null,
    lastError: null,
};

async function resolveBindAddr(cachedConfig) {
    if (ENV_BIND) return ENV_BIND;
    const config = cachedConfig || await gatewaySettings.getConfig();
    return config.bind_addr;
}

async function applyRuntimeConfig() {
    const config = await gatewaySettings.getConfig();
    const bindAddr = await resolveBindAddr(config);
    status.bindAddr = bindAddr;
    status.baseUrl = baseUrlFromBind(bindAddr);
    status.autoStart = config.auto_start;
    return bindAddr;
}

async function syncPlatformRouterSecrets(platformSecrets) {
    const { resolveLlmPublicRouterBase } = require('../llm/publicUrl');
    let gatewayKey = status.gatewayKey;
    if (!gatewayKey) {
        const secrets = ensureGatewaySecrets();
        gatewayKey = secrets.gatewayKey;
        status.gatewayKey = gatewayKey;
    }
    await platformSecrets.merge({
        LLM_ROUTER_URL: await resolveLlmPublicRouterBase(),
        LLM_ROUTER_API_KEY: gatewayKey,
    });
}

function killForeignListenerOnPort(bindAddr, log = console) {
    const port = bindAddr.includes(':') ? bindAddr.slice(bindAddr.lastIndexOf(':') + 1) : bindAddr;
    const killPids = (pids) => {
        if (!pids) return false;
        let killed = false;
        for (const pid of pids) {
            if (!Number.isFinite(pid) || pid === process.pid) continue;
            if (child?.pid === pid) continue;
            try {
                process.kill(pid, 'SIGTERM');
                killed = true;
                log.info?.(`[unigateway] stopped foreign listener pid=${pid} on port ${port}`);
            } catch {
                /* ignore */
            }
        }
        return killed;
    };
    const tryFuser = (cb) => {
        execFile('fuser', [`${port}/tcp`], (err, stdout) => {
            const raw = (stdout || '').trim();
            cb(raw ? raw.split(/\s+/).map(Number).filter((n) => Number.isFinite(n)) : null);
        });
    };
    const trySs = (cb) => {
        execFile('ss', ['-tlnp', `sport = :${port}`], (err, stdout) => {
            if (err || !stdout) return cb(null);
            const pids = new Set();
            for (const m of stdout.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
            cb(pids.size ? [...pids] : null);
        });
    };
    return new Promise((resolve) => {
        execFile('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], (err, stdout) => {
            if (!err && stdout.trim()) {
                resolve(killPids(stdout.trim().split('\n').map(Number)));
            } else {
                tryFuser((pids) => {
                    if (pids) resolve(killPids(pids));
                    else trySs((pids2) => resolve(killPids(pids2)));
                });
            }
        });
    });
}

function isManagedChildAlive() {
    return child != null && child.exitCode == null;
}

function probeAdminApi(baseUrl, adminToken) {
    const url = new URL('/api/admin/providers', baseUrl);
    return new Promise((resolve) => {
        const req = http.get(url, {
            headers: { 'x-admin-token': adminToken || '' },
        }, (res) => {
            res.resume();
            resolve(res.statusCode);
        });
        req.on('error', () => resolve(null));
        req.setTimeout(2000, () => {
            req.destroy();
            resolve(null);
        });
    });
}

async function refreshRunningState(log = console) {
    await applyRuntimeConfig();
    const secrets = ensureGatewaySecrets();
    status.gatewayKey = secrets.gatewayKey;
    status.adminToken = secrets.adminToken;
    status.configPath = secrets.configPath;

    if (child?.exitCode != null) {
        child = null;
    }

    let healthy = false;
    try {
        await waitForHealth(status.baseUrl, 2000);
        healthy = true;
    } catch {
        healthy = false;
    }

    if (!healthy) {
        status.running = isManagedChildAlive();
        if (!status.running && !status.lastError) {
            status.lastError = 'UniGateway is not running';
        }
        return getStatus();
    }

    const adminStatus = await probeAdminApi(status.baseUrl, secrets.adminToken);
    if (adminStatus === 200) {
        status.running = true;
        status.lastError = null;
        return getStatus();
    }

    if (isManagedChildAlive()) {
        status.running = true;
        status.lastError = adminStatus === 401
            ? 'UniGateway admin token mismatch. Click Restart.'
            : null;
        return getStatus();
    }

    status.running = false;
    status.lastError = adminStatus === 404
        ? 'Port is held by an outdated UniGateway. Click Restart to reclaim it.'
        : (status.lastError || 'UniGateway is not running');
    log.warn?.(`[unigateway] health ok but admin probe failed (status=${adminStatus ?? 'timeout'})`);
    return getStatus();
}

async function ensureRunning(log = console) {
    if (!ENABLED) return getStatus();
    await refreshRunningState(log);
    if (!status.running && status.autoStart) {
        await killForeignListenerOnPort(status.bindAddr, log);
        await new Promise((r) => setTimeout(r, 300));
        await start(log);
    }
    return getStatus();
}

async function start(log = console, { force = false } = {}) {
    if (!ENABLED) {
        log.info?.('[unigateway] disabled via UNIGATEWAY_ENABLED=0');
        return status;
    }

    const bindAddr = await applyRuntimeConfig();
    const config = ensureGatewaySecrets();
    status.gatewayKey = config.gatewayKey;
    status.adminToken = config.adminToken;
    status.configPath = config.configPath;

    const binary = gatewayBinaryPath();
    status.binary = binary;

    if (!fs.existsSync(binary)) {
        const message = `UniGateway binary not found at ${binary}. Run: cd gateway && cargo build --release`;
        status.lastError = message;
        log.warn?.(`[unigateway] ${message}`);
        return status;
    }

    if (!force) {
        if (isManagedChildAlive()) return status;
        try {
            await waitForHealth(status.baseUrl, 2000);
            const adminStatus = await probeAdminApi(status.baseUrl, config.adminToken);
            if (adminStatus === 200) {
                status.running = true;
                status.lastError = null;
                log.info?.(`[unigateway] reusing existing listener at ${status.baseUrl}`);
                return status;
            }
        } catch {
            /* spawn below */
        }
    } else {
        stop();
        await killForeignListenerOnPort(bindAddr, log);
        await new Promise((r) => setTimeout(r, 300));
    }

    child = spawn(binary, [], {
        env: {
            ...process.env,
            UNIGATEWAY_CONFIG_PATH: config.configPath,
            UNIGATEWAY_BIND_ADDR: bindAddr,
            UNIGATEWAY_ADMIN_TOKEN: config.adminToken,
            RUST_LOG: process.env.UNIGATEWAY_LOG || 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
        log.info?.(`[unigateway] ${chunk.toString().trimEnd()}`);
    });
    child.stderr.on('data', (chunk) => {
        log.warn?.(`[unigateway] ${chunk.toString().trimEnd()}`);
    });

    child.on('exit', (code, signal) => {
        status.running = false;
        child = null;
        if (code !== 0 && code !== null) {
            status.lastError = `UniGateway exited with code ${code}`;
            log.error?.(`[unigateway] exited code=${code} signal=${signal || ''}`);
        }
    });

    try {
        await waitForHealth(status.baseUrl);
        const adminStatus = await probeAdminApi(status.baseUrl, config.adminToken);
        if (isManagedChildAlive() && adminStatus === 200) {
            status.running = true;
            status.lastError = null;
            log.info?.(`[unigateway] ready at ${status.baseUrl}`);
        } else if (adminStatus === 200) {
            child = null;
            status.running = true;
            status.lastError = null;
            log.warn?.(`[unigateway] spawn exited; reusing existing listener at ${status.baseUrl}`);
        } else {
            status.running = false;
            status.lastError = adminStatus === 404
                ? 'Port is held by an outdated UniGateway. Click Restart to reclaim it.'
                : 'UniGateway failed admin readiness check';
            log.error?.(`[unigateway] admin probe failed after start (status=${adminStatus ?? 'timeout'})`);
            stop();
        }
    } catch (err) {
        status.running = false;
        status.lastError = err.message;
        log.error?.(`[unigateway] failed to start: ${err.message}`);
        stop();
    }

    return status;
}

function stop() {
    if (child) {
        child.kill('SIGTERM');
        child = null;
    }
    status.running = false;
}

async function restart(log = console) {
    stop();
    await killForeignListenerOnPort(status.bindAddr, log);
    // Ensure the old listener has fully released the port before spawning,
    // otherwise the new UniGateway may fail to bind and the stale process
    // (loaded with old config) keeps serving and overwrites the TOML.
    for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const stillListening = await killForeignListenerOnPort(status.bindAddr, log);
        if (!stillListening) break;
    }
    return start(log, { force: true });
}

function getStatus() {
    return { ...status, pid: child?.pid ?? null, envBindLocked: Boolean(ENV_BIND) };
}

function installShutdownHooks(log = console) {
    const shutdown = () => {
        stop();
        log.info?.('[unigateway] stopped');
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.once('exit', shutdown);
}

module.exports = {
    start,
    stop,
    restart,
    getStatus,
    applyRuntimeConfig,
    refreshRunningState,
    ensureRunning,
    ensureGatewaySecrets,
    syncPlatformRouterSecrets,
    installShutdownHooks,
    CONFIG_PATH,
};
