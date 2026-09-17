/**
 * 终端「查询序列」工具：剔除会让 xterm.js / AgentConsole 生成回包的查询字节。
 *
 * 背景：agent TUI（opencode、Cursor Agent 等）启动时会探测宿主终端，例如用
 * `ESC ] 11 ; ? ST` 问默认背景色、`ESC ] 4 ; 0 ; ? ST` 问调色板、用
 * `ESC [ 6 n` 问光标位置。这些应答只有一条出口 —— AgentConsole 的 `onData` /
 * OSC 处理器把回包写回 PTY，而 `onData` 同时也是用户敲键盘的通道。于是
 * 「回答终端探测」和「用户输入」共用同一条管道。
 *
 * 问题：切回会话 / 断线重连时，服务端会重放历史转录，历史里的查询序列会被
 * xterm 解析器**再次**触发应答。此时提问的 TUI 早已不再等待，回包就成了打进
 * 前台进程 stdin 的按键 —— 表现为终端里被自动输入 `11;rgb:ffff/ffff/ffff`
 * 之类的乱码（见 docs/DurableSessions-Followups.md §5）。
 *
 * 因此只对**实时输出**里的查询回包；重放阶段的查询在写入 xterm 之前就从字节
 * 流里剔除（见 AgentConsole 的 liveOutputRef + 服务端 `replay-done` 标记）。
 * 被剔除的都是「不可见、只用于问答」的序列，剔除不影响画面；OSC 52 剪贴板
 * 写入、设色指令等真正的「命令」一律保留。
 */

// 本文件专用于匹配终端控制序列（ESC / BEL），必须使用含控制字符的正则。
/* eslint-disable no-control-regex */

// 会被主动回包的查询序列：
//   OSC 10/11/12 ; ?          —— 默认前景 / 背景 / 光标色查询
//   CSI 5n / 6n / ?6n         —— 设备状态 / 光标位置查询（DSR）
//   CSI c / CSI >c            —— 设备属性查询（DA1 / DA2）
//   CSI 14t / 18t             —— 窗口尺寸查询（像素 / 字符）
const TERMINAL_QUERY_RES = [
  /\x1b\](?:10|11|12);\?(?:\x07|\x1b\\)/g,
  /\x1b\[5n/g,
  /\x1b\[6n/g,
  /\x1b\[\?6n/g,
  /\x1b\[>c/g,
  /\x1b\[c/g,
  /\x1b\[14t/g,
  /\x1b\[18t/g,
];

// OSC 4（调色板，`ESC ] 4 ; <idx> ; <value> ST`）可以一次携带多项。查询项
// （value 为 `?`）要剔除，设色项（`#rrggbb` / `rgb:…`）必须原样保留。
const OSC4_RE = /\x1b\]4;([^\x07\x1b]*)(\x07|\x1b\\)/g;

function stripOsc4Queries(data) {
  return data.replace(OSC4_RE, (match, payload, terminator) => {
    if (payload.indexOf('?') === -1) return match;
    const parts = payload.split(';');
    const kept = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      if (String(parts[i + 1]).trim() === '?') continue;
      kept.push(parts[i], parts[i + 1]);
    }
    if (kept.length === 0) return '';
    return `\x1b]4;${kept.join(';')}${terminator}`;
  });
}

/** 剔除会触发终端回包的查询序列，其余字节原样保留。 */
export function stripTerminalQueries(data) {
  if (typeof data !== 'string' || data.indexOf('\x1b') === -1) return data;
  let out = stripOsc4Queries(data);
  for (const re of TERMINAL_QUERY_RES) {
    if (out.indexOf('\x1b') === -1) break;
    out = out.replace(re, '');
  }
  return out;
}
