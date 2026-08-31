import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2, SendHorizonal, Square, User, Sparkles, Wrench, ChevronRight, Copy, Check,
} from 'lucide-react';
import { apiFetch, getAccessToken, getWsUrl } from '../../lib/api';
import { consoleInputClass, consoleButtonFocusClass } from '../../lib/consoleTokens';

/**
 * Devin/Cursor-style dialog view for a running agent session.
 *
 * Content comes from the LLM proxy's structured chat transcript (chatTranscript),
 * which records the user prompts, assistant replies, tool calls and tool results
 * that actually flow to the model — the same conversation the agent's TUI shows.
 * Input is sent through the same terminal WS `input` channel as the terminal view,
 * so the agent receives exactly what the user typed.
 */
export default function ChatView({ sessionId, onSessionEnd }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState([]);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const wsRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const endedRef = useRef(false);
  const onSessionEndRef = useRef(onSessionEnd);
  const knownSeqsRef = useRef(new Set());

  useEffect(() => { onSessionEndRef.current = onSessionEnd; }, [onSessionEnd]);

  // Merge history (from REST) into the message list, dedup by seq. Used on
  // mount and again after a WS reconnect so missed chat_events are backfilled.
  const mergeHistory = useCallback((incoming) => {
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    const seen = knownSeqsRef.current;
    const fresh = incoming.filter((m) => m?.seq != null && !seen.has(m.seq));
    for (const m of fresh) seen.add(m.seq);
    if (fresh.length === 0) return;
    setMessages((prev) => {
      const merged = [...prev];
      for (const m of fresh) merged.push(m);
      merged.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      return merged;
    });
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/chat`);
      if (!res.ok) return;
      const data = await res.json();
      mergeHistory(data.messages || []);
    } catch (_) { /* ignore */ } finally {
      setLoadingHistory(false);
    }
  }, [sessionId, mergeHistory]);

  // Connect WS, then stream chat events. On reconnect, re-fetch history to
  // backfill anything emitted while we were disconnected.
  useEffect(() => {
    let disposed = false;
    let ws = null;
    let reconnectTimer = null;

    const connect = () => {
      if (disposed) return;
      const token = getAccessToken();
      // chat=1 tells the server to skip terminal output replay/subscription —
      // the chat view only needs chat_event + the ability to send input.
      const url = `${getWsUrl(sessionId, token, 0)}&chat=1`;
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        // Backfill anything that happened while disconnected.
        void loadHistory();
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (msg.type === 'ready') { setConnected(true); return; }
        if (msg.type === 'chat_event' && msg.data) {
          const entry = msg.data;
          if (entry?.seq != null) {
            if (knownSeqsRef.current.has(entry.seq)) return;
            knownSeqsRef.current.add(entry.seq);
          }
          setMessages((prev) => [...prev, entry]);
          return;
        }
        if (msg.type === 'exit') {
          setEnded(true);
          endedRef.current = true;
          onSessionEndRef.current?.(sessionId);
        }
        if (msg.type === 'error') {
          setConnected(false);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        if (!endedRef.current) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch (_) { /* ignore */ }
      wsRef.current = null;
    };
  }, [sessionId, loadHistory]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loadingHistory]);

  const send = useCallback((text) => {
    const raw = text != null ? text : input;
    // Chat is not a terminal: collapse any embedded newlines (from copy-paste
    // or Shift+Enter) into single spaces so the agent TUI sees one prompt.
    // Submit with \r because Kimi/Claude TUI treat \n as a multi-line-edit
    // newline and only \r as "Enter" — sending \n alone leaves the prompt
    // unconfirmed (visible as a newline in the terminal view).
    const singleLine = String(raw).replace(/\s*\n\s*/g, ' ').trim();
    if (!singleLine) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'input', data: `${singleLine}\r` }));
    setInput('');
    setSending(true);
    setTimeout(() => setSending(false), 300);
  }, [input]);

  const stop = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: '\x03' }));
    }
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Group a tool_result right after its matching tool_call (same callId) into a
  // single card; leave other events as-is.
  const renderedItems = useMemo(() => {
    const items = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (
        m.role === 'tool_result'
        && m.callId
        && items.length > 0
        && items[items.length - 1].kind === 'tool_call'
        && items[items.length - 1].callId === m.callId
      ) {
        const prev = items[items.length - 1];
        items[items.length - 1] = { kind: 'tool', call: prev.call, result: m };
        continue;
      }
      if (m.role === 'tool_call') {
        items.push({ kind: 'tool_call', callId: m.callId, call: m });
      } else if (m.role === 'tool_result') {
        items.push({ kind: 'tool_result', callId: m.callId, result: m });
      } else {
        items.push({ kind: 'message', message: m });
      }
    }
    return items;
  }, [messages]);

  const isEmpty = !loadingHistory && renderedItems.length === 0;

  // While the agent is "thinking" — i.e. the user just sent something (or the
  // agent is still mid-tool) and we haven't seen the next assistant reply yet —
  // show a persistent thinking indicator at the bottom of the message list so
  // users can tell the agent is busy (the terminal view's ◐ spinner isn't
  // visible in chat mode).
  const isThinking = useMemo(() => {
    if (!connected || ended) return false;
    if (sending) return true;
    if (renderedItems.length === 0) return false;
    const last = renderedItems[renderedItems.length - 1];
    if (last.kind === 'message' && last.message.role === 'user') return true;
    if (last.kind === 'tool_call') return true;
    return false;
  }, [connected, ended, sending, renderedItems]);
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* Message list */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto console-scroll-hidden">
        {loadingHistory ? (
          <div className="flex h-full items-center justify-center text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100">
              <Sparkles className="h-6 w-6 text-zinc-400" strokeWidth={1.5} />
            </div>
            <p className="text-sm text-zinc-500">
              {t('chat:empty_hint', { defaultValue: 'Ask the agent something below. Messages appear here as the agent works.' })}
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
            {renderedItems.map((item, idx) => (
              <ChatItem key={idx} item={item} />
            ))}
            {isThinking && (
              <div className="flex items-center gap-2 text-xs text-zinc-400" role="status" aria-live="polite">
                <Sparkles className="h-3.5 w-3.5 animate-pulse" />
                {t('chat:thinking', { defaultValue: 'Agent is thinking…' })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-zinc-200 bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={Math.min(4, Math.max(1, input.split('\n').length))}
            placeholder={t('chat:input_placeholder', { defaultValue: 'Message the agent… (Enter to send, Shift+Enter for newline)' })}
            disabled={ended}
            autoFocus
            className={`${consoleInputClass} resize-none py-2.5 disabled:opacity-50`}
          />
          <button
            type="button"
            onClick={() => send()}
            disabled={!input.trim() || ended || !connected}
            title={t('chat:send', { defaultValue: 'Send' })}
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-zinc-50 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
          >
            <SendHorizonal className="h-4 w-4" />
          </button>
          {!ended && (
            <button
              type="button"
              onClick={stop}
              title={t('chat:stop', { defaultValue: 'Interrupt (Ctrl+C)' })}
              className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-200 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 ${consoleButtonFocusClass}`}
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatItem({ item }) {
  if (item.kind === 'message') return <ChatBubble message={item.message} />;
  if (item.kind === 'tool_call') return <ToolCard call={item.call} result={null} />;
  if (item.kind === 'tool_result') return <ToolCard call={null} result={item.result} />;
  return <ToolCard call={item.call} result={item.result} />;
}

function ChatBubble({ message }) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const copyContent = async () => {
    if (!message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
    } catch (_) {
      // Fallback for older browsers / non-secure contexts.
      const ta = document.createElement('textarea');
      ta.value = message.content;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (__) { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // WeChat-style layout: user bubbles hug the right (avatar would sit on the
  // left), agent bubbles hug the left (avatar on the right). Indents on the
  // *opposite* side give the avatar room without stealing bubble width.
  return (
    <div
      className={`group flex w-full ${isUser ? 'justify-end pl-2 sm:pl-12' : 'justify-start pr-2 sm:pr-12'}`}
    >
      <div className="flex max-w-[80%] flex-col gap-1">
        <div className={`flex items-center gap-1.5 text-[11px] text-zinc-400 ${isUser ? 'justify-end' : 'justify-start'}`}>
          {isUser ? <User className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
          <span className="font-medium">
            {isUser ? t('chat:you', { defaultValue: 'You' }) : t('chat:agent', { defaultValue: 'Agent' })}
          </span>
          {!isUser && message.model ? (
            <span className="text-zinc-400">· {message.model}</span>
          ) : null}
        </div>
        <pre className="whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed text-zinc-800">
          {message.content}
        </pre>
        <button
          type="button"
          onClick={copyContent}
          title={t('chat:copy', { defaultValue: 'Copy' })}
          aria-label={t('chat:copy', { defaultValue: 'Copy' })}
          className={`invisible mt-0.5 flex h-6 w-6 items-center justify-center self-${isUser ? 'end' : 'start'} rounded-md text-zinc-400 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 hover:bg-zinc-200 hover:text-zinc-700 ${consoleButtonFocusClass}`}
        >
          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
    </div>
  );
}

function ToolCard({ call, result }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const name = call?.tool || result?.tool || t('chat:tool_unknown', { defaultValue: 'Tool' });
  const hasDetail = Boolean(call?.content) || Boolean(result?.content);
  // Tool cards stay in the gray box (they're structured diagnostics, not chat)
  // and sit on the agent's left side to keep the WeChat-style left/right split.
  return (
    <div className="flex justify-start pr-2 sm:pr-12">
      <div className="w-full max-w-[80%] overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((o) => !o)}
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-zinc-700 ${hasDetail ? 'cursor-pointer hover:bg-zinc-100' : 'cursor-default'} ${consoleButtonFocusClass}`}
        >
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`} />
          <Wrench className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <span className="truncate font-medium">{name}</span>
          {!result && (
            <span className="ml-auto shrink-0 text-[11px] text-zinc-400">
              {t('chat:tool_running', { defaultValue: 'running…' })}
            </span>
          )}
        </button>
        {open && (
          <div className="space-y-2 border-t border-zinc-200 px-3 py-2">
            {call?.content ? (
              <div>
                <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                  {t('chat:tool_args', { defaultValue: 'Arguments' })}
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-100 p-2 font-mono text-[12px] text-zinc-700">
                  {formatArgs(call.content)}
                </pre>
              </div>
            ) : null}
            {result?.content ? (
              <div>
                <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                  {t('chat:tool_result_label', { defaultValue: 'Result' })}
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-100 p-2 font-mono text-[12px] text-zinc-700">
                  {result.content}
                </pre>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

// Pretty-print tool-call arguments JSON when possible.
function formatArgs(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return raw || '';
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch (_) {
    return raw;
  }
}
