/**
 * TEMPORARY: LLM 原始请求采集（prompt capture）。
 *
 * 每个会话一个 JSON 文件，累加记录该会话内 agent 发给网关的每一次完整请求
 * 报文（内置 system prompt + 全量 messages + tools + 参数），供人工对比各
 * agent 的提示词组装方式，为网关侧消息归一化 / 上下文裁剪设计提供输入。
 * 文件布局与格式：
 *
 *   $LLM_CAPTURE_DIR/<agent>/<sessionId>.json
 *   {
 *     "agent": "opencode",
 *     "messages": [ <请求1完整报文>, <请求2完整报文>, ... ]
 *   }
 *
 * messages 数组顺序即请求时序；元素为请求体原始 JSON（超限 / 解析失败时为
 * 标记对象，不落原始 body）。网关消息处理功能上线后本模块整体移除。
 *
 * 默认开启（LLM_CAPTURE_MODE 未设置时 = all），零配置生效——部署链路
 * （CI 固定变量清单 / systemd EnvironmentFile 仅首装复制）不会透传新增
 * 环境变量，因此开关语义必须落在代码默认值上。显式设 off 关闭。
 *
 * 磁盘保护：
 *   - 采样模式：all（默认，全量请求）/ turns（每会话前 N 个）/ first / off
 *   - 单请求上限 LLM_CAPTURE_MAX_BYTES：超限只记 oversize 标记元素
 *   - 总量配额 LLM_CAPTURE_MAX_TOTAL_MB：超限按文件 mtime 从最旧删除
 *     （近 1 分钟内活跃的会话文件跳过）
 *   - 保留期 LLM_CAPTURE_RETENTION_DAYS：按文件 mtime 清理
 *   - 写盘 ENOSPC/EDQUOT → 自动停采直到重启，避免失败重试放大故障
 *
 * 接入点：llm/proxy.js proxyLlmRequest —— opencode alias 改写之前调用，
 * request.body 仍是 agent 发来的原始字节。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE_MIN_INTERVAL_MS = 60 * 1000;
const ACTIVE_FILE_GRACE_MS = 60 * 1000;

function numEnv(name, fallback, { min = 1, integer = true } = {}) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const n = integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
    return Number.isFinite(n) && n >= min ? n : fallback;
}

function readConfig() {
    const mode = String(process.env.LLM_CAPTURE_MODE || 'all').trim().toLowerCase();
    const enabled = mode === 'first' || mode === 'turns' || mode === 'all';
    return {
        mode: enabled ? mode : 'off',
        enabled,
        dir: process.env.LLM_CAPTURE_DIR || '/var/lib/xensemble/llm-capture',
        turns: numEnv('LLM_CAPTURE_TURNS', 3),
        maxBytes: numEnv('LLM_CAPTURE_MAX_BYTES', 8 * 1024 * 1024),
        maxTotalMB: numEnv('LLM_CAPTURE_MAX_TOTAL_MB', 2048, { min: 0, integer: false }),
        retentionDays: numEnv('LLM_CAPTURE_RETENTION_DAYS', 7, { min: 0 }),
    };
}

let cfg = readConfig();

// 采样判定用：会话内请求计数。first/turns 模式窗口过后即删条目，map 不增长；
// all 模式超软上限时整体清零（仅影响后续采样判定，不影响已落盘内容）。
const turnCounters = new Map();
const TURN_COUNTER_SOFT_CAP = 20000;

// 会话文件为读-改-写累加模型，按会话串行化（并发请求不丢元素、不互相覆盖）。
const sessionChains = new Map();
const SESSION_CHAIN_SOFT_CAP = 20000;

// 写盘失败自保护：磁盘满后停采，重启才恢复。
let disabled = false;
let lastWriteErrorLogAt = 0;

let lastMaintenanceAt = 0;
let maintenanceRunning = false;

function sanitizePathSegment(value, fallback) {
    const s = String(value || '').replace(/[^A-Za-z0-9._-]/g, '_');
    return s || fallback;
}

function nextTurn(sessionId) {
    const turn = (turnCounters.get(sessionId) || 0) + 1;
    turnCounters.set(sessionId, turn);
    if (cfg.mode !== 'all') {
        const window = cfg.mode === 'first' ? 1 : cfg.turns;
        if (turn > window) turnCounters.delete(sessionId);
    } else if (turnCounters.size > TURN_COUNTER_SOFT_CAP) {
        turnCounters.clear();
    }
    return turn;
}

function shouldCapture(turn) {
    if (cfg.mode === 'all') return true;
    if (cfg.mode === 'first') return turn === 1;
    return turn <= cfg.turns;
}

/** 请求体 → messages 数组元素。原始 JSON；超限 / 非法 JSON 记标记对象。 */
function buildElement(bodyBuffer) {
    if (bodyBuffer.length > cfg.maxBytes) {
        return { oversize: true, body_bytes: bodyBuffer.length };
    }
    try {
        return JSON.parse(bodyBuffer.toString('utf8'));
    } catch (_) {
        return { parse_error: true, body_bytes: bodyBuffer.length };
    }
}

