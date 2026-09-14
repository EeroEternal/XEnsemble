/**
 * TEMPORARY: LLM 原始请求采集（prompt capture）。
 *
 * 把 agent 组装后发到网关的完整请求体（内置 system prompt + 全量 messages +
 * tools + 参数）落盘为 pretty JSON，供人工对比各 agent 的提示词组装方式，
 * 为网关侧消息归一化 / 上下文裁剪设计提供输入。网关消息处理功能上线后本
 * 模块整体移除。
 *
 * 默认开启（LLM_CAPTURE_MODE 未设置时 = all），零配置生效——部署链路
 * （CI 固定变量清单 / systemd EnvironmentFile 仅首装复制）不会透传新增
 * 环境变量，因此开关语义必须落在代码默认值上。磁盘由采样上限 + 总量配额
 * + 保留期兜底；显式设 LLM_CAPTURE_MODE=off 关闭。
 *
 * 接入点：llm/proxy.js proxyLlmRequest —— opencode alias 改写之前调用，
 * request.body 仍是 agent 发来的原始字节。
 *
 * 布局：
 *   $LLM_CAPTURE_DIR/<YYYY-MM-DD>/<agent>/<sessionId>/t<turn>_<HHmmss>_<mmm>.json
 * 文件内 meta 记来源（agent/session/user/project）、协议、模型、turn、原始
 * 字节数与时间；body 为原始请求 JSON。解析失败 / 超过单请求上限时写元数据
 * 桩（parse_error / oversize），不落 body。
 *
 * 磁盘保护：
 *   - 采样模式：all（默认）/ turns（每会话前 N 个）/ first / off
 *   - 单请求上限 LLM_CAPTURE_MAX_BYTES，超限只写桩
 *   - 总量配额 LLM_CAPTURE_MAX_TOTAL_MB，超限从最旧日期目录删除（当天不删）
 *   - 保留期 LLM_CAPTURE_RETENTION_DAYS，启动 + 定时清理过期日期目录
 *   - 写盘 ENOSPC/EDQUOT → 自动停采直到重启，避免失败重试放大故障
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE_MIN_INTERVAL_MS = 60 * 1000;

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

// 会话内请求计数（turn 序号）。first/turns 模式窗口过后即删条目，map 不增长；
// all 模式超软上限时整体清零——文件名含时间戳，序号重复也不会互相覆盖。
const turnCounters = new Map();
const TURN_COUNTER_SOFT_CAP = 20000;

// 写盘失败自保护：磁盘满后停采，重启才恢复。
let disabled = false;
let lastWriteErrorLogAt = 0;

let lastMaintenanceAt = 0;
let maintenanceRunning = false;

function pad2(n) { return String(n).padStart(2, '0'); }

function localDateParts(ts) {
    const d = new Date(ts);
    return {
        date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
        time: `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}_${String(d.getMilliseconds()).padStart(3, '0')}`,
    };
}

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

function buildRecord(claims, pathname, bodyBuffer, bodyModel, turn) {
    const oversize = bodyBuffer.length > cfg.maxBytes;
    let parsed = null;
    let parseError = false;
    if (!oversize) {
        try {
            parsed = JSON.parse(bodyBuffer.toString('utf8'));
        } catch (_) {
            parseError = true;
        }
    }
    const now = Date.now();
    const { date, time } = localDateParts(now);
    const meta = {
        agent: claims.aid ?? null,
        session_id: claims.sid ?? null,
        user_id: claims.uid ?? null,
        project_id: claims.pid ?? null,
        protocol: pathname.endsWith('/messages') ? 'anthropic' : 'openai',
        path: pathname,
        model: bodyModel ?? claims.model ?? null,
        turn,
        body_bytes: bodyBuffer.length,
        ts: now,
        captured_at: new Date(now).toISOString(),
    };
    const record = { meta };
    if (oversize) {
        record.oversize = true;
        record.body = null;
    } else if (parseError) {
        record.parse_error = true;
        record.body = null;
    } else {
        record.body = parsed;
    }
    const fileName = `t${String(turn).padStart(3, '0')}_${time}`
        + `${oversize ? '_oversize' : ''}${parseError ? '_parse_error' : ''}.json`;
    const relPath = path.join(
        date,
        sanitizePathSegment(meta.agent, 'unknown'),
        sanitizePathSegment(meta.session_id, 'unknown'),
        fileName,
    );
    return { relPath, record };
}

async function writeAtomic(absPath, content) {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    const tmp = `${absPath}.tmp`;
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, absPath);
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

async function dirSize(dir) {
    let total = 0;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            total += await dirSize(p);
        } else if (e.isFile()) {
            const st = await fsp.stat(p).catch(() => null);
            total += st?.size ?? 0;
        }
    }
    return total;
}

/**
 * 保留期 + 总量配额清理。按日期目录整体删除（最旧先删），当天目录永不删。
 * 目录名即日期（YYYY-MM-DD），字典序比较即时间比较。
 */
async function runMaintenance() {
    const dateDirs = (await fsp.readdir(cfg.dir, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .map((e) => e.name)
        .sort();
    if (dateDirs.length === 0) return;
    const now = Date.now();

    if (cfg.retentionDays > 0) {
        const cutoff = localDateParts(now - cfg.retentionDays * DAY_MS).date;
        for (const d of dateDirs) {
            if (d < cutoff) await fsp.rm(path.join(cfg.dir, d), { recursive: true, force: true });
        }
    }

    if (cfg.maxTotalMB > 0) {
        const today = localDateParts(now).date;
        const quotaBytes = cfg.maxTotalMB * 1024 * 1024;
        let total = 0;
        const sizes = [];
        for (const d of dateDirs) {
            const s = await dirSize(path.join(cfg.dir, d));
            sizes.push([d, s]);
            total += s;
        }
        for (const [d, s] of sizes) {
            if (total <= quotaBytes || d === today) break;
            await fsp.rm(path.join(cfg.dir, d), { recursive: true, force: true });
            total -= s;
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
 * 采集一次请求。turn 序号与采样判定同步完成（保证按调用顺序编号），磁盘
 * 写入 fire-and-forget，任何失败不影响转发热路径。返回写入 promise（测试
 * 用），未采集时返回 undefined。
 *
 * @param {{sid:string, uid?:string, pid?:string, aid?:string, model?:string}} claims
 * @param {string} upstreamPath proxy stripLlmPrefix 后的路径（可含 query）
 * @param {Buffer} bodyBuffer agent 原始请求体
 * @param {string|null} bodyModel 请求体中的 model（proxy 已解析）
 */
function capture(claims, upstreamPath, bodyBuffer, bodyModel) {
    if (!cfg.enabled || disabled) return undefined;
    if (!claims?.sid || !Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) return undefined;
    const turn = nextTurn(String(claims.sid));
    if (!shouldCapture(turn)) return undefined;
    const { relPath, record } = buildRecord(
        claims,
        String(upstreamPath || '/').split('?')[0],
        bodyBuffer,
        bodyModel ?? null,
        turn,
    );
    const write = writeAtomic(path.join(cfg.dir, relPath), JSON.stringify(record, null, 2))
        .catch(onWriteError);
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
    disabled = false;
    lastWriteErrorLogAt = 0;
    lastMaintenanceAt = 0;
    maintenanceRunning = false;
}

module.exports = { capture, runMaintenance, reloadForTest };
