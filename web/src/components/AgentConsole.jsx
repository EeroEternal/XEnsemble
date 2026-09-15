import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

import { getAccessToken, getWsUrl, apiFetch, refreshAccessToken } from '../lib/api';
import {
  isFullRepaintDropAgent,
  dropFullRepaintPrefix,
  FULL_REPAINT_DROP_MIN_KEEP_BYTES,
} from '../lib/terminalFrameDrop';
import { useTerminalTheme } from '../hooks/useTerminalTheme.jsx';
import { Loader2 } from 'lucide-react';
import {
  createTerminalReconnectState,
  isTerminalAuthFailure,
  refreshTokenForTerminalFailure,
} from '../../../shared/terminalReconnect.mjs';

const FALLBACK_XTERM_THEME = {
  background: '#09090b',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  cursorAccent: '#09090b',
  selectionBackground: '#3f3f46',
  selectionForeground: '#fafafa',
  black: '#18181b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#f4f4f5',
};

function stripAlternateScreen(text) {
  return text
    .replace(/\x1b\[\?1049h/g, '')
    .replace(/\x1b\[\?1049l/g, '')
    .replace(/\x1b\[\?47h/g, '')
    .replace(/\x1b\[\?47l/g, '')
    .replace(/\x1b\[\?1047h/g, '')
    .replace(/\x1b\[\?1047l/g, '')
    .replace(/\x1b\[\?1000h/g, '')
    .replace(/\x1b\[\?1000l/g, '')
    .replace(/\x1b\[\?1002h/g, '')
    .replace(/\x1b\[\?1002l/g, '')
    .replace(/\x1b\[\?1003h/g, '')
    .replace(/\x1b\[\?1003l/g, '')
    .replace(/\x1b\[\?1004h/g, '')
    .replace(/\x1b\[\?1004l/g, '')
    .replace(/\x1b\[\?1005h/g, '')
    .replace(/\x1b\[\?1005l/g, '')
    .replace(/\x1b\[\?1006h/g, '')
    .replace(/\x1b\[\?1006l/g, '')
    .replace(/\x1b\[\?1015h/g, '')
    .replace(/\x1b\[\?1015l/g, '');
}

// East-Asian Wide / Fullwidth BMP 区段——这些字形在终端占 2 个单元格。
// vsScreen 是按"单元格"建模的行缓冲：宽字符存储为 `char + '\u0000'`
// （第二格占位符），光标推进 2 列，保证模型列号与终端真实列一致。
// 之前按 JS 字符数推进导致含中文的行（如 qwen 技能表格）列号漂移，
// 差分误判"该行未变"跳过重写，旧帧字符残留在屏幕上。
// Astral 平面字符（代理对 = 2 个 JS 字符）天然占 2 格，无需特殊处理。
function isWideCharCode(code) {
  return (
    (code >= 0x1100 && code <= 0x115F) // Hangul Jamo
    || (code >= 0x2E80 && code <= 0x303E) // CJK Radicals .. CJK Symbols
    || (code >= 0x3041 && code <= 0x9FFF) // Hiragana .. CJK Unified
    || (code >= 0xA000 && code <= 0xA4CF) // Yi / Vai
    || (code >= 0xAC00 && code <= 0xD7A3) // Hangul Syllables
    || (code >= 0xF900 && code <= 0xFAFF) // CJK Compatibility Ideographs
    || (code >= 0xFE30 && code <= 0xFE4F) // CJK Compatibility Forms
    || (code >= 0xFF00 && code <= 0xFF60) // Fullwidth Forms
    || (code >= 0xFFE0 && code <= 0xFFE6) // Fullwidth Signs
  );
}

function parseMessage(raw) {
  if (typeof raw === 'string') return JSON.parse(raw);
  return JSON.parse(raw.toString());
}

function getArrowSequence(key, applicationCursorKeys) {
  const prefix = applicationCursorKeys ? '\x1bO' : '\x1b[';
  switch (key) {
    case 'ArrowUp':
      return `${prefix}A`;
    case 'ArrowDown':
      return `${prefix}B`;
    case 'ArrowRight':
      return `${prefix}C`;
    case 'ArrowLeft':
      return `${prefix}D`;
    default:
      return null;
  }
}

function getCachedSeq(sessionId) {
  try {
    const v = sessionStorage.getItem(`xe_term_seq_${sessionId}`);
    return v ? Number(v) || 0 : 0;
  } catch { return 0; }
}

function setCachedSeq(sessionId, seq) {
  try {
    if (seq != null && seq > 0) sessionStorage.setItem(`xe_term_seq_${sessionId}`, String(seq));
  } catch { /* ignore */ }
}

// 客户端写入积压上限：超过即放弃失步数据、走锚点重放自愈。必须大于服务端
// delta/锚点重放上限（4MB），保证一次有界重放不会反过来触发自愈循环。
const MAX_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;

function AgentConsole({
  sessionId,
  agentId,
  reconnectVersion = 0,
  onSessionEnd,
  onSessionConnected,
  sessionLive = true,
  sessionWakeable = false,
}) {
  const { t } = useTranslation();
  const { preset } = useTerminalTheme();
  // 全屏重绘型 TUI（qwen-code）：积压超阈值时按「满整屏重绘帧」锚点裁剪。
  // 其他 agent 为 false → 完全走原有字节透明管线，行为不变。
  const fullRepaintDrop = isFullRepaintDropAgent(agentId);
  const xtermTheme = {
    ...(preset?.xterm || FALLBACK_XTERM_THEME),
    // xterm 6 滚动条颜色（Monaco 风格自绘滚动条）：中性半透明灰，深浅主题下都协调；
    // 尺寸/圆角由 index.css 统一定制（overlay 细条风格）
    scrollbarSliderBackground: 'rgba(113, 113, 122, 0.35)',
    scrollbarSliderHoverBackground: 'rgba(113, 113, 122, 0.6)',
    scrollbarSliderActiveBackground: 'rgba(113, 113, 122, 0.75)',
  };

  const hostRef = useRef(null);
  const overlayRef = useRef(null);
  const terminalRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);
  const onSessionEndRef = useRef(onSessionEnd);
  const onSessionConnectedRef = useRef(onSessionConnected);
  const connectedRef = useRef(false);
  const firstConnectRef = useRef(true);
  // 自愈重同步标记：客户端写入积压超限时置位，下次 connect 用 after=0 走
  // 锚点重放（有界），丢弃与实时流之间已经失步的增量。配合服务端的
  // 拥塞自杀 + delta 封顶，把卡死变成 ≤30s 的无感自愈。
  const resyncRef = useRef(false);

  const replayDoneRef = useRef(true);
  const shouldConnect = sessionLive;
  const shouldReplayIdle = sessionWakeable && !sessionLive;
  // eslint-disable-next-line no-unused-vars
  const [connected, setConnected] = useState(false);
  // eslint-disable-next-line no-unused-vars
  const [ended, setEnded] = useState(!shouldConnect && !shouldReplayIdle);
  // First-use guide card: shown only for a fresh live session with no output yet.
  const [guideVisible, setGuideVisible] = useState(false);
  const guideVisibleRef = useRef(guideVisible);
  guideVisibleRef.current = guideVisible;

  const dismissGuide = useCallback(() => {
    if (guideVisibleRef.current) setGuideVisible(false);
  }, []);

  const sendInput = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
    }
  }, []);

  useEffect(() => {
    onSessionEndRef.current = onSessionEnd;
  }, [onSessionEnd]);

  useEffect(() => {
    onSessionConnectedRef.current = onSessionConnected;
  }, [onSessionConnected]);

  useEffect(() => {
    setEnded(!shouldConnect && !shouldReplayIdle);
  }, [shouldConnect, shouldReplayIdle]);

  useEffect(() => {
    firstConnectRef.current = true;
    resyncRef.current = false;
    const host = hostRef.current;
    if (!host) return undefined;

    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 120,
      rows: 32,
      scrollback: 10000,
      convertEol: true,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      drawBoldTextInBrightColors: true,
      theme: xtermTheme,
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';
    host.replaceChildren();
    terminal.open(host);
 // opencode TUI writes the clipboard via the OSC 52 escape sequence
 // (ESC ] 52 ; c ; <base64> BEL). xterm.js 5.5.0 has no built-in OSC 52
 // write handler, so without this the agent prints "copied to clipboard"
 // but the browser clipboard is never written. Register a handler that
 // decodes the payload and writes it to the real clipboard.
 // SECURITY: only the write direction (selector c/p) is handled; the read
 // query ("?" selector) is explicitly ignored so the agent cannot exfiltrate
 // the user's clipboard.
 terminal.parser.registerOscHandler(52, (data) => {
 const semicolon = data.indexOf(';');
 if (semicolon < 0) return true;
 const selector = data.slice(0, semicolon);
 if (selector.indexOf('?') !== -1) return true; // read query - ignore
 const payload = data.slice(semicolon + 1);
 if (!payload) return true;
 try {
   const binary = atob(payload);
   const text = new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
   if (navigator.clipboard && navigator.clipboard.writeText) {
     navigator.clipboard.writeText(text).catch(() => {});
   } else {
     const textarea = document.createElement('textarea');
     textarea.value = text;
     textarea.style.position = 'fixed';
     textarea.style.top = '-999px';
     textarea.style.left = '-999px';
     document.body.appendChild(textarea);
     textarea.select();
     try { document.execCommand('copy'); } catch (_) {}
     document.body.removeChild(textarea);
   }
 } catch (_) {}
 return true;
 });
    try { fitAddon.fit(); } catch (_) {}
    // Re-fit after flex layout settles; the first fit() may run when
    // the host element has partial width (before layout completes).
    setTimeout(() => { if (!disposed) { try { fitAddon.fit(); } catch (_) {} } }, 150);
    setTimeout(() => { if (!disposed) { try { fitAddon.fit(); } catch (_) {} } }, 500);
    setTimeout(() => { if (!disposed) { try { fitAddon.fit(); } catch (_) {} } }, 1500);
    // WebGL renderer is disabled: on context loss xterm.js disposes the
    // addon but does NOT fall back to the Canvas2D renderer, leaving the
    // terminal with no renderer at all (blank screen).  The Canvas2D
    // renderer is slightly slower but reliable across all GPU/driver
    // combinations and does not suffer from context-loss dead-ends.
    terminalRef.current = terminal;

    let overlayTimer = null;
    const showOverlay = () => {
      if (hostRef.current) hostRef.current.style.opacity = '0';
      if (overlayRef.current) overlayRef.current.style.display = 'flex';
      overlayTimer = setTimeout(() => { hideOverlay(); }, 5000);
    };
    const hideOverlay = () => {
      if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
      if (disposed) return;
      if (hostRef.current) hostRef.current.style.opacity = '1';
      if (overlayRef.current) overlayRef.current.style.display = 'none';
      try { terminal.scrollToBottom(); } catch (_) {}
      try { if (!serverEnded) terminal.focus(); } catch (_) {}
    };

    let disposed = false;
    let serverEnded = false;
    let reconnectTimer = null;
    let lastSentCols = 0;
    let lastSentRows = 0;
    let writeRafId = null;
    const resizeTimers = [];

    // Virtual screen for ANSI diff: declared at useEffect scope so fitTerminal
    // (outside connect) can resize vsScreen/vsRows on terminal resize, and
    // vsProcess (inside connect) can read/update them.
    let vsScreen = [];
    let vsCursorY = 0;
    let vsRows = terminal.rows || 32;
    for (let y = 0; y < vsRows; y++) vsScreen[y] = '';

    const sendResize = (cols, rows) => {
      if (cols > 0 && rows > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    };

    const fitTerminal = (force = false) => {
      fitAddon.fit();
      const cols = terminal.cols || 0;
      const rows = terminal.rows || 0;
      if (cols <= 0 || rows <= 0) return;
      // Update virtual screen dimensions when terminal is resized
      if (rows !== vsRows) {
        vsRows = rows;
        if (vsScreen.length < vsRows) {
          for (let y = vsScreen.length; y < vsRows; y++) vsScreen[y] = '';
        } else if (vsScreen.length > vsRows) {
          vsScreen.length = vsRows;
        }
      }
      const changed = cols !== lastSentCols || rows !== lastSentRows;
      if (!changed && !force) return;
      lastSentCols = cols;
      lastSentRows = rows;
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      sendResize(cols, rows);
    };

    // After the terminal (re)connects, opencode's TUI boots inside the sandbox
    // slightly later than the WS open event; resend the size a few times so it
    // initializes at the correct dimensions instead of the backend default.
    const scheduleResizeResends = () => {
      [150, 500, 1200].forEach((delay) => {
        const t = setTimeout(() => {
          if (!disposed) fitTerminal(true);
        }, delay);
        resizeTimers.push(t);
      });
    };

    const copyToClipboard = (text) => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(textarea);
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;

      const isCopyShortcut = (event.ctrlKey && event.shiftKey && (event.key === 'C' || event.key === 'c'))
        || (event.metaKey && !event.ctrlKey && (event.key === 'c' || event.key === 'C'));
      if (isCopyShortcut) {
        const selection = terminal.getSelection();
        if (selection) {
          event.preventDefault();
          copyToClipboard(selection);
          terminal.clearSelection();
          return false;
        }
      }

      const sequence = getArrowSequence(event.key, terminal.modes.applicationCursorKeysMode);
      if (!sequence) return true;
      if (event.metaKey || event.ctrlKey || event.altKey) return true;
      if (serverEnded) return false;
      event.preventDefault();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data: sequence }));
      }
      return false;
    });

    terminal.onData((data) => {
      if (disposed || serverEnded) return;
      if (!replayDoneRef.current) return;
      dismissGuide();
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
    });

    const handleContextMenu = (e) => {
      e.preventDefault();
      const selection = terminal.getSelection();
      if (selection) {
        copyToClipboard(selection);
        terminal.clearSelection();
      }
    };

    const focusTerminal = () => {
      if (!serverEnded) terminal.focus();
    };
    host.addEventListener('mousedown', focusTerminal);
    host.addEventListener('click', focusTerminal);
    host.addEventListener('contextmenu', handleContextMenu);

    let lastHostWidth = 0;
    let lastHostHeight = 0;
    let resizeDebounce = null;
    // 宽度稳定检测：面板收起/展开有 width 过渡（约 150ms），期间容器宽度持续变化。
    // 若每次变化都触发 fit → 向 PTY 发送 resize → TUI 应用清屏重绘，会造成闪烁。
    // 因此：过渡期间每次 RO 触发都重置定时器并清空 pending（不 fit）；
    // 宽度稳定后第一次测量记下 pending，延迟再测一次，尺寸一致才 fit —— 整个过渡只重绘一次。
    let pendingW = 0;
    let pendingH = 0;
    const checkResizeStable = () => {
      if (disposed) return;
      const rect = host.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w <= 0 || h <= 0) {
        pendingW = 0;
        pendingH = 0;
        return;
      }
      if (pendingW === w && pendingH === h) {
        pendingW = 0;
        pendingH = 0;
        if (Math.abs(w - lastHostWidth) <= 2 && Math.abs(h - lastHostHeight) <= 2) return;
        lastHostWidth = w;
        lastHostHeight = h;
        fitTerminal();
      } else {
        pendingW = w;
        pendingH = h;
        resizeDebounce = setTimeout(checkResizeStable, 120);
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      if (resizeDebounce) clearTimeout(resizeDebounce);
      pendingW = 0;
      pendingH = 0;
      resizeDebounce = setTimeout(checkResizeStable, 100);
    });
    resizeObserver.observe(host);

    if (!sessionId || (!shouldConnect && !shouldReplayIdle)) {
      terminal.write(`\r\n\x1b[33m${t('sessions:terminal.system_prefix')} ${t('sessions:terminal.not_running')}\x1b[0m\r\n`);
      setEnded(true);
    } else if (shouldReplayIdle) {
      (async () => {
        showOverlay();
        try {
          const response = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || t('sessions:error.load_history_failed', { defaultValue: 'Failed to load session history' }));
          if (data.head != null && data.head > 0) setCachedSeq(sessionId, data.head);
          const systemMsg = `\r\n\x1b[33m${t('sessions:terminal.system_prefix')} ${t('sessions:terminal.paused')}\x1b[0m\r\n`;
          // Use terminal.write callback to hide overlay only AFTER xterm.js
          // has fully processed the transcript data. xterm.js processes write
          // data asynchronously in setTimeout(0) chunks; without the callback,
          // the terminal becomes visible mid-processing, showing intermediate
          // rendering states (e.g. un-cleared TUI spinner frames).
          const finishReplay = () => {
            hideOverlay();
            setEnded(true);
          };
          if (data.output) {
            // Idle replay uses the raw transcript, which may contain alt-screen
            // and mouse-tracking sequences from a previous live TUI session.
            // Keeping them would leave xterm.js in the alternate buffer, where
            // scrollToBottom is a no-op and modal dialogs appear mis-aligned.
            // Strip them so the paused session renders in the primary buffer.
            const replayOutput = stripAlternateScreen(data.output);
            terminal.write(replayOutput, () => {
              terminal.write(systemMsg, finishReplay);
            });
          } else {
            terminal.write(systemMsg, finishReplay);
          }
        } catch (error) {
          if (!disposed) {
            terminal.write(`\r\n\x1b[31m${t('sessions:terminal.system_prefix')} ${error?.message || t('sessions:terminal.load_history_failed')}\x1b[0m\r\n`);
            hideOverlay();
            setEnded(true);
          }
        }
      })();
    } else {
      const reconnectState = createTerminalReconnectState();
      const MAX_RECONNECTS = 20;

      const scheduleReconnect = (reason) => {
        if (disposed || serverEnded) return;
        const next = reconnectState.nextReconnect();
        if (next.exhausted) {
          terminal.write(`\r\n\x1b[31m${t('sessions:terminal.system_prefix')} ${t('sessions:terminal.restore_failed', { reason: reason ? ` (${reason})` : '' })}\x1b[0m\r\n`);
          setEnded(true);
          return;
        }
        terminal.write(`\r\n\x1b[33m${t('sessions:terminal.system_prefix')} ${t('sessions:terminal.reconnecting', { attempt: next.attempt, max: MAX_RECONNECTS })}\x1b[0m\r\n`);
        setConnected(false);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!disposed) connect();
        }, next.delayMs);
      };

      var connect = async () => {
        try {
          if (reconnectState.snapshot().attempts === 0) showOverlay();
          // On first connect (session switch/initial load), use after=0 to get
          // the tail replay. On reconnect (WS drop), use cached seq for delta.
          const isFirstConnect = firstConnectRef.current;
          firstConnectRef.current = false;
          // 自愈重同步（resyncRef）或首次连接都用 after=0：服务端会做锚点
          // 重放（最近完整重绘 → EOF，有界），终端直接落在最新画面。
          const cachedSeq = (isFirstConnect || resyncRef.current) ? 0 : getCachedSeq(sessionId);
          resyncRef.current = false;
          const ws = new WebSocket(getWsUrl(sessionId, getAccessToken(), cachedSeq));
          wsRef.current = ws;
          let failureHandled = false;
          let authenticated = false;
          let replayDone = false;
          replayDoneRef.current = false;
          let writeBuffer = '';
          let pendingSeq = null;
          // 裁剪日志只打一次（每个连接），避免高频裁剪刷屏。
          let fullRepaintDropLogged = false;
          // Number of terminal.write() calls not yet rendered by xterm. Used as
          // backpressure: when xterm is slower than the WS output rate, the
          // pending count grows; we then delay the next flush so the terminal
          // can drain its internal parse/render queue instead of unboundedly
          // accumulating (which froze the UI thread under sustained high
          // throughput, e.g. qwen streaming). timer semantics stay
          // "if (writeRafId === null)" (no clear+restart) so a steady stream
          // never reschedules forever without flushing.
          let pendingWrites = 0;
          // Track whether the terminal is currently in alternate screen mode.
          // Initialized from xterm.js's actual buffer state (handles idle replay
          // that may have left the terminal in alt screen).
          let inAltScreen = terminal.buffer.active === terminal.buffer.alternate;

          // vsScreen, vsCursorY, vsRows are declared at useEffect scope so
          // fitTerminal can resize them on terminal resize.

          // Buffer for incomplete sync-term (DECSET 2026) blocks.  Pi and
          // qwen-code wrap UI redraws in \x1b[?2026h ... \x1b[?2026l.  xterm.js
          // 5.x ignores these sequences, so vsProcess must see the *entire*
          // block (cursor-up at the start) to do row-level diffing.  When the
          // server's 33ms flush splits a block across WS messages, the second
          // fragment has no cursor-up and falls through to passthrough, causing
          // content to be appended as new lines instead of overwriting.
          let syncTermPending = '';

          function vsStripAnsi(text) {
            const bare = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\].*?\x07/g, '');
            // 展开宽字符到单元格空间（char + 占位符），使字符串与终端列
            // 一一对齐，才能和 vsScreen（单元格模型）正确比较。
            let out = '';
            for (const ch of bare) {
              out += ch;
              if (isWideCharCode(ch.charCodeAt(0))) out += '\u0000';
            }
            return out;
          }

          function vsProcess(data) {
            const hasClear = /\x1b\[2J/.test(data);
            if (hasClear) {
              for (let y = 0; y < vsRows; y++) vsScreen[y] = '';
            }
            // Skip leading DEC private mode sequences (e.g. \x1b[?25l, \x1b[?2026h)
            // and OSC sequences before looking for cursor-up pattern.
            let dataOffset = 0;
            while (dataOffset < data.length) {
              if (data[dataOffset] === '\x1b' && data[dataOffset + 1] === '[' && data[dataOffset + 2] === '?') {
                let j = dataOffset + 3;
                while (j < data.length && !/[A-Za-z]/.test(data[j])) j++;
                dataOffset = j + 1;
              } else if (data[dataOffset] === '\x1b' && data[dataOffset + 1] === ']') {
                const e = data.indexOf('\x07', dataOffset + 2);
                dataOffset = e >= 0 ? e + 1 : data.length;
              } else {
                break;
              }
            }
            const cursorUpMatch = data.slice(dataOffset).match(/^\x1b\[(\d+)A/);
            if (!cursorUpMatch) {
              let i = 0, cx = 0, cy = vsCursorY;
              while (i < data.length) {
                if (data[i] === '\x1b') {
                  if (data[i + 1] === '[') {
                    let j = i + 2;
                    while (j < data.length && !/[A-Za-z]/.test(data[j])) j++;
                    const p = data.slice(i + 2, j), f = data[j], n = parseInt(p) || 1;
                    if (f === 'A') cy = Math.max(0, cy - n);
                    else if (f === 'B') cy = Math.min(vsRows - 1, cy + n);
                    else if (f === 'G') cx = Math.max(0, n - 1);
                    else if (f === 'C') cx = Math.min(terminal.cols - 1, cx + n);
                    else if (f === 'D') cx = Math.max(0, cx - n);
                    else if (f === 'H') { const s = p.split(';'); cy = Math.max(0, (parseInt(s[0]) || 1) - 1); cx = Math.max(0, (parseInt(s[1]) || 1) - 1); }
                    else if (f === 'J' && n === 2) for (let y = 0; y < vsRows; y++) vsScreen[y] = '';
                    else if (f === 'K' && (n === 2 || !p)) vsScreen[cy] = '';
                    else if (f === 'd') cy = Math.max(0, n - 1);
                    i = j + 1;
                  } else if (data[i + 1] === 'h' || data[i + 1] === 'l') { i += 2; }
                  else if (data[i + 1] === ']') { const e = data.indexOf('\x07', i + 2); i = e >= 0 ? e + 1 : data.length; }
                  else i++;
                } else if (data[i] === '\r' && data[i + 1] === '\n') { cy++; cx = 0; i += 2; }
                else if (data[i] === '\r') { cx = 0; i++; }
                else if (data[i] === '\n') { cy++; i++; }
                else if (data[i] >= ' ') {
                  const wide = isWideCharCode(data.charCodeAt(i));
                  if (cy >= 0 && cy < vsRows && cx < terminal.cols) {
                    const r = vsScreen[cy] || '';
                    if (wide) {
                      // 宽字符占 2 格：char + 占位符，列号推进 2。
                      vsScreen[cy] = r.substring(0, cx) + data[i] + '\u0000' + r.substring(cx + 2);
                    } else {
                      vsScreen[cy] = r.substring(0, cx) + data[i] + r.substring(cx + 1);
                    }
                  }
                  cx += wide ? 2 : 1;
                  i++;
                } else i++;
              }
              vsCursorY = cy;
              return data;
            }
            const upCount = parseInt(cursorUpMatch[1]);
            let startRow = Math.max(0, vsCursorY - upCount);
            const prefix = data.slice(0, dataOffset + cursorUpMatch[0].length);
            const rest = data.slice(dataOffset + cursorUpMatch[0].length);
            // Detect cursor-down usage.  There are two distinct cases:
            //  1. "qwen-style" full-screen redraw: \x1b[<n>A + repeated
            //     \x1b[2K<content>\x1b[1B ... — each \x1b[1B simply advances
            //     one row down while redrawing the whole screen (TUI agents
            //     like qwen redraw every line this way).  Here \x1b[1B is a
            //     row separator, safe to diff against vsScreen.
            //  2. "codebuddy-style" cursor jump (spinner): \x1b[6A\x1b[2K
            //     <spinner>\x1b[6B — the cursor jumps DOWN by 6 after the
            //     update; vsCursorY cannot track that, so raw passthrough is
            //     required (otherwise spinner frames accumulate instead of
            //     overwriting).
            // Distinguish by counting: case 1 uses \x1b[1B exactly once per
            // \x1b[2K line (interleaved redraw), case 2 uses a single \x1b[nB
            // (n>1 or a lone cursor jump) after the update.  Treat repeated
            // \x1b[2K...\x1b[1B pairs as a row-by-row redraw; anything else
            // with a cursor-down keeps the old raw passthrough.
            const downJumps = rest.match(/\x1b\[(\d*)B/g) || [];
            const isRowRedraw = downJumps.length > 1
              && downJumps.every((j) => j === '\x1b[1B')
              && (rest.match(/\x1b\[2K/g) || []).length >= downJumps.length;
            if (downJumps.length > 0 && !isRowRedraw) {
              return data;
            }
            // Split rows on \x1b[2K, stripping a trailing \x1b[1B separator
            // from each row so the raw content is clean for the vsScreen diff.
            const segments = rest.split(/\x1b\[2K/).slice(1);
            if (!segments || segments.length === 0) {
              vsCursorY = startRow;
              return data;
            }
            let output = prefix;
            let currentRow = startRow;
            let anyChanged = false;
            for (const seg of segments) {
              if (currentRow >= vsRows) break;
              const raw = seg.replace(/\x1b\[1B$/, '').replace(/\x1b\[1B(?=\x1b\[2K)/, '');
              const plain = vsStripAnsi(raw);
              if (vsScreen[currentRow] !== plain) {
                output += `\x1b[${currentRow + 1};1H\x1b[2K${raw}\r\n`;
                vsScreen[currentRow] = plain;
                anyChanged = true;
              }
              currentRow++;
            }
            vsCursorY = currentRow - 1;
            return anyChanged ? output : prefix + '\x1b[H';
          }

          // Fallback: hide overlay after 5s even if no output was received
          // (e.g. empty replay with after=cachedSeq and no new frames)
          const overlayFallbackTimer = setTimeout(() => {
            if (!replayDone && !disposed) {
              replayDone = true;
              replayDoneRef.current = true;
              hideOverlay();
            }
          }, 5000);

          // Process primary-buffer data through sync-term handling + vsProcess.
          // Returns { output, hasOutput }.
          function processPrimaryBuffer(data) {
            let output = '';
            let hasOutput = false;
            let remaining = data;

            while (remaining.length > 0) {
              const syncStart = remaining.indexOf('\x1b[?2026h');
              if (syncStart === -1) {
                output += vsProcess(remaining);
                hasOutput = true;
                break;
              }
              if (syncStart > 0) {
                output += vsProcess(remaining.slice(0, syncStart));
                hasOutput = true;
              }
              const syncEnd = remaining.indexOf('\x1b[?2026l', syncStart);
              if (syncEnd === -1) {
                syncTermPending = remaining.slice(syncStart);
                break;
              }
              const blockContent = remaining.slice(
                syncStart + '\x1b[?2026h'.length, syncEnd,
              );
              const stripped = blockContent.includes('\x1b[2K')
                ? blockContent.replace(/\x1b\[2J/g, '')
                : blockContent;
              if (stripped) {
                output += stripped;
                hasOutput = true;
              }
              remaining = remaining.slice(syncEnd + '\x1b[?2026l'.length);
            }

            return { output, hasOutput };
          }

          const flushWriteBuffer = () => {
            writeRafId = null;
            if (pendingSeq != null) {
              setCachedSeq(sessionId, pendingSeq);
              pendingSeq = null;
            }

            let remaining = syncTermPending + (writeBuffer || '');
            syncTermPending = '';
            writeBuffer = '';

            // 全屏重绘型 TUI（qwen-code）专用积压裁剪：超阈值时丢弃最旧前缀，
            // 切点落在「满整屏重绘帧」的**起始**处并保留该锚点帧——锚点帧重画
            // 整屏，被丢弃的更早帧在屏幕上被其完全覆盖。其他 agent 不进入此分支。
            // 仅在 primary buffer 生效（alt screen 的 TUI 靠自身增量重绘，
            // 不适用整屏覆盖语义）。
            if (fullRepaintDrop && !inAltScreen && remaining.length > FULL_REPAINT_DROP_MIN_KEEP_BYTES) {
              const trimmed = dropFullRepaintPrefix(remaining, { rows: terminal.rows });
              if (trimmed.droppedBytes > 0) {
                remaining = trimmed.data;
                if (!fullRepaintDropLogged) {
                  fullRepaintDropLogged = true;
                  console.warn(`[AgentConsole] full-repaint backlog trimmed (dropped ${trimmed.droppedBytes} bytes, agent=${agentId})`);
                }
              }
            }

            // Detect alt screen transitions in this chunk.
            // When entering alt screen: process pre-transition content with
            // vsProcess (primary buffer), then pass the transition sequence +
            // everything after it raw to xterm.js (native TUI rendering).
            // When exiting alt screen: pass content + exit sequence raw,
            // then process post-transition content with vsProcess.
            // While in alt screen: pass everything raw (no linearization,
            // no sync-term stripping — the TUI handles its own rendering).
            const altEnterIdx = remaining.search(/\x1b\[\?(?:1049|47|1047)h/);
            const altExitIdx = remaining.search(/\x1b\[\?(?:1049|47|1047)l/);

            if (!inAltScreen && altEnterIdx >= 0) {
              const match = remaining.match(/\x1b\[\?(?:1049|47|1047)h/);
              const before = remaining.slice(0, altEnterIdx);
              const transitionAndAfter = remaining.slice(altEnterIdx);
              inAltScreen = true;
              let output = '';
              let hasOutput = false;
              if (before) {
                const result = processPrimaryBuffer(before);
                output += result.output;
                hasOutput = result.hasOutput;
              }
              // Hide xterm.js native cursor in alt screen: the TUI
              // renders its own cursor inside sync-term blocks. Keeping
              // the native cursor visible causes a double-cursor (one
              // from xterm.js at the last ANSI cursor position, one from
              // the TUI at the input box). The TUI will re-enable the
              // cursor with \x1b[?25h when it's ready for input.
              output += transitionAndAfter + '\x1b[?25l';
              hasOutput = true;
              if (hasOutput) writeTerminalData(output);
              return;
            }

            if (inAltScreen && altExitIdx >= 0) {
              const match = remaining.match(/\x1b\[\?(?:1049|47|1047)l/);
              const exitEnd = altExitIdx + match[0].length;
              const beforeAndExit = remaining.slice(0, exitEnd);
              const after = remaining.slice(exitEnd);
              inAltScreen = false;
              let output = beforeAndExit;
              if (after) {
                const result = processPrimaryBuffer(after);
                output += result.output;
              }
              writeTerminalData(output);
              return;
            }

            if (inAltScreen) {
              // In alt screen mode, write all data directly to terminal.
              // The previous sync-term buffering caused data loss when
              // WebSocket messages split sync-term blocks across reconnects:
              // incomplete blocks were stuck in syncTermPending and lost
              // when a new connect() created a fresh syncTermPending.
              if (syncTermPending) {
                writeTerminalData(syncTermPending + remaining);
                syncTermPending = '';
              } else {
                writeTerminalData(remaining);
              }
              return;
            }

            // In primary buffer: process with vsProcess + sync-term
            const result = processPrimaryBuffer(remaining);
            if (result.hasOutput) writeTerminalData(result.output);
          };

          function writeTerminalData(processed) {
            if (processed.trim()) dismissGuide();
            const buf = terminal.buffer.active;
            const atBottom = buf.baseY + terminal.rows >= buf.length;
            pendingWrites++;
            terminal.write(processed, () => {
              pendingWrites = Math.max(0, pendingWrites - 1);
              if (!replayDone && !disposed) { replayDone = true; replayDoneRef.current = true; hideOverlay(); }
              if (atBottom && !disposed) terminal.scrollToBottom();
            });
          }

          const markAuthenticated = () => {
            if (authenticated || disposed || wsRef.current !== ws) return;
            authenticated = true;
            reconnectState.authenticationSucceeded();
            connectedRef.current = true;
            setConnected(true);
            setEnded(false);
            onSessionConnectedRef.current?.(sessionId);
            try { if (!serverEnded) terminal.focus(); } catch (_) {}
          };

          const handleConnectionFailure = async (reason, failure = {}) => {
            if (failureHandled || disposed || serverEnded || wsRef.current !== ws) return;
            failureHandled = true;
            connectedRef.current = false;
            await refreshTokenForTerminalFailure(failure, refreshAccessToken);
            if (!disposed && !serverEnded && wsRef.current === ws) {
              scheduleReconnect(reason);
            }
          };

          ws.onopen = () => {
            if (disposed) return;
            reconnectState.socketOpened();
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (!disposed) fitTerminal(true);
              });
            });
            scheduleResizeResends();
          };

          ws.onmessage = (event) => {
            if (disposed) return;
            const msg = parseMessage(event.data);
            if (msg.type === 'ready') {
              markAuthenticated();
              // The TUI (e.g. opencode) boots inside the sandbox slightly
              // after the session handle becomes alive; resend the fitted
              // size so it initializes at the right dimensions even when the
              // WS opened while the session was still provisioning.
              scheduleResizeResends();
              return;
            }
            if (msg.type === 'output') {
              if (msg.seq != null) pendingSeq = msg.seq;
              writeBuffer += msg.data;
              // 积压封顶自愈：渲染跟不上时 writeBuffer 无界增长会把主线程
              // 拖死（页面冻结的触发层）。超限即放弃这批已失步的数据——
              // 置 resync 标记并断开，重连走 after=0 锚点重放（服务端有界，
              // 4MB），终端直接恢复到最新画面。线程冻结期间本检查不会执行，
              // 那种情况由服务端拥塞自杀（WS_CONGEST_KILL_MS）兜底。
              if (writeBuffer.length > MAX_WRITE_BUFFER_BYTES) {
                writeBuffer = '';
                if (!resyncRef.current) {
                  resyncRef.current = true;
                  console.warn(`[AgentConsole] write buffer overflow (> ${MAX_WRITE_BUFFER_BYTES} bytes), resyncing via anchored replay`);
                  try { ws.close(); } catch { /* ignore */ }
                }
                return;
              }
              if (writeRafId === null) {
                // Backpressure: lengthen the flush interval when xterm is
                // still rendering earlier writes (pendingWrites > 0), giving
                // it time to drain. Never clear+restart an active timer.
                const delay = pendingWrites > 4 ? 64 : pendingWrites > 1 ? 32 : 16;
                writeRafId = setTimeout(flushWriteBuffer, delay);
              }
              return;
            }
            if (msg.type === 'error') {
              if (writeRafId !== null) { clearTimeout(writeRafId); writeRafId = null; }
              flushWriteBuffer();
              hideOverlay();
              connectedRef.current = false;
              const failure = { message: msg.data };
              void handleConnectionFailure(msg.data || 'error', failure);
              try { ws.close(); } catch { /* ignore */ }
              return;
            }
            if (msg.type === 'exit') {
              if (writeRafId !== null) { clearTimeout(writeRafId); writeRafId = null; }
              flushWriteBuffer();
              hideOverlay();
              if (msg.message) terminal.write(msg.message);
              serverEnded = true;
              setEnded(true);
              onSessionEndRef.current?.(sessionId);
              ws.close();
            }
          };

          ws.onerror = () => {
            if (disposed || serverEnded) return;
            connectedRef.current = false;
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close();
            }
          };

          ws.onclose = (event) => {
            clearTimeout(overlayFallbackTimer);
            if (disposed || serverEnded) return;
            hideOverlay();
            const wasConnected = connectedRef.current;
            connectedRef.current = false;
            const failure = { code: event.code, reason: event.reason };
            if (isTerminalAuthFailure(failure)) {
              void handleConnectionFailure(event.reason || 'Invalid access token', failure);
              return;
            }
            if (event.wasClean && event.code === 1000) return;
            void handleConnectionFailure(wasConnected ? 'disconnected' : 'connection failed', failure);
          };
        } catch (error) {
          if (!disposed) {
            scheduleReconnect(error?.message || 'connect error');
          }
        }
      };
      connect();
    }

    const applySize = () => {
      if (disposed) return;
      fitTerminal();
    };
    requestAnimationFrame(applySize);

    return () => {
      disposed = true;
      if (writeRafId !== null) { clearTimeout(writeRafId); }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resizeTimers.forEach((t) => clearTimeout(t));
      if (resizeDebounce) clearTimeout(resizeDebounce);
      resizeObserver.disconnect();
      host.removeEventListener('mousedown', focusTerminal);
      host.removeEventListener('click', focusTerminal);
      host.removeEventListener('contextmenu', handleContextMenu);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      connectedRef.current = false;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, reconnectVersion]);

  // 主题热更新：应用切换深色/浅色时 Provider 会切到对应外观的终端主题，
  // 终端实例已存在，直接更新 options.theme（xterm 会即时重渲染配色），
  // 无需重建终端或刷新页面。创建 effect 依赖不含主题，避免切主题重建终端。
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    try { terminal.options.theme = xtermTheme; } catch (_) { /* ignore */ }
  }, [xtermTheme]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-transparent">
      <div
        ref={overlayRef}
        className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-900/90 backdrop-blur-sm"
        style={{ display: 'none' }}
      >
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common:state.loading', { defaultValue: 'Loading…' })}
        </div>
      </div>
      {/* xterm v6 遗留结构：.xterm-viewport 硬编码 background-color:#000
          （见 xterm.css "scroll bar fully opaque" 注释），且 v6 不再用主题色
          覆盖它。.xterm-scrollable-element（白色，随主题）高度跟随 screen
          自然高度（rows×cellHeight），比容器最多矮一行，缝隙处黑色 viewport
          就会露出来——表现为终端底部一条黑条。置为透明，露出容器的主题背景。 */}
      <style>{`.xterm{width:100%!important;height:100%!important}.xterm-screen{width:100%!important;height:100%!important}.xterm-viewport{width:100%!important;height:100%!important;background-color:transparent!important}`}</style>
      <div ref={hostRef} className="min-h-0 w-full flex-1" />
      {guideVisible && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6">
          <div className="pointer-events-auto w-full max-w-md rounded-xl border border-zinc-700/60 bg-zinc-900/95 p-5 shadow-2xl backdrop-blur">
            <p className="text-sm font-semibold text-zinc-100">{t('sessions:guide.title')}</p>
            <p className="mt-1 text-xs text-zinc-400">
              {t('sessions:guide.subtitle', { defaultValue: 'Type a task in natural language, or pick an example to get started.' })}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {[
                t('sessions:guide.prompt_1'),
                t('sessions:guide.prompt_2', { defaultValue: 'Explain the structure of this project' }),
                t('sessions:guide.prompt_3'),
              ].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => { sendInput(`${prompt}\n`); dismissGuide(); }}
                  className="rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-left text-xs text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800 focus:outline-none focus:ring-0"
                >
                  {prompt}
                </button>
              ))}
            </div>
            <p className="mt-3 text-[10px] text-zinc-500">{t('sessions:guide.dismiss_hint', { defaultValue: 'Click an example or start typing to dismiss.' })}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default React.memo(AgentConsole);
