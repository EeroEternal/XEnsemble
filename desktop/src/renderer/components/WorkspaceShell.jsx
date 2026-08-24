import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { getAccessToken, getWorkspaceShellWsUrl, refreshAccessToken } from '../lib/api';
import { useTerminalTheme } from '../hooks/useTerminalTheme.jsx';
import {
  createTerminalReconnectState,
  isTerminalAuthFailure,
  refreshTokenForTerminalFailure,
} from '../../../../shared/terminalReconnect.mjs';
import { useTranslation } from 'react-i18next';

function parseMessage(raw) {
  if (typeof raw === 'string') return JSON.parse(raw);
  return JSON.parse(raw.toString());
}

function getArrowSequence(key, applicationCursorKeys) {
  const prefix = applicationCursorKeys ? '\x1bO' : '\x1b[';
  switch (key) {
    case 'ArrowUp': return `${prefix}A`;
    case 'ArrowDown': return `${prefix}B`;
    case 'ArrowRight': return `${prefix}C`;
    case 'ArrowLeft': return `${prefix}D`;
    default: return null;
  }
}

export default function WorkspaceShell({ projectId }) {
  const { t } = useTranslation();
  const { preset } = useTerminalTheme();
  const hostRef = useRef(null);
  const wsRef = useRef(null);
  const terminalRef = useRef(null);
  const themeRef = useRef(preset.xterm);

  useEffect(() => {
    themeRef.current = preset.xterm;
  }, [preset]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const terminal = new Terminal({
      cols: 120,
      rows: 32,
      scrollback: 10000,
      convertEol: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      drawBoldTextInBrightColors: true,
      theme: themeRef.current,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    host.replaceChildren();
    terminal.open(host);
    terminalRef.current = terminal;

    let disposed = false;
    let serverEnded = false;
    let reconnectTimer = null;
    const reconnectState = createTerminalReconnectState();
    const MAX_RECONNECTS = 5;

    const fitTerminal = () => {
      fitAddon.fit();
      const cols = terminal.cols || 0;
      const rows = terminal.rows || 0;
      if (cols > 0 && rows > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    };

    const scheduleReconnect = (reason) => {
      if (disposed || serverEnded) return;
      const next = reconnectState.nextReconnect();
      if (next.exhausted) {
        terminal.write(`\r\n\x1b[31m${t('sessions:terminal.system_prefix')} ${t('sessions:terminal.restore_shell_failed', { reason: reason ? ` (${reason})` : '' })}\x1b[0m\r\n`);
        serverEnded = true;
        return;
      }
      terminal.write(`\r\n\x1b[33m${t('sessions:terminal.system_prefix')} ${t('sessions:terminal.reconnecting_shell', { attempt: next.attempt, max: MAX_RECONNECTS })}\x1b[0m\r\n`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!disposed) connect();
      }, next.delayMs);
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
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
      if (disposed || serverEnded || wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
    });

    const focusTerminal = () => {
      if (!serverEnded) terminal.focus();
    };
    host.addEventListener('mousedown', focusTerminal);
    host.addEventListener('click', focusTerminal);

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (!disposed) fitTerminal();
      });
    });
    resizeObserver.observe(host);

    if (!projectId) {
      terminal.write(`\r\n\x1b[33m${t('sessions:terminal.system_prefix')} ${t('sessions:terminal.select_workspace')}\x1b[0m\r\n`);
      serverEnded = true;
    } else {
      var connect = async () => {
        let ws;
        try {
          const accessToken = await getAccessToken();
          if (disposed) return;
          ws = new WebSocket(getWorkspaceShellWsUrl(projectId, accessToken));
          wsRef.current = ws;
        } catch (error) {
          if (!disposed) scheduleReconnect(error?.message || 'connect error');
          return;
        }

        let failureHandled = false;
        let authenticated = false;

        const handleConnectionFailure = async (reason, failure = {}) => {
          if (failureHandled || disposed || serverEnded || wsRef.current !== ws) return;
          failureHandled = true;
          await refreshTokenForTerminalFailure(failure, refreshAccessToken);
          if (!disposed && !serverEnded && wsRef.current === ws) {
            scheduleReconnect(reason);
          }
        };

        ws.onopen = () => {
          if (disposed) return;
          reconnectState.socketOpened();
        };

        ws.onmessage = (event) => {
          if (disposed) return;
          const msg = parseMessage(event.data);
          if (msg.type === 'ready') {
            if (!authenticated) {
              authenticated = true;
              reconnectState.authenticationSucceeded();
              requestAnimationFrame(() => requestAnimationFrame(fitTerminal));
            }
            return;
          }
          if (msg.type === 'output') {
            const viewport = host.querySelector('.xterm-viewport');
            const atBottom = !viewport || viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 5;
            terminal.write(msg.data, () => {
              if (atBottom && !disposed) terminal.scrollToBottom();
            });
            return;
          }
          if (msg.type === 'error') {
            const failure = { message: msg.data };
            void handleConnectionFailure(msg.data || 'error', failure);
            try { ws.close(); } catch { /* ignore */ }
            return;
          }
          if (msg.type === 'exit') {
            const code = msg.data;
            if (code === 0) {
              if (msg.message) terminal.write(msg.message);
              serverEnded = true;
            } else {
              void handleConnectionFailure(`code ${code}`, { message: `code ${code}` });
            }
            try { ws.close(); } catch { /* ignore */ }
          }
        };

        ws.onerror = () => {
          if (disposed || serverEnded) return;
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        };

        ws.onclose = (event) => {
          if (disposed || serverEnded) return;
          const failure = { code: event.code, reason: event.reason };
          if (isTerminalAuthFailure(failure)) {
            void handleConnectionFailure(event.reason || 'Invalid access token', failure);
            return;
          }
          if (event.wasClean) return;
          void handleConnectionFailure(authenticated ? 'disconnected' : 'connection failed', failure);
        };
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
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [projectId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = preset.xterm;
  }, [preset]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#09090b] p-4">
      <div ref={hostRef} className="xterm-host min-h-0 w-full flex-1" />
    </div>
  );
}
