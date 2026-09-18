/**
 * 全屏重绘型 TUI（qwen-code）专用的终端积压裁剪。
 *
 * 背景：qwen-code 以实测 ~156KB/s 突发输出「整屏重绘帧」（每帧用绝对定位 +
 * \x1b[2K 重画整屏，包在 \x1b[?2026h ... \x1b[?2026l 内）。浏览器渲染跟不上
 * 时 AgentConsole 的 writeBuffer 无界增长 → 8MB 触顶 → 断开重连 + 锚点重放 →
 * 再次触顶，形成「冻结→重放→再冻结」死循环（63851b9 的自愈设计在该场景下被
 * 反复触发）。
 *
 * 裁剪规则（**仅对 qwen-code 生效**，其他 agent 完全不进入此路径，行为与改动
 * 前逐字节一致）：
 *   - 积压超 minKeepBytes 时，丢弃最旧的前缀；切点必须落在一个「满整屏重绘帧」
 *     （重画行数 ≥ 屏高）的**结束处**，且该锚点帧本身保留。锚点帧会重画整屏，
 *     因此被丢弃的更早帧在屏幕上被它完全覆盖 → 最终画面一致。
 *   - 增量 diff 帧（重画行数 < 屏高）**永不**作为锚点：它们依赖前序屏幕状态，
 *     单独丢弃会造成画面残缺（这正是历史上「修 qwen 就伤 opencode/cline」的
 *     根因——opencode/cline 的 sync 块全是这类帧）。
 *   - 未闭合的 sync 块（跨 WS 消息被截断，尚在 syncTermPending 中）不参与丢弃。
 *   - 前缀中的非 sync 数据（mouse tracking 等模式序列）保留并前置，沿用
 *     44014b6 的语义，避免丢帧导致 TUI 滚轮/鼠标行为失效。
 *
 * 验证：用真实转录（qwen-code / opencode / cline / codebuddy）+ headless xterm
 * 逐行比对「裁剪后最终屏幕」与「不裁剪参考屏幕」——qwen 一致，其余三者因无可
 * 用锚点而零丢弃（天然不受影响）。
 */

// 只有这些 agent 走裁剪路径。其余 agent 保持原有字节透明管线。
export const FULL_REPAINT_DROP_AGENTS = ['qwen-code'];

// 裁剪后至少保留的积压字节数。
//
// 注意：这个值也是**单次 flush 在主线程上同步处理的数据量上限**（flush 里
// 会把积压交给 vsProcess 逐行 diff + terminal.write，都是同步阻塞）。
// 256KB 的满屏重绘帧一次处理可卡住主线程数秒，表现为终端“冻住”；降到 64KB
// 把长阻塞切成短阻塞（flush 之间 setTimeout 会还给事件循环，UI 保持响应）。
// 锚点帧重画整屏，保留更少帧不改变最终画面（qwen 满屏重绘语义不变）。
export const FULL_REPAINT_DROP_MIN_KEEP_BYTES = 64 * 1024;

const SYNC_OPEN = '\x1b[?2026h';
const SYNC_CLOSE = '\x1b[?2026l';
const ERASE_LINE = '\x1b[2K';

/** 该 agent 是否使用全屏重绘裁剪路径。 */
export function isFullRepaintDropAgent(agentId) {
  return FULL_REPAINT_DROP_AGENTS.includes(String(agentId || '').toLowerCase());
}

/** 统计 [from, to) 区间内 \x1b[2K 的出现次数（避免为每个块切子串）。 */
function countEraseLines(s, from, to) {
  let n = 0;
  let i = s.indexOf(ERASE_LINE, from);
  while (i !== -1 && i < to) {
    n += 1;
    i = s.indexOf(ERASE_LINE, i + ERASE_LINE.length);
  }
  return n;
}

/**
 * 丢弃最旧的完整 sync 块前缀，切点落在「满整屏重绘帧」结束处。
 *
 * @param {string} pending 待写入 xterm 的积压数据
 * @param {{ rows?: number, minKeepBytes?: number }} [opts]
 * @returns {{ data: string, droppedBytes: number }} 裁剪后的数据与丢弃字节数
 *          （无可作锚点的帧时原样返回，droppedBytes 为 0）
 */
export function dropFullRepaintPrefix(pending, opts = {}) {
  if (typeof pending !== 'string') return { data: pending, droppedBytes: 0 };
  const minKeepBytes = Number(opts.minKeepBytes) > 0
    ? Number(opts.minKeepBytes)
    : FULL_REPAINT_DROP_MIN_KEEP_BYTES;
  if (pending.length <= minKeepBytes) return { data: pending, droppedBytes: 0 };

  const need = pending.length - minKeepBytes; // 至少要丢弃的字节数
  const rowCount = Math.max(1, Number(opts.rows) || 1);

  let cursor = 0;
  let nonSyncKept = '';
  let anchorStart = -1;
  while (cursor < pending.length) {
    const open = pending.indexOf(SYNC_OPEN, cursor);
    if (open === -1) break;
    if (open > cursor) nonSyncKept += pending.slice(cursor, open); // 块外数据
    const close = pending.indexOf(SYNC_CLOSE, open);
    if (close === -1) break; // 未闭合块：不丢、停止扫描
    const end = close + SYNC_CLOSE.length;
    // 判据用「锚点帧**起始**位置之前已累计的字节数 ≥ need」——与验证台架一致：
    // 丢弃 [0, open) 的前缀（≥ need 字节），并保留锚点帧本身。
    if (countEraseLines(pending, open, end) >= rowCount && open >= need) {
      anchorStart = open;
      break;
    }
    cursor = end;
  }
  if (anchorStart < 0) return { data: pending, droppedBytes: 0 };

  return {
    data: nonSyncKept + pending.slice(anchorStart),
    droppedBytes: anchorStart - nonSyncKept.length,
  };
}