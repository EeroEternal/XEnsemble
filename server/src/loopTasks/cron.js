/**
 * LoopTask cron 解析（cron-parser 薄封装）。
 *
 * - validateCron(expr)：合法性校验，非法时抛 Error（message 供 API 层转 errors:loop.cron_invalid）
 * - nextRun(expr, timezone, after)：算下一次触发时间（ms 时间戳），按任务时区解析
 */

let parser = null;
function getParser() {
    if (!parser) parser = require('cron-parser');
    return parser;
}

function validateCron(expr) {
    const e = String(expr || '').trim();
    if (!e) {
        const emptyError = new Error('cron expression is required');
        emptyError.code = 'loop_cron_invalid';
        throw emptyError;
    }
    try {
        getParser().parseExpression(e, { currentDate: new Date() });
    } catch (err) {
        const reason = String(err?.message || err).slice(0, 200);
        const error = new Error(`invalid cron expression: ${reason}`);
        error.code = 'loop_cron_invalid';
        throw error;
    }
    return e;
}

/**
 * @param {string} expr 5 段 cron 表达式
 * @param {string} timezone IANA 时区（如 Asia/Shanghai）
 * @param {Date} [after] 从该时刻之后算（默认现在）
 * @returns {number} 下一次触发的 ms 时间戳
 */
function nextRun(expr, timezone, after) {
    const interval = getParser().parseExpression(String(expr || '').trim(), {
        currentDate: after || new Date(),
        tz: timezone || 'UTC',
    });
    return interval.next().getTime();
}

// ---------------------------------------------------------------------------
// describeCron：crontab.guru 风格的人类可读描述（"At 09:00, Monday through Friday."）
//
// 只支持数字型 5 段表达式 + @shortcuts；含名称（JAN/MON）或罕见结构时返回 null，
// 由调用方降级（前端隐藏描述行，任务列表回退显示原始 cron）。表达式非法时抛错。
// ---------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad2(n) { return String(n).padStart(2, '0'); }

/** 解析单字段：all / step / list / range；不支持的结构返回 null */
function parseField(field, { max } = {}) {
    const f = String(field).trim();
    if (f === '*' || f === '') return { type: 'all' };
    if (f.includes('/')) {
        const [base, stepStr] = f.split('/');
        const step = Number(stepStr);
        if (!Number.isInteger(step) || step <= 0) return null;
        if (base === '*' || base === '') return { type: 'step', step };
        const b = Number(base);
        if (!Number.isInteger(b)) return null;
        return { type: 'stepBase', base: b, step };
    }
    if (f.includes(',')) {
        const parts = f.split(',').map(Number);
        if (parts.some((n) => !Number.isInteger(n))) return null;
        const values = [...new Set(parts.map((n) => (max === 6 && n === 7 ? 0 : n)))].sort((a, b) => a - b);
        return { type: 'list', values };
    }
    if (f.includes('-')) {
        const [aStr, bStr] = f.split('-');
        const a = Number(aStr); const b = Number(bStr);
        if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
        if (max === 6) {
            // dow 范围：7 视作 0（Sunday），跨周环绕（5-1）不支持
            const na = a === 7 ? 0 : a; const nb = b === 7 ? 0 : b;
            if (na > nb) return null;
            return { type: 'range', a: na, b: nb };
        }
        if (a > b) return null;
        return { type: 'range', a, b };
    }
    const n = Number(f);
    if (!Number.isInteger(n)) return null;
    return { type: 'list', values: [max === 6 && n === 7 ? 0 : n] };
}

function hourHuman(h) {
    if (h.type === 'list') return h.values.map(pad2).join(':00, ') + ':00';
    if (h.type === 'range') return `${pad2(h.a)}:00 through ${pad2(h.b)}:00`;
    return null;
}