async function writeAtomic(absPath, content) {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    const tmp = `${absPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, absPath);
}

/**
 * 读-改-写累加会话文件。首次触碰从磁盘恢复（进程重启后同一会话继续追加
 * 而不是覆盖）；文件缺失 / 损坏时从空记录开始。
 */
async function appendToSessionFile(claims, element) {
    const abs = path.join(
        cfg.dir,
        sanitizePathSegment(claims.aid, 'unknown'),
        `${sanitizePathSegment(claims.sid, 'unknown')}.json`,
    );
    let record = { agent: claims.aid ?? null, messages: [] };
    try {
        const parsed = JSON.parse(await fsp.readFile(abs, 'utf8'));
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) {
            record.agent = parsed.agent ?? record.agent;
            record.messages = parsed.messages;
        }
    } catch (_) { /* 首次采集或文件损坏 → 从空开始 */ }
    record.messages.push(element);
    await writeAtomic(abs, JSON.stringify(record, null, 2));
}

function onWriteError(err) {
    if (err && (err.code === 'ENOSPC' || err.code === 'EDQUOT')) {
        if (!disabled) {
            disabled = true;
            console.error('[prompt-capture] disk full — capture disabled until process restart');
        }
        return;
    }
    const now = Date.now();
    if (now - lastWriteErrorLogAt >= 60000) {
        lastWriteErrorLogAt = now;
        console.error('[prompt-capture] write failed:', err?.message || err);
    }
}

async function listCaptureFiles() {
    const files = [];
    const agentDirs = await fsp.readdir(cfg.dir, { withFileTypes: true }).catch(() => []);
    for (const d of agentDirs) {
        if (!d.isDirectory()) continue;
        const agentDir = path.join(cfg.dir, d.name);
        const entries = await fsp.readdir(agentDir, { withFileTypes: true }).catch(() => []);
        for (const f of entries) {
            if (!f.isFile() || f.name.endsWith('.tmp')) continue;
            const st = await fsp.stat(path.join(agentDir, f.name)).catch(() => null);
            if (st) files.push({ path: path.join(agentDir, f.name), mtime: st.mtimeMs, size: st.size });
        }
    }
    return files;
}

/**
 * 保留期 + 总量配额清理。文件粒度按 mtime 判新旧；配额删除时跳过活跃
 * （近 ACTIVE_FILE_GRACE_MS 内修改过）的会话文件。
 */
async function runMaintenance() {
    const files = await listCaptureFiles();
    if (files.length === 0) return;
    const now = Date.now();

    if (cfg.retentionDays > 0) {
        const cutoff = now - cfg.retentionDays * DAY_MS;
        for (const f of files) {
            if (f.mtime < cutoff) await fsp.rm(f.path, { force: true });
        }
    }

    if (cfg.maxTotalMB > 0) {
        const quotaBytes = cfg.maxTotalMB * 1024 * 1024;
        let total = files.reduce((s, f) => s + f.size, 0);
        if (total > quotaBytes) {
            const oldest = files.slice().sort((a, b) => a.mtime - b.mtime);
            for (const f of oldest) {
                if (total <= quotaBytes) break;
                if (now - f.mtime < ACTIVE_FILE_GRACE_MS) continue;
                await fsp.rm(f.path, { force: true });
                total -= f.size;
            }
        }
    }
}

function scheduleMaintenance() {
    if (maintenanceRunning) return;
    const now = Date.now();
    if (now - lastMaintenanceAt < MAINTENANCE_MIN_INTERVAL_MS) return;
    lastMaintenanceAt = now;
    maintenanceRunning = true;
    runMaintenance()
        .catch(() => { /* 清理失败不影响采集与转发 */ })
        .finally(() => { maintenanceRunning = false; });
}

/**
 * 采集一次请求。turn 序号与采样判定同步完成（保证按调用顺序编号），同一
 * 会话的文件追加按链串行化，磁盘写入失败不影响转发热路径。返回写入
 * promise（测试用），未采集时返回 undefined。
 *
 * @param {{sid:string, uid?:string, pid?:string, aid?:string}} claims
 * @param {Buffer} bodyBuffer agent 原始请求体（完整报文）
 */
function capture(claims, bodyBuffer) {
    if (!cfg.enabled || disabled) return undefined;
    if (!claims?.sid || !Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return undefined;
    const turn = nextTurn(String(claims.sid));
    if (!shouldCapture(turn)) return undefined;
    const element = buildElement(bodyBuffer);
    const sid = String(claims.sid);
    const prev = sessionChains.get(sid) || Promise.resolve();
    const write = prev.catch(() => {}).then(() => appendToSessionFile(claims, element));
    sessionChains.set(sid, write.catch(() => { }));
    if (sessionChains.size > SESSION_CHAIN_SOFT_CAP) sessionChains.clear();
    write.catch(onWriteError);
    scheduleMaintenance();
    return write;
}

if (cfg.enabled) {
    const startup = setTimeout(() => { runMaintenance().catch(() => {}); }, 5000);
    startup.unref?.();
    const periodic = setInterval(() => { runMaintenance().catch(() => {}); }, 6 * 60 * 60 * 1000);
    periodic.unref?.();
}

function reloadForTest() {
    cfg = readConfig();
    turnCounters.clear();
    sessionChains.clear();
    disabled = false;
    lastWriteErrorLogAt = 0;
    lastMaintenanceAt = 0;
    maintenanceRunning = false;
}

module.exports = { capture, runMaintenance, reloadForTest };
