import { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { getAccessToken, getWorkspaceShellWsUrl, refreshAccessToken } from '../lib/api';
import { useTerminalTheme } from '../hooks/useTerminalTheme.jsx';
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

const WorkspaceShell = forwardRef(function WorkspaceShell({ projectId, onOutput }, ref) {
  const { preset } = useTerminalTheme();
  const xtermTheme = preset?.xterm || FALLBACK_XTERM_THEME;

  const hostRef = useRef(null);
  const wsRef = useRef(null);
  const connectedRef = useRef(false);
  const themeRef = useRef(xtermTheme);
  const termRef = useRef(null);

  useEffect(() => {
    themeRef.current = xtermTheme;
  }, [xtermTheme]);

  // 用 ref 存 onOutput，避免回调变化导致 WS 重连
  const onOutputRef = useRef(onOutput);
  useEffect(() => { onOutputRef.current = onOutput; }, [onOutput]);

  // 暴露给父组件：向 shell 注入命令（用于一键部署执行）
  const sendInput = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
      return true;
    }
    return false;
  }, []);

  useImperativeHandle(ref, () => ({ sendInput, isReady: () => connectedRef.current }), [sendInput]);

  // 拦截 Ctrl+V（无 Shift）直接粘贴到 xterm，免去 Ctrl+Shift+V 的记忆负担
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'v' && e.key !== 'V') return;
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.shiftKey || e.altKey) return;
      const t = termRef.current;
      if (!t) return;
      const host = hostRef.current;
      const active = document.activeElement;
      // 仅在终端容器有焦点（或其内部）时拦截，避免影响页面其他输入框
      if (host && (active === host || host.contains(active))) {
        e.preventDefault();
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then((text) => {
            if (text) t.paste(text);
          }).catch(() => {});
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const terminal = new Terminal({
      cols: 120,
      rows: 32,
      scrollback: 2000,
      convertEol: true,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      drawBoldTextInBrightColors: true,
      theme: themeRef.current,
    });
    termRef.current = terminal;

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    host.replaceChildren();
    terminal.open(host);

    let disposed = false;
    let serverEnded = false;
    const reconnectState = createTerminalReconnectState();
    let reconnectTimer = null;
    const MAX_RECONNECTS = 5;

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

    const handleContextMenu = (e) => {
      e.preventDefault();
      const selection = terminal.getSelection();
      if (selection) {
        copyToClipboard(selection);
        terminal.clearSelection();
      }
    };

    const fitTerminal = () => {
      fitAddon.fit();
      const cols = terminal.cols || 0;
      const rows = terminal.rows || 0;
      if (cols > 0 && rows > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    };

    // The workspace shell process lives inside the same sandbox VM as the agent.
    // Restarting the agent can tear down and rebuild that VM, killing the shell
    // (reported as exit code -1). Since the workspace dir is persistent, transparently
    // reopen a fresh shell instead of leaving a dead terminal.
    const scheduleReconnect = (reason) => {
      if (disposed) return;
      const next = reconnectState.nextReconnect();
      if (next.exhausted) {
        terminal.write(`\r\n\x1b[31m[System] Terminal could not be restored${reason ? ` (${reason})` : ''}. Switch tabs to retry.\x1b[0m\r\n`);
        serverEnded = true;
        return;
      }
      terminal.write(`\r\n\x1b[33m[System] Reconnecting workspace shell… (${next.attempt}/${MAX_RECONNECTS})\x1b[0m\r\n`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!disposed) connect();
      }, next.delayMs);
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
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
    });

    const focusTerminal = () => {
      if (!serverEnded) terminal.focus();
    };
    host.addEventListener('mousedown', focusTerminal);
    host.addEventListener('click', focusTerminal);
    host.addEventListener('contextmenu', handleContextMenu);

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (!disposed) fitTerminal();
      });
    });
    resizeObserver.observe(host);

    if (!projectId) {
      terminal.write('\r\n\x1b[33m[System] Select a workspace to open a shell.\x1b[0m\r\n');
      serverEnded = true;
    } else {
      var connect = () => {
        try {
          const ws = new WebSocket(getWorkspaceShellWsUrl(projectId, getAccessToken()));
          wsRef.current = ws;
          let failureHandled = false;
          let authenticated = false;

          const markAuthenticated = () => {
            if (authenticated || disposed || wsRef.current !== ws) return;
            authenticated = true;
            connectedRef.current = true;
            reconnectState.authenticationSucceeded();
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
                if (!disposed) fitTerminal();
              });
            });
          };

          ws.onmessage = (event) => {
            if (disposed) return;
            const msg = parseMessage(event.data);
            if (msg.type === 'ready') {
              markAuthenticated();
              return;
            }
            if (msg.type === 'output') {
                if (onOutputRef.current) onOutputRef.current(msg.data);
                const viewport = hostRef.current?.querySelector('.xterm-viewport');
              const atBottom = !viewport || viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 5;
              terminal.write(msg.data, () => {
                if (atBottom && !disposed) terminal.scrollToBottom();
              });
              return;
            }
            if (msg.type === 'metrics') {
              return;
            }
            if (msg.type === 'error') {
              // Backend lost the shell (e.g. VM rebuilt on agent restart) — reopen.
              connectedRef.current = false;
              const failure = { message: msg.data };
              void handleConnectionFailure(msg.data || 'error', failure);
              try { ws.close(); } catch { /* ignore */ }
              return;
            }
            if (msg.type === 'exit') {
              const code = msg.data;
              connectedRef.current = false;
              try { ws.close(); } catch { /* ignore */ }
              if (code === 0) {
                // User exited the shell normally.
                if (msg.message) terminal.write(msg.message);
                serverEnded = true;
              } else {
                // Abnormal exit (e.g. -1 when the VM was torn down) — reopen.
                void handleConnectionFailure(`code ${code}`, { message: `code ${code}` });
              }
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
            if (disposed || serverEnded) return;
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

    requestAnimationFrame(() => {
      if (!disposed) fitTerminal();
    });

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resizeObserver.disconnect();
      host.removeEventListener('mousedown', focusTerminal);
      host.removeEventListener('click', focusTerminal);
      host.removeEventListener('contextmenu', handleContextMenu);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      connectedRef.current = false;
      termRef.current = null;
      terminal.dispose();
    };
  }, [projectId]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-transparent">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div ref={hostRef} className="min-h-0 w-full flex-1" />
      </div>
    </div>
  );
});

export default WorkspaceShell;
