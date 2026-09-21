/**
 * 终端渲染诊断（默认关闭，零热路径开销）。
 *
 * 目的：定位「输入时字符反复跳变 / 整屏多处跳变」这类只能靠现场数据判断的问题。
 * 关闭时 record() 只做一次布尔判断后立即返回——不构造对象、不写 console、
 * 不碰 localStorage，因此可以安全地插在 flush/vsProcess/write 等必经路径上，
 * 不会刷磁盘也不会拖慢渲染。
 *
 * 启用方式（任选其一，二选一即可）：
 *   window.__xeTerm.enable()                       // 控制台开启（当前页生效）
 *   localStorage.setItem('xe_term_debug', '1')     // 刷新后仍生效
 *
 * 复现后导出：
 *   __xeTerm.dump()      // 打印结构化日志（环形缓冲，最近 N 条）
 *   __xeTerm.summary()   // 只打印聚合结论（漂移/宽度不一致计数），信息密度最高
 *   __xeTerm.copy()      // 返回 JSON 字符串，便于整段复制
 *   __xeTerm.clear()     // 清空缓冲
 *
 * 记录的事件类型：
 *   flush    每次 flushWriteBuffer：输入字节数、是否含 sync 块、alt screen 状态
 *   vs       vsProcess 实际执行：upCount/startRow/光标前后/是否产生输出/返回分支
 *   drift    【重点】写入后比对「虚拟屏幕 vs 真实屏幕」+「vsCursorY vs 真实光标」
 *   width    【重点】手写宽度表 vs xterm 实际 wcwidth 对同一字符的判定差异
 *   resize   终端尺寸变化（含 vsScreen/vsRows 状态）
 *   alt      alt screen 进出
 */

const MAX_ENTRIES = 4000;

let enabled = false;
let entries = [];
let dropped = 0;

try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('xe_term_debug') === '1') {
    enabled = true;
  }
} catch { /* ignore */ }

/** 关闭时仅一次布尔判断后返回；调用方请用 isEnabled() 守卫以避免构造对象。 */
export function record(evt) {
  if (!enabled) return;
  if (entries.length >= MAX_ENTRIES) {
    entries.shift();
    dropped += 1;
  }
  entries.push({ t: Date.now(), ...evt });
}

export function isEnabled() {
  return enabled;
}

export function enable() {
  enabled = true;
  try { localStorage.setItem('xe_term_debug', '1'); } catch { /* ignore */ }
  return `terminal debug enabled (buffer=${MAX_ENTRIES})`;
}

export function disable() {
  enabled = false;
  try { localStorage.removeItem('xe_term_debug'); } catch { /* ignore */ }
  return 'terminal debug disabled';
}

export function clear() {
  entries = [];
  dropped = 0;
  return 'cleared';
}

export function getEntries() {
  return entries;
}

/** 结构化导出（供人工复制）。 */
export function copy() {
  return JSON.stringify({ count: entries.length, dropped, entries }, null, 1);
}

/**
 * 聚合结论：信息密度最高，先看这个。
 * - drift：虚拟屏幕/光标与真实屏幕不一致的次数与样本
 * - width：手写宽度表与 xterm 判定不一致的字符
 */
export function summary() {
  const byKind = {};
  const driftSamples = [];
  const widthSamples = [];
  let maxCursorDrift = 0;
  for (const e of entries) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    if (e.kind === 'drift') {
      const d = Math.abs((e.realCursorY ?? 0) - (e.vsCursorY ?? 0));
      if (d > maxCursorDrift) maxCursorDrift = d;
      if (driftSamples.length < 12) driftSamples.push(e);
    }
    if (e.kind === 'width' && widthSamples.length < 40) widthSamples.push(e);
  }
  return {
    enabled,
    count: entries.length,
    dropped,
    byKind,
    maxCursorDrift,
    driftSamples,
    widthSamples,
  };
}

// 控制台入口。挂到 window 上便于复现时直接调用。
if (typeof window !== 'undefined') {
  window.__xeTerm = {
    enable,
    disable,
    clear,
    copy,
    summary,
    dump: () => { console.log(copy()); return `logged ${entries.length} entries`; },
    get: getEntries,
  };
}

export const TERM_DEBUG_MAX_ENTRIES = MAX_ENTRIES;