/** @returns {string|null} 描述文本；结构不支持时 null。locale 支持 en（默认）/ zh */
function describeCron(expr, locale = 'en') {
    const e = String(expr || '').trim().toLowerCase();
    const shortcuts = {
        '@hourly': 'At minute 0 of every hour.',
        '@daily': 'At 00:00.',
        '@midnight': 'At 00:00.',
        '@weekly': 'At 00:00, on Sunday.',
        '@monthly': 'At 00:00, on day-of-month 1.',
        '@yearly': 'At 00:00, on day-of-month 1, in January.',
        '@annually': 'At 00:00, on day-of-month 1, in January.',
    };
    const zhShortcuts = {
        '@hourly': '每小时整点执行。',
        '@daily': '每天 00:00 执行。',
        '@midnight': '每天 00:00 执行。',
        '@weekly': '每周日 00:00 执行。',
        '@monthly': '每月 1 日 00:00 执行。',
        '@yearly': '每年 1 月 1 日 00:00 执行。',
        '@annually': '每年 1 月 1 日 00:00 执行。',
    };
    if (shortcuts[e] || zhShortcuts[e]) {
        return locale?.startsWith('zh') ? zhShortcuts[e] : shortcuts[e];
    }

    const fields = e.split(/\s+/);
    if (fields.length !== 5) {
        const error = new Error('expected 5 fields (minute hour day month weekday)');
        error.code = 'loop_cron_invalid';
        throw error;
    }
    try {
        getParser().parseExpression(e, { currentDate: new Date() }); // 非法表达式 → 抛错
    } catch (err) {
        const error = new Error(`invalid cron expression: ${String(err?.message || err).slice(0, 200)}`);
        error.code = 'loop_cron_invalid';
        throw error;
    }
    if (/[a-z]/.test(e)) return null; // 名称（JAN/MON）不支持描述

    const m = parseField(fields[0], { max: 59 });
    const h = parseField(fields[1], { max: 23 });
    const dom = parseField(fields[2], { max: 31 });
    const mon = parseField(fields[3], { max: 12 });
    const dow = parseField(fields[4], { max: 6 });
    if (!m || !h || !dom || !mon || !dow) return null;
    if ([h, dom, mon, dow].some((f) => f.type === 'stepBase')) return null;
    if ([dom, mon, dow].some((f) => f.type === 'step')) return null; // 日/月步进描述不可靠

    if (locale?.startsWith('zh')) return describeCronZh(m, h, dom, mon, dow);

    // —— 时间部分（en，crontab.guru 风格）——
    let time;
    if (m.type === 'all' && h.type === 'all') time = 'Every minute';
    else if (m.type === 'step' && h.type === 'all') time = `Every ${m.step} minutes`;
    else if (m.type === 'all' && h.type === 'step') time = `Every minute past every ${h.step} hours`;
    else if (m.type === 'step' && h.type === 'step') time = `Every ${m.step} minutes past every ${h.step} hours`;
    else if (m.type === 'list' && m.values.length === 1 && h.type === 'list' && h.values.length === 1) {
        time = `At ${pad2(h.values[0])}:${pad2(m.values[0])}`;
    } else if (h.type === 'all') {
        if (m.type === 'list') time = m.values.length === 1 ? `At minute ${m.values[0]}` : `At minutes ${m.values.join(', ')}`;
        else if (m.type === 'range') time = `At minutes ${m.a} through ${m.b}`;
        else time = null;
    } else if (h.type === 'list' || h.type === 'range') {
        const hh = hourHuman(h);
        if (!hh) time = null;
        else if (m.type === 'list' && m.values.length === 1) time = `At minute ${m.values[0]} past ${hh}`;
        else if (m.type === 'list') time = `At minutes ${m.values.join(', ')} past ${hh}`;
        else if (m.type === 'step') time = `Every ${m.step} minutes past ${hh}`;
        else time = null;
    }
    if (!time) return null;

    // —— 日期部分 ——
    const parts = [time];
    if (dom.type !== 'all' && dow.type !== 'all') {
        if (dom.type !== 'list' || dow.type !== 'list' || dom.values.length !== 1 || dow.values.length !== 1) return null;
        parts.push(`on day-of-month ${dom.values[0]} and ${DAYS[dow.values[0]]}`);
    } else if (dow.type !== 'all') {
        if (dow.type === 'list') parts.push(`on ${dow.values.map((v) => DAYS[v]).join(', ')}`);
        else if (dow.type === 'range') parts.push(`${DAYS[dow.a]} through ${DAYS[dow.b]}`);
        else return null;
    } else if (dom.type !== 'all') {
        if (dom.type === 'list') parts.push(dom.values.length === 1 ? `on day-of-month ${dom.values[0]}` : `on days ${dom.values.join(', ')}`);
        else if (dom.type === 'range') parts.push(`on days ${dom.a} through ${dom.b}`);
        else return null;
    }
    if (mon.type !== 'all') {
        if (mon.type === 'list') parts.push(`in ${mon.values.map((v) => MONTHS[v - 1]).join(', ')}`);
        else if (mon.type === 'range') parts.push(`in ${MONTHS[mon.a - 1]} through ${MONTHS[mon.b - 1]}`);
        else return null;
    }
    return `${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// 中文渲染器：{日期范围}{时刻} 执行。常见组合给出自然表达，罕见组合返回 null。
// ---------------------------------------------------------------------------

const CN_DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const CN_MONTHS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];

function cnJoin(list) { return list.join('、'); }

function describeCronZh(m, h, dom, mon, dow) {
    // —— 时刻部分 ——
    let time;
    if (m.type === 'all' && h.type === 'all') time = '每分钟';
    else if (m.type === 'step' && h.type === 'all') time = `每 ${m.step} 分钟`;
    else if (m.type === 'all' && h.type === 'step') time = `每 ${h.step} 小时`;
    else if (m.type === 'step' && h.type === 'step') return null; // 双步进中文表达不可靠
    else if (m.type === 'list' && m.values.length === 1 && h.type === 'list' && h.values.length === 1) {
        time = `${pad2(h.values[0])}:${pad2(m.values[0])}`;
    } else if (h.type === 'all' && (m.type === 'list' || m.type === 'range')) {
        time = m.type === 'list'
            ? `每小时第 ${cnJoin(m.values)} 分钟`
            : `每小时第 ${m.a} 至 ${m.b} 分钟`;
    } else if (h.type === 'list' && m.type === 'list') {
        // 小规模笛卡尔积直接枚举（0 0,30 9,18 * * * → 09:00、09:30、18:00、18:30）
        const times = [];
        for (const hh of h.values) for (const mm of m.values) times.push(`${pad2(hh)}:${pad2(mm)}`);
        if (times.length > 12) return null;
        time = cnJoin(times);
    } else if (m.type === 'step' && h.type === 'list') {
        time = cnJoin(h.values.map((hh) => `${pad2(hh)}:${pad2(0)} 起每 ${m.step} 分钟`));
    } else {
        return null; // m all × h list/range 等罕见组合不渲染
    }

    // —— 日期范围部分 ——
    const hasMonth = mon.type !== 'all';
    const monthPart = hasMonth
        ? (mon.type === 'list'
            ? `每年 ${cnJoin(mon.values.map((v) => CN_MONTHS[v - 1]))}`
            : `每年 ${CN_MONTHS[mon.a - 1]} 至 ${CN_MONTHS[mon.b - 1]}`) // mon range；step 已在上方过滤
        : null;

    let dayScope;
    if (dom.type !== 'all' && dow.type !== 'all') {
        if (dom.type !== 'list' || dow.type !== 'list' || dom.values.length !== 1 || dow.values.length !== 1) return null;
        dayScope = hasMonth
            ? `${dom.values[0]} 日及${CN_DAYS[dow.values[0]]}`
            : `每月 ${dom.values[0]} 日及${CN_DAYS[dow.values[0]]}`;
    } else if (dow.type !== 'all') {
        dayScope = dow.type === 'list'
            ? `每周${cnJoin(dow.values.map((v) => CN_DAYS[v].replace('周', '')))}`
            : `${CN_DAYS[dow.a]}至${CN_DAYS[dow.b]}`;
    } else if (dom.type !== 'all') {
        dayScope = hasMonth
            ? (dom.type === 'list' ? cnJoin(dom.values.map((d) => `${d} 日`)) : `${dom.a} 至 ${dom.b} 日`)
            : (dom.type === 'list'
                ? (dom.values.length === 1 ? `每月 ${dom.values[0]} 日` : `每月 ${cnJoin(dom.values)} 日`)
                : `每月 ${dom.a} 至 ${dom.b} 日`);
    } else {
        dayScope = '每天';
    }

    // 间隔式时刻（每分钟/每 N 分钟/每 N 小时）与默认「每天」语义重复，去掉冗余
    if (dayScope === '每天' && time.startsWith('每')) {
        return `${[monthPart, time].filter(Boolean).join(' ')} 执行。`;
    }
    return `${[monthPart, dayScope, time].filter(Boolean).join(' ')} 执行。`;
}

// ---------------------------------------------------------------------------
// 三种调度类型（对齐 OpenClaw）：cron / every / at
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = Number(process.env.LOOP_TASK_MIN_INTERVAL_MS) || 5 * 60_000;
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60_000; // 30 天

/**
 * 计算下一次触发时间。task 可以是 DB 行，也可以是含同名字段的草稿对象。
 *   cron  → cron-parser 按时区解析
 *   every → after + interval_ms
 *   at    → 固定目标时间（nextRunAt 本身）
 */
function nextRunForTask(task, after = new Date()) {
    const kind = task.scheduleKind || 'cron';
    if (kind === 'every') {
        const interval = Number(task.intervalMs);
        if (!Number.isInteger(interval) || interval <= 0) {
            const error = new Error('interval_ms is missing or invalid');
            error.code = 'loop_interval_invalid';
            throw error;
        }
        return after.getTime() + interval;
    }
    if (kind === 'at') return Number(task.nextRunAt);
    return nextRun(task.cronExpr, task.timezone, after);
}

function humanizeInterval(ms, locale = 'en') {
    const days = ms / 86_400_000;
    if (Number.isInteger(days)) return locale?.startsWith('zh') ? `每 ${days} 天执行。` : `Every ${days} days.`;
    const hours = ms / 3_600_000;
    if (Number.isInteger(hours)) return locale?.startsWith('zh') ? `每 ${hours} 小时执行。` : `Every ${hours} hours.`;
    const minutes = Math.round(ms / 60_000);
    return locale?.startsWith('zh') ? `每 ${minutes} 分钟执行。` : `Every ${minutes} minutes.`;
}

/**
 * 人类可读描述（kind 感知 + locale）。非法 cron 抛 loop_cron_invalid；结构不支持返回 null。
 */
function describeSchedule(task, locale = 'en') {
    const zh = locale?.startsWith('zh');
    const kind = task.scheduleKind || 'cron';
    if (kind === 'every') {
        const interval = Number(task.intervalMs);
        if (!Number.isInteger(interval) || interval <= 0) {
            const error = new Error('interval_ms is missing or invalid');
            error.code = 'loop_interval_invalid';
            throw error;
        }
        return humanizeInterval(interval, locale);
    }
    if (kind === 'at') {
        const runAt = Number(task.nextRunAt);
        if (!Number.isFinite(runAt) || runAt <= 0) return null;
        let local = '';
        try {
            local = new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
                timeZone: task.timezone || 'UTC',
                dateStyle: 'medium',
                timeStyle: 'short',
            }).format(new Date(runAt));
        } catch {
            local = new Date(runAt).toISOString();
        }
        return zh ? `单次，于 ${local} 执行。` : `Once, at ${local}.`;
    }
    return describeCron(task.cronExpr, locale);
}

module.exports = { validateCron, nextRun, describeCron, nextRunForTask, describeSchedule, MIN_INTERVAL_MS, MAX_INTERVAL_MS };
