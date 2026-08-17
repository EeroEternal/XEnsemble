import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

import { getAccessToken, getWsUrl, apiFetch, refreshAccessToken } from '../lib/api';
import { useTerminalTheme } from '../hooks/useTerminalTheme.jsx';
import { Loader2 } from 'lucide-react';
import {
  createTerminalReconnectState,
  isTerminalAuthFailure,
  refreshTokenForTerminalFailure,
} from '../../../../shared/terminalReconnect.mjs';

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

// Mouse-tracking SET sequences that capture mouse events, preventing text
// selection.  Stripped in live mode so xterm.js handles mouse selection
// natively.  Wheel scrolling is preserved via a wheel event listener.
const MOUSE_TRACKING_SET_RE = /\x1b\[\?(?:1000|1002|1003|1005|1006|1015|1016)h/g;

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

function AgentConsole({
  sessionId,
  reconnectVersion = 0,
  onSessionEnd,
  onSessionConnected,
  sessionLive = true,
  sessionWakeable = false,
}) {
  const { preset } = useTerminalTheme();
  const xtermTheme = preset?.xterm || FALLBACK_XTERM_THEME;

  const hostRef = useRef(null);
  const overlayRef = useRef(null);
  const terminalRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);
  const onSessionEndRef = useRef(onSessionEnd);
  const onSessionConnectedRef = useRef(onSessionConnected);
  const connectedRef = useRef(false);
  const firstConnectRef = useRef(true);

  const replayDoneRef = useRef(true);
  const shouldConnect = sessionLive;
  const shouldReplayIdle = sessionWakeable && !sessionLive;
  // eslint-disable-next-line no-unused-vars
  const [connected, setConnected] = useState(false);
  // eslint-disable-next-line no-unused-vars
  const [ended, setEnded] = useState(!shouldConnect && !shouldReplayIdle);

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
    // Fit terminal to container BEFORE creating WebSocket so transcript
    // replay doesn't wrap at the wrong width.
    try { fitAddon.fit(); } catch (_) {}
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => { webglAddon.dispose(); });
      terminal.loadAddon(webglAddon);
    } catch (_) {
      // WebGL not available, fall back to default DOM renderer
    }
    terminalRef.current = terminal;

    let overlayTimer = null;
    const showOverlay = () => {
      if (hostRef.current) hostRef.current.style.opacity = '0';
      if (overlayRef.current) overlayRef.current.style.display = 'flex';
      overlayTimer = setTimeout(() => { hideOverlay(); }, 5000);
    };
    const hideOverlay = () => {
      if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
      requestAnimationFrame(() => {
        if (disposed) return;
        if (hostRef.current) hostRef.current.style.opacity = '1';
        if (overlayRef.current) overlayRef.current.style.display = 'none';
        terminal.scrollToBottom();
      });
    };

    let disposed = false;
    let serverEnded = false;
    let reconnectTimer = null;
    let lastSentCols = 0;
    let lastSentRows = 0;
    let writeRafId = null;
    let coalesceTimer = null;
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

    const handleWheel = (e) => {
      const inAlt = terminal.buffer.active === terminal.buffer.alternate;
      if (!inAlt || serverEnded || disposed) return;
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      e.preventDefault();
      e.stopPropagation();
      wsRef.current.send(JSON.stringify({ type: 'input', data: e.deltaY > 0 ? '\x1b[6~' : '\x1b[5~' }));
    };

    const focusTerminal = () => {
      if (!serverEnded) terminal.focus();
    };
    host.addEventListener('mousedown', focusTerminal);
    host.addEventListener('click', focusTerminal);
    host.addEventListener('contextmenu', handleContextMenu);
    host.addEventListener('wheel', handleWheel, { passive: false });

    let lastHostWidth = 0;
    let lastHostHeight = 0;
    let resizeDebounce = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeDebounce) clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        if (disposed) return;
        const rect = host.getBoundingClientRect();
        const w = Math.floor(rect.width);
        const h = Math.floor(rect.height);
        if (Math.abs(w - lastHostWidth) <= 2 && Math.abs(h - lastHostHeight) <= 2) return;
        lastHostWidth = w;
        lastHostHeight = h;
        fitTerminal();
      }, 100);
    });
    resizeObserver.observe(host);

    if (!sessionId || (!shouldConnect && !shouldReplayIdle)) {
      terminal.write('\r\n\x1b[33m[System] Session is not running.\x1b[0m\r\n');
      setEnded(true);
    } else if (shouldReplayIdle) {
      (async () => {
        showOverlay();
        try {
          const response = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Failed to load session history');
          if (data.head != null && data.head > 0) setCachedSeq(sessionId, data.head);
          const systemMsg = '\r\n\x1b[33m[System] Session paused. Click Start to resume.\x1b[0m\r\n';
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
            terminal.write(`\r\n\x1b[31m[System] ${error?.message || 'Failed to load session history'}\x1b[0m\r\n`);
            hideOverlay();
            setEnded(true);
          }
        }
      })();
    } else {
      const reconnectState = createTerminalReconnectState();
      const MAX_RECONNECTS = 5;

      const scheduleReconnect = (reason) => {
        if (disposed || serverEnded) return;
        const next = reconnectState.nextReconnect();
        if (next.exhausted) {
          terminal.write(`\r\n\x1b[31m[System] Terminal could not be restored${reason ? ` (${reason})` : ''}. Click Restart to retry.\x1b[0m\r\n`);
          setEnded(true);
          return;
        }
        terminal.write(`\r\n\x1b[33m[System] Reconnecting terminal… (${next.attempt}/${MAX_RECONNECTS})\x1b[0m\r\n`);
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
          const cachedSeq = isFirstConnect ? 0 : getCachedSeq(sessionId);
          const ws = new WebSocket(getWsUrl(sessionId, getAccessToken(), cachedSeq));
          wsRef.current = ws;
          let failureHandled = false;
          let authenticated = false;
          let replayDone = false;
          replayDoneRef.current = false;
          let writeBuffer = '';
          let pendingSeq = null;
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
            return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\].*?\x07/g, '');
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
                  if (cy >= 0 && cy < vsRows && cx < 120) {
                    const r = vsScreen[cy];
                    vsScreen[cy] = r.substring(0, cx) + data[i] + r.substring(cx + 1);
                  }
                  cx++; i++;
                } else i++;
              }
              vsCursorY = cy;
              return data;
            }
            const upCount = parseInt(cursorUpMatch[1]);
            let startRow = Math.max(0, vsCursorY - upCount);
            const prefix = data.slice(0, dataOffset + cursorUpMatch[0].length);
            const rest = data.slice(dataOffset + cursorUpMatch[0].length);
            // If rest contains cursor-down (\x1b[<n>B), the row-diffing path
            // can't correctly track vsCursorY: the content moves the cursor
            // back down after the update (e.g. codebuddy spinner:
            // \x1b[6A\x1b[2K<spinner>\x1b[6B).  vsCursorY would be set to
            // startRow but the actual cursor is at startRow+6, causing
            // subsequent updates to write to wrong rows (spinner frames
            // accumulate instead of overwriting).  Return raw data to let
            // xterm.js handle the cursor movement natively.
            if (/\x1b\[\d*B/.test(rest)) {
              return data;
            }
            const segments = rest.match(/\x1b\[2K[^\r\n]*/g);
            if (!segments || segments.length === 0) {
              vsCursorY = startRow;
              return data;
            }
            let output = prefix;
            let currentRow = startRow;
            let anyChanged = false;
            for (const seg of segments) {
              if (currentRow >= vsRows) break;
              const raw = seg.slice(4);
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
            if (disposed) return;
            if (pendingSeq != null) {
              setCachedSeq(sessionId, pendingSeq);
              pendingSeq = null;
            }
            if (!writeBuffer && !syncTermPending) return;

            let remaining = syncTermPending + (writeBuffer || '');
            syncTermPending = '';
            writeBuffer = '';

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
              // Buffer incomplete sync-term blocks even in alt screen.
              // xterm.js ignores ?2026h/l wrappers but executes internal
              // content (cursor positioning, space-fill). If a block is
              // split across flushes, the first fragment clears/overwrites
              // rows whose full content hasn't arrived yet, leaving blank
              // gaps. Buffer until the matching ?2026l arrives.
              //
              // Coalesce multiple complete blocks across animation frames:
              // agents like qwen-code emit full-screen redraws at 96% gaps
              // < 100ms.  Writing every intermediate block causes xterm.js
              // to process 5+ full-screen redraws per second, producing
              // visible flickering.  Keep only the last block (full-screen
              // redraws overwrite each other).  A 100ms timer lets blocks
              // from subsequent animation frames accumulate before the write.
              if (remaining.includes('\x1b[?2026h')) {
                const syncEnd = remaining.indexOf('\x1b[?2026l');
                if (syncEnd === -1) {
                  const syncStart = remaining.indexOf('\x1b[?2026h');
                  const before = remaining.slice(0, syncStart);
                  syncTermPending = remaining.slice(syncStart);
                  if (before) writeTerminalData(before);
                } else {
                  // Complete block(s) found.  Buffer and coalesce with a
                  // timer so blocks arriving in subsequent animation frames
                  // are accumulated before the final write.
                  syncTermPending = remaining;
                  if (coalesceTimer) clearTimeout(coalesceTimer);
                  coalesceTimer = setTimeout(() => {
                    coalesceTimer = null;
                    if (disposed) return;
                    const data = syncTermPending;
                    syncTermPending = '';
                    if (!data) return;
                    // Find the last COMPLETE sync-term block (has both
                    // ?2026h and ?2026l).  Use lastIndexOf('?2026l') to
                    // find the last block end, then locate its matching
                    // '?2026h'.  This correctly handles trailing incomplete
                    // blocks (a ?2026h without a matching ?2026l) which
                    // occur when the server's flush splits a block across
                    // WS messages.  Previously, a trailing incomplete block
                    // caused ALL complete blocks to be discarded (the code
                    // only emitted data before the FIRST ?2026h), leaving
                    // the screen frozen in 98.6% of timer fires.
                    const lastCompleteEnd = data.lastIndexOf('\x1b[?2026l');
                    if (lastCompleteEnd === -1) {
                      // No complete block yet; keep buffering everything.
                      syncTermPending = data;
                      return;
                    }
                    const lastCompleteStart = data.lastIndexOf('\x1b[?2026h', lastCompleteEnd);
                    const blockEnd = lastCompleteEnd + '\x1b[?2026l'.length;
                    // Save any trailing incomplete block (data after the
                    // last complete block) for the next coalesce cycle.
                    const afterBlock = data.slice(blockEnd);
                    if (afterBlock.includes('\x1b[?2026h')) {
                      syncTermPending = afterBlock.slice(afterBlock.indexOf('\x1b[?2026h'));
                    }
                    // Extract all non-sync-term data (content outside
                    // ?2026h...?2026l blocks), stopping before any trailing
                    // incomplete block.  This preserves terminal-state
                    // sequences while discarding intermediate full-screen
                    // redraws.
                    let nonSync = '';
                    let pos = 0;
                    while (pos < data.length) {
                      const h = data.indexOf('\x1b[?2026h', pos);
                      if (h === -1) { nonSync += data.slice(pos); break; }
                      nonSync += data.slice(pos, h);
                      const l = data.indexOf('\x1b[?2026l', h);
                      if (l === -1) break;
                      pos = l + '\x1b[?2026l'.length;
                    }
                    writeTerminalData(
                      nonSync
                      + data.slice(lastCompleteStart, blockEnd)
                      + '\x1b[?25l'
                    );
                  }, 100);
                }
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
            processed = processed.replace(MOUSE_TRACKING_SET_RE, '');
            const buf = terminal.buffer.active;
            const atBottom = buf.baseY + terminal.rows >= buf.length;
            terminal.write(processed, () => {
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
              return;
            }
            if (msg.type === 'output') {
              if (msg.seq != null) pendingSeq = msg.seq;
              writeBuffer += msg.data;
              if (writeRafId === null) {
                writeRafId = requestAnimationFrame(flushWriteBuffer);
              }
              return;
            }
            if (msg.type === 'error') {
              if (writeRafId !== null) { cancelAnimationFrame(writeRafId); clearTimeout(writeRafId); writeRafId = null; }
              if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
              flushWriteBuffer();
              hideOverlay();
              connectedRef.current = false;
              const failure = { message: msg.data };
              void handleConnectionFailure(msg.data || 'error', failure);
              try { ws.close(); } catch { /* ignore */ }
              return;
            }
            if (msg.type === 'exit') {
              if (writeRafId !== null) { cancelAnimationFrame(writeRafId); clearTimeout(writeRafId); writeRafId = null; }
              if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
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
            if (event.wasClean) return;
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
      if (writeRafId !== null) { cancelAnimationFrame(writeRafId); clearTimeout(writeRafId); }
      if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resizeTimers.forEach((t) => clearTimeout(t));
      resizeObserver.disconnect();
      host.removeEventListener('mousedown', focusTerminal);
      host.removeEventListener('click', focusTerminal);
      host.removeEventListener('contextmenu', handleContextMenu);
      host.removeEventListener('wheel', handleWheel);
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

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-transparent">
      <div
        ref={overlayRef}
        className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-900/90 backdrop-blur-sm"
        style={{ display: 'none' }}
      >
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading history…
        </div>
      </div>
      <div ref={hostRef} className="min-h-0 w-full flex-1" />
    </div>
  );
}

export default React.memo(AgentConsole);
