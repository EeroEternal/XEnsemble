/**
 * 终端鼠标模式降级：把「任意移动都上报」的 ANY 协议降为 DRAG。
 *
 * 背景：opencode 的 TUI 启动时会发 `ESC [ ? 1000h ? 1002h ? 1003h ? 1006h`
 * 四连，其中 **1003h（ANY）** 让 xterm.js 把鼠标「纯移动、未按任何键」也编码成
 * 事件回送给 TUI。用户只是把鼠标划过终端，就会产生大量
 * `ESC [ < 35 ; x ; y M`（35 = motion + button 3 = 无按键）。
 *
 * 实测（opencode 会话转录）：228 个鼠标事件里 226 个是这类悬停，峰值 75 次/分；
 * opencode 每次悬停都会重绘悬停行（整行显式 truecolor 前后景），与用户按键
 * 抢同一个渲染线程 —— 表现为「敲了字要等约 0.5s 才显示」。
 *
 * 处理：把 DECSET/DECRST 里的参数 1003 一律改写成 1002。
 *   - ANY(31) → DRAG(23)：保留 点击 / 拖动 / 滚轮，仅丢弃「无按键的纯移动」。
 *   - DECRST 一并改写只为保持变换对称；xterm 里 1000l / 1002l / 1003l 语义相同
 *     （都是把 activeProtocol 置为 NONE），因此这一步是行为等价的空操作。
 *   - 关键：**绝不触碰 1000h / 1002h**。历史提交 98964d5 回滚上一版方案，正是
 *     因为当时整族剥离了 1000h/1002h/1003h/1006h，xterm 完全没进入鼠标追踪，
 *     TUI 收不到滚轮。本变换只动 1003，点击/拖动/滚轮的上报链路原样保留。
 *
 * 仅对已知会刷悬停的 agent 生效（见 HOVER_MOUSE_DOWNGRADE_AGENTS）；其余 agent
 * 字节流逐字节不变。代价仅是失去悬停高亮。
 */

// 与 terminalFrameDrop.js 同一约定：按 agent 白名单启用，便于 A/B 与回滚。
export const HOVER_MOUSE_DOWNGRADE_AGENTS = ['opencode'];

/** 该 agent 是否启用悬停鼠标模式降级。 */
export function isHoverMouseDowngradeAgent(agentId) {
  return HOVER_MOUSE_DOWNGRADE_AGENTS.includes(String(agentId || '').toLowerCase());
}

// 本文件专用于匹配终端控制序列（ESC），必须使用含控制字符的正则。
/* eslint-disable no-control-regex */

// DECSET / DECRST，参数可带分号（如 `ESC [ ? 1000 ; 1003 h`）。
const DECSET_RE = /\x1b\[\?([0-9;]+)([hl])/g;

/**
 * 把鼠标模式参数 1003 改写为 1002，其余字节原样保留。
 * 不含 1003 的序列（含所有非鼠标控制序列）不做任何改动。
 */
export function downgradeHoverMouseMode(data) {
  if (typeof data !== 'string' || data.indexOf('\x1b[?') === -1) return data;
  return data.replace(DECSET_RE, (match, params, final) => {
    const parts = params.split(';');
    if (!parts.includes('1003')) return match;
    const rewritten = parts.map((p) => (p === '1003' ? '1002' : p));
    return `\x1b[?${rewritten.join(';')}${final}`;
  });
}
