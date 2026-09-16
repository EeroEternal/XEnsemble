import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2, SendHorizonal, Square, User, Sparkles, Wrench, ChevronRight, ChevronUp, Copy, Check, AlertCircle, Info, X,
  HelpCircle, TerminalSquare, AlertTriangle,
} from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { apiFetch, getAccessToken, getWsUrl } from '../../lib/api';
import { consoleInputClass, consoleButtonFocusClass } from '../../lib/consoleTokens';
import MarkdownView from '../Markdown';
import {
  KEY_ARROW_DOWN, KEY_ARROW_UP, KEY_ENTER, KEY_SPACE,
  parseQuestionTool, detectTuiPrompt, readScreenLines,
} from '../../lib/chatPrompt';
import { saveViewPref } from '../../lib/viewPrefs';

// Drop the "Agent is thinking…" marker if the server has been silent for this
// long while we're not actively sending. Catches stalled sessions (network
// blip, boxlite hiccup, LLM proxy error) where the WS connection is still
// alive but no more chat_events will ever arrive — without this the dialog
// view latches the spinner on the last tool/user event.
const THINKING_IDLE_TIMEOUT_MS = 60000;

// The screen is only trusted as "waiting for input" after the conversation
// has been quiet for this long — during active streaming the TUI repaints
// spinners that can look prompt-like.
const TUI_PROMPT_QUIET_MS = 2500;

// History paging: the server keeps the latest MAX_EVENTS_PER_SESSION (500)
// events per session; this view fetches them HISTORY_PAGE_SIZE at a time via
// cursor pagination (?before_seq=) so a long qwen session renders one small
// page on mount instead of hundreds of Markdown-heavy bubbles at once.
// 500 / 50 = at most 10 「加载更早」 page-backs from newest to oldest.
const HISTORY_PAGE_SIZE = 50;
// Assistant replies above this many chars render truncated with an expand
// button: a single multi-hundred-KB reply pushed through the markdown /
// highlight / katex pipeline can stall the tab on its own, and pagination
// only reduces message count — not the render cost of one giant message.
// Display-only: server-side data stays intact.
const LONG_MESSAGE_CHARS = 65536;

// Shared style for the TUI-prompt banner action buttons.
const TUI_PROMPT_ACTION_BTN = 'inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 text-[11.5px] font-medium text-amber-900 hover:bg-amber-100';

/**
 * Devin/Cursor-style dialog view for a running agent session.
 *
 * Content comes from the LLM proxy's structured chat transcript (chatTranscript),
 * which records the user prompts, assistant replies, tool calls and tool results
 * that actually flow to the model — the same conversation the agent's TUI shows.
 * Input is sent through the same terminal WS `input` channel as the terminal view,
 * so the agent receives exactly what the user typed.
 *
 * The WS (chat=1) skips terminal history replay but still streams LIVE PTY
 * output. That stream feeds a headless xterm buffer used to detect TUI
 * confirmation/selection prompts (permission pickers, plan approval, y/n)
 * that never appear as chat events — see lib/chatPrompt.js.
 */
export default function ChatView({ sessionId, onSessionEnd }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState([]);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  // 游标分页：true = 更早的历史已取完（某一页不足 PAGE_SIZE 或为空）；
  // loadingOlder = 「加载更早」请求进行中（按钮转 spinner 防重复点击）。
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const wsRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const endedRef = useRef(false);
  const onSessionEndRef = useRef(onSessionEnd);
  const knownSeqsRef = useRef(new Set());
  // --- TUI prompt detection (see lib/chatPrompt.js) ---
  // A headless xterm parses the live PTY stream into a screen buffer; we
  // never render it or attach it to the DOM.
  const termRef = useRef(null);
  const promptScanTimerRef = useRef(null);
  const promptSuppressUntilRef = useRef(0);
  const lastChatEventAtRef = useRef(0);
  const runPromptScanRef = useRef(() => {});
  const [tuiPrompt, setTuiPrompt] = useState(null);

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

  // Fetch one page of history. beforeSeq=null → newest page; otherwise the
  // page immediately older than the given seq (server cursor pagination).
  // Returns the fetched messages (oldest→newest) so the caller can detect
  // exhaustion: a short page means nothing older is left. Missed WS events
  // after a reconnect are backfilled by re-fetching the newest page and
  // deduping by seq in mergeHistory.
  const loadHistory = useCallback(async (beforeSeq = null) => {
    try {
      const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
      if (beforeSeq != null) params.set('before_seq', String(beforeSeq));
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/chat?${params.toString()}`);
      if (!res.ok) return [];
      const data = await res.json();
      const incoming = data.messages || [];
      mergeHistory(incoming);
      return incoming;
    } catch (_) {
      return [];
    } finally {
      setLoadingHistory(false);
    }
  }, [sessionId, mergeHistory]);

  // 「加载更早」：向前翻一页历史。Prepend 会改变列表高度，先记录滚动位置，
  // 渲染完成后恢复——否则用户正在看的内容会被顶走 / 跳回底部。
  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder || loadingHistory) return;
    let oldestSeq = null;
    for (const m of messages) {
      if (m?.seq != null && (oldestSeq == null || m.seq < oldestSeq)) oldestSeq = m.seq;
    }
    if (oldestSeq == null) return;
    const prevTop = listRef.current?.scrollTop ?? 0;
    const prevHeight = listRef.current?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      const older = await loadHistory(oldestSeq);
      // 不足一页（含空页）⇒ 更早的没有更多了
      if (older.length < HISTORY_PAGE_SIZE) setHistoryExhausted(true);
      requestAnimationFrame(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop;
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, loadingHistory, messages, loadHistory]);

  // Connect WS, then stream chat events. On reconnect, re-fetch history to
  // backfill anything emitted while we disconnected.
  useEffect(() => {
    let disposed = false;
    let ws = null;
    let reconnectTimer = null;
    // After two failed connect attempts in a row, the session is almost
    // certainly gone (server restart, session reclaimed, etc.) — the agent
    // view shows "session is not active"; mark the chat view as ended too so
    // the thinking spinner clears and we stop hammering the server.
    let failedConnects = 0;

    const connect = () => {
      if (disposed) return;
      const token = getAccessToken();
      // chat=1: the server skips terminal history replay (the chat view has
      // no terminal to paint) but still streams LIVE output frames — the
      // headless buffer below watches them for TUI confirmation prompts.
      const url = `${getWsUrl(sessionId, token, 0)}&chat=1`;
      try {
        ws = new WebSocket(url);
      } catch (_) {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        failedConnects = 0;
        setConnected(true);
        // Backfill anything that happened while disconnected.
        void loadHistory();
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (msg.type === 'ready') {
          setConnected(true);
          // Fresh stream after (re)connect: drop any stale screen state so
          // detection starts from what the TUI paints next.
          try { termRef.current?.reset(); } catch { /* ignore */ }
          setTuiPrompt(null);
          return;
        }
        if (msg.type === 'output' && typeof msg.data === 'string') {
          // Feed the live PTY stream into the headless terminal, then scan
          // the screen (debounced) for confirmation/selection prompts.
          const term = termRef.current;
          if (term) {
            try { term.write(msg.data); } catch { /* ignore */ }
            if (!promptScanTimerRef.current) {
              promptScanTimerRef.current = setTimeout(() => runPromptScanRef.current(), 400);
            }
          }
          return;
        }
        if (msg.type === 'chat_event' && msg.data) {
          const entry = msg.data;
          if (entry?.seq != null) {
            if (knownSeqsRef.current.has(entry.seq)) return;
            knownSeqsRef.current.add(entry.seq);
          }
          setMessages((prev) => [...prev, entry]);
          setLastEventAt(Date.now());
          lastChatEventAtRef.current = Date.now();
          // The agent resumed work — any pending terminal prompt is gone.
          setTuiPrompt(null);
          return;
        }
        if (msg.type === 'exit') {
          setEnded(true);
          endedRef.current = true;
          onSessionEndRef.current?.(sessionId);
          return;
        }
        if (msg.type === 'error') {
          setConnected(false);
          // "Session not found or not active" / "Session not active" come
          // straight from the WS close handshake on server restart. Treat
          // the session as done — the agent view is showing the same error.
          const data = typeof msg.data === 'string' ? msg.data : '';
          if (/not\s*active|not\s*found|invalid|expired/i.test(data)) {
            setEnded(true);
            endedRef.current = true;
            onSessionEndRef.current?.(sessionId);
          }
        }
      };

      ws.onerror = () => {
        // onclose will follow; let it own the reconnect logic.
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        if (endedRef.current) return;
        failedConnects += 1;
        if (failedConnects >= 2) {
          setEnded(true);
          endedRef.current = true;
          onSessionEndRef.current?.(sessionId);
          return;
        }
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      reconnectTimer = setTimeout(connect, 2000);
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch (_) { /* ignore */ }
      wsRef.current = null;
    };
  }, [sessionId, loadHistory]);

  const [scrollMetrics, setScrollMetrics] = useState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const [scrollbarHover, setScrollbarHover] = useState(false);
  const [scrollbarDrag, setScrollbarDrag] = useState(false);
  // TUI command limitation notice — dismissable per session.
  const [tuiHintDismissed, setTuiHintDismissed] = useState(false);
  // Timestamp (ms) of the last "stop" click. While set and no new chat_event
  // has arrived since, we treat the agent as idle so the thinking marker
  // disappears (Esc-twice aborts the current task; the session itself is
  // still alive, so ended stays false).
  const stopAtRef = useRef(0);
  const [lastEventAt, setLastEventAt] = useState(0);
  // 1s tick used to age lastEventAt — without this, isThinking can latch on
  // forever when the server stops emitting chat_events but the WS connection
  // is still alive (e.g. the agent session went silent but boxlite didn't
  // report a clean exit; the agent view shows no output while the dialog
  // view keeps flashing "Agent is thinking…").
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const scrollbarTrackRef = useRef(null);

  // Headless terminal for TUI prompt detection. xterm parses VT100 into a
  // screen buffer without any DOM attachment, so cursor-addressed repaints
  // from full-screen TUIs resolve to the same visible text the user would
  // see in the Agent view.
  useEffect(() => {
    const term = new Terminal({ cols: 120, rows: 40, scrollback: 0 });
    termRef.current = term;
    return () => {
      if (promptScanTimerRef.current) {
        clearTimeout(promptScanTimerRef.current);
        promptScanTimerRef.current = null;
      }
      try { term.dispose(); } catch { /* ignore */ }
      termRef.current = null;
    };
  }, []);

  // Scan the headless screen for confirmation/selection prompts. Runs on a
  // debounce after each output chunk; the quiet-window and suppress-window
  // checks keep idle chrome and stale pre-repaint frames from firing it.
  const runPromptScan = useCallback(() => {
    promptScanTimerRef.current = null;
    const term = termRef.current;
    if (!term || endedRef.current) return;
    if (Date.now() - lastChatEventAtRef.current < TUI_PROMPT_QUIET_MS) return;
    let detected = null;
    try { detected = detectTuiPrompt(readScreenLines(term)); } catch { /* ignore */ }
    setTuiPrompt((prev) => {
      if (detected && Date.now() < promptSuppressUntilRef.current) return prev;
      const nextKey = detected ? `${detected.kind}|${detected.lines.join('\u0001')}` : '';
      const prevKey = prev ? `${prev.kind}|${prev.lines.join('\u0001')}` : '';
      return nextKey === prevKey ? prev : detected;
    });
  }, []);
  useEffect(() => { runPromptScanRef.current = runPromptScan; }, [runPromptScan]);

  // Auto-scroll to bottom on new messages — but NOT when an older page was
  // just prepended (first seq moved backward): that would yank the viewport
  // away from the freshly loaded history. handleLoadOlder restores the exact
  // scroll offset itself.
  const prevFirstSeqRef = useRef(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const firstSeq = messages.find((m) => m?.seq != null)?.seq ?? null;
    const prevFirst = prevFirstSeqRef.current;
    prevFirstSeqRef.current = firstSeq;
    if (prevFirst != null && firstSeq != null && firstSeq < prevFirst) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loadingHistory]);

  // Track the message list's scroll geometry so the custom scrollbar thumb
  // can size and position itself proportionally.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const update = () => setScrollMetrics({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (ro) ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      if (ro) ro.disconnect();
    };
  }, [loadingHistory]);

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

  // Stable identity for the callbacks handed to memoized list items: `send`
  // closes over `input` and changes on every keystroke, which would defeat
  // ChatItem memoization (all items re-render per keystroke). Dispatch through
  // a ref so the prop identity never changes while always calling the latest
  // closure. `sendKeys` is already stable (deps []).
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; });
  const sendMessage = useCallback((...args) => sendRef.current(...args), []);

  const stop = useCallback(() => {
    // Two ESC presses — matches the agent-view terminal's "Esc twice to abort
    // the current operation" convention (Claude/Kimi/Qwen TUI). Sends two
    // distinct frames so the TUI sees them as two presses, not one double-byte
    // escape sequence. This aborts the in-flight task without killing the
    // whole session the way Ctrl-C (\x03) would.
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: '\x1b' }));
      wsRef.current.send(JSON.stringify({ type: 'input', data: '\x1b' }));
      // Mark the stop moment so the thinking spinner drops right away (the
      // session is still alive, so `ended` won't flip and isThinking would
      // otherwise linger on the last tool/user event).
      stopAtRef.current = Date.now();
    }
  }, []);

  // Replay a sequence of raw keystrokes (terminal bytes) over the WS input
  // channel — used by question cards and the TUI-prompt banner to drive the
  // agent's option picker exactly as if the user pressed the keys in the
  // Agent view. Keys are spaced out so pickers register each navigation step.
  const sendKeys = useCallback(async (parts) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const GAP_MS = 90;
    for (let i = 0; i < parts.length; i++) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'input', data: parts[i] }));
      if (i < parts.length - 1) await new Promise((r) => setTimeout(r, GAP_MS));
    }
  }, []);

  const handleTuiPromptAction = useCallback((action) => {
    // Hide immediately; a short suppress window keeps the stale pre-repaint
    // screen from re-triggering detection before the TUI reacts to the key.
    setTuiPrompt(null);
    promptSuppressUntilRef.current = Date.now() + 2000;
    if (action === 'terminal') {
      saveViewPref('agent');
      return;
    }
    sendKeys([action === 'esc' ? '\x1b' : KEY_ENTER]);
  }, [sendKeys]);

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
      } else if (m.role === 'error') {
        items.push({ kind: 'error', message: m });
      } else {
        items.push({ kind: 'message', message: m });
      }
    }
    return items;
  }, [messages]);

  const isEmpty = !loadingHistory && renderedItems.length === 0;

  const lastItem = useMemo(
    () => (renderedItems.length > 0 ? renderedItems[renderedItems.length - 1] : null),
    [renderedItems],
  );

  // Agent mid-turn: the last transcript item is not a final assistant reply.
  // TUI confirmation prompts are only plausible mid-turn — gating the banner
  // on this keeps idle TUI footer hints ("Press Enter to submit") from
  // triggering it while the agent is between turns.
  const midTurn = useMemo(
    () => Boolean(lastItem) && !(lastItem.kind === 'message' && lastItem.message.role === 'assistant'),
    [lastItem],
  );

  // An unanswered structured question card (AskUserQuestion-style tool call)
  // at the tail of the transcript — the card itself carries the input
  // affordance, so the screen-detector banner stays out of its way.
  const pendingQuestionActive = useMemo(() => Boolean(
    lastItem
    && (lastItem.kind === 'tool_call' || lastItem.kind === 'tool')
    && lastItem.call
    && !lastItem.result
    && parseQuestionTool(lastItem.call.tool, lastItem.call.content),
  ), [lastItem]);

  // While the agent is "thinking" — i.e. the user just sent something (or the
  // agent is still mid-tool) and we haven't seen the next assistant reply yet —
  // show a persistent thinking indicator at the bottom of the message list so
  // users can tell the agent is busy (the terminal view's ◐ spinner isn't
  // visible in chat mode).
  const isThinking = useMemo(() => {
    if (!connected || ended) return false;
    if (sending) return true;
    if (!lastItem) return false;
    // Once the agent gives a final assistant reply, it's between turns —
    // hide the spinner. Anything else (user prompt just sent, tool call
    // awaiting its result, tool result just came back while the LLM
    // decides the next step) means the agent is still busy.
    if (lastItem.kind === 'message' && lastItem.message.role === 'assistant') return false;
    // The LLM request itself failed (429 / 5xx / quota): the proxy recorded an
    // error event — the turn is over from the dialog view's perspective, and
    // the failure renders as an inline error bubble below.
    if (lastItem.kind === 'error') return false;
    // An unanswered agent-question card means the agent is waiting for the
    // user, not thinking — the card itself carries the "needs your input"
    // affordance, so suppress the spinner while it is open.
    if (pendingQuestionActive) return false;
    // A TUI confirmation/selection prompt detected on the terminal screen
    // (permission picker, plan approval, y/n) also means "paused for the
    // user" — the banner below explains the state instead of a spinner.
    if (tuiPrompt && midTurn) return false;
    // Esc-twice abort: agent session is alive but the user just stopped the
    // current task. Suppress the spinner for a short grace window so the
    // chat visibly settles; any new chat_event clears the grace window.
    if (stopAtRef.current && Date.now() - stopAtRef.current < 1500) return false;
    if (lastEventAt && stopAtRef.current && lastEventAt >= stopAtRef.current) return false;
    // Silent-session fallback: if the server has been quiet for a while and
    // we're not actively sending, the agent is effectively idle even though
    // the last item is a user prompt or tool event. Without this, a stalled
    // agent (network blip, boxlite hiccup, LLM proxy error) makes the
    // dialog view flash "Agent is thinking…" forever.
    if (lastEventAt && nowTick - lastEventAt > THINKING_IDLE_TIMEOUT_MS) return false;
    return true;
  }, [connected, ended, sending, lastItem, pendingQuestionActive, tuiPrompt, midTurn, lastEventAt, nowTick]);
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* Message list */}
      <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto scrollbar-hover">
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
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 pb-2">
            {/* 历史翻页：未到开头时显示「加载更早」；到顶后显示起始标记 */}
            {!historyExhausted && renderedItems.length > 0 && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={handleLoadOlder}
                  disabled={loadingOlder}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-[11.5px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50 disabled:pointer-events-none ${consoleButtonFocusClass}`}
                >
                  {loadingOlder ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronUp className="h-3 w-3" />}
                  {t('chat:load_older', { defaultValue: 'Load earlier messages' })}
                </button>
              </div>
            )}
            {historyExhausted && renderedItems.length > 0 && (
              <div className="text-center text-[11px] text-zinc-400">
                {t('chat:history_top', { defaultValue: 'Beginning of conversation' })}
              </div>
            )}
            {renderedItems.map((item, idx) => (
              <ChatItem key={itemKey(item, idx)} item={item} onKeys={sendKeys} onText={sendMessage} />
            ))}
            {isThinking && (
              <div className="flex justify-start pr-2 sm:pr-12" role="status" aria-live="polite">
                <div className="flex max-w-[80%] items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-[13.5px] text-zinc-700">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                  <Sparkles className="h-3.5 w-3.5 text-zinc-400" />
                  <span className="font-medium text-zinc-700">
                    {t('chat:agent', { defaultValue: 'Agent' })}
                  </span>
                  <span className="text-zinc-400">·</span>
                  <span>{t('chat:thinking', { defaultValue: 'Agent is thinking…' })}</span>
                </div>
              </div>
            )}
            {ended && !isThinking && (
              <div className="flex justify-start pr-2 sm:pr-12" role="status">
                <div className="flex max-w-[80%] items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13.5px] text-amber-800">
                  <AlertCircle className="h-3.5 w-3.5 text-amber-600" />
                  <span className="font-medium">
                    {t('chat:session_ended', { defaultValue: 'Session ended' })}
                  </span>
                  <span className="text-amber-700">·</span>
                  <span>{t('chat:session_ended_hint', { defaultValue: 'The agent is no longer running. Start a new session to continue.' })}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Custom overlay scrollbar — hidden by default, revealed on hover/drag. */}
        {(() => {
          const { scrollTop, scrollHeight, clientHeight } = scrollMetrics;
          const trackH = clientHeight;
          const overflow = scrollHeight > clientHeight + 1;
          const ratio = overflow ? clientHeight / scrollHeight : 0;
          const thumbH = overflow ? Math.max(32, ratio * trackH) : 36;
          const maxScroll = Math.max(1, scrollHeight - clientHeight);
          const thumbTop = overflow ? (scrollTop / maxScroll) * (trackH - thumbH) : (trackH - thumbH) / 2;
          const showThumb = scrollbarHover || scrollbarDrag;
          return (
            <div
              ref={scrollbarTrackRef}
              onMouseEnter={() => setScrollbarHover(true)}
              onMouseLeave={() => { if (!scrollbarDrag) setScrollbarHover(false); }}
              className="absolute right-0 top-0 z-10 h-full w-5"
              aria-hidden="true"
            >
              {showThumb ? (
                <div
                  className="absolute right-2 w-1.5 rounded-full bg-zinc-300/80 hover:bg-zinc-500 transition-colors cursor-grab"
                  style={{ top: thumbTop, height: thumbH }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setScrollbarDrag(true);
                    const startY = e.clientY;
                    const startTop = scrollTop;
                    const onMove = (ev) => {
                      const dy = ev.clientY - startY;
                      const next = overflow
                        ? startTop + (dy / (trackH - thumbH)) * maxScroll
                        : startTop + dy;
                      if (listRef.current) listRef.current.scrollTop = Math.max(0, Math.min(maxScroll, next));
                    };
                    const onUp = () => {
                      setScrollbarDrag(false);
                      setScrollbarHover(false);
                      window.removeEventListener('mousemove', onMove);
                      window.removeEventListener('mouseup', onUp);
                    };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                  }}
                />
              ) : null}
            </div>
          );
        })()}
      </div>

      {/* TUI confirmation/selection prompt — the agent paused inside its
          terminal (permission picker, plan approval, y/n question). These
          never surface as chat events; the screen detector caught it. Safe
          generic actions only: Enter confirms the highlighted option, Esc
          backs out, and the agent view remains the fallback for anything
          else. Structured AskUserQuestion tools render as question cards in
          the list instead, so the banner stays out of their way. */}
      {tuiPrompt && midTurn && !ended && !pendingQuestionActive && (
        <div className="border-t border-amber-300 bg-amber-50 px-4 py-2">
          <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px] text-amber-900">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span className="font-medium">
                {t('chat:tui_wait_title', { defaultValue: 'The terminal is waiting for you' })}
              </span>
              <span className="min-w-0 flex-1 text-amber-700">
                {t('chat:tui_wait_hint', { defaultValue: 'The agent raised a confirmation in its terminal and is paused until you answer.' })}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleTuiPromptAction('enter')}
                  className={`${TUI_PROMPT_ACTION_BTN} ${consoleButtonFocusClass}`}
                >
                  {t('chat:tui_wait_confirm', { defaultValue: 'Confirm (Enter)' })}
                </button>
                <button
                  type="button"
                  onClick={() => handleTuiPromptAction('esc')}
                  className={`${TUI_PROMPT_ACTION_BTN} ${consoleButtonFocusClass}`}
                >
                  {t('chat:tui_wait_cancel', { defaultValue: 'Cancel (Esc)' })}
                </button>
                <button
                  type="button"
                  onClick={() => handleTuiPromptAction('terminal')}
                  title={t('chat:tui_wait_open_terminal_title', { defaultValue: 'Switch to the Agent (terminal) view' })}
                  className={`${TUI_PROMPT_ACTION_BTN} ${consoleButtonFocusClass}`}
                >
                  <TerminalSquare className="h-3.5 w-3.5" />
                  {t('chat:tui_wait_open_terminal', { defaultValue: 'Handle in terminal' })}
                </button>
              </div>
            </div>
            {tuiPrompt.lines?.length > 0 && (
              <pre className="max-h-24 overflow-hidden whitespace-pre-wrap break-words rounded bg-amber-100/70 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-amber-900/80">
                {tuiPrompt.lines.join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* TUI command limitation notice. The chat view sends each textarea
          submission as a single agent prompt, so it can't drive TUI slash
          commands like /model or /vim that need an interactive sub-menu
          (arrow-key selection etc.). Tell the user to switch to the agent
          view for those. */}
      {!tuiHintDismissed && (
        <div className="border-t border-zinc-200 bg-amber-50/60 px-4 py-2">
          <div className="mx-auto flex max-w-3xl items-start gap-2 text-[12px] text-amber-900">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <p className="flex-1 leading-relaxed">
              {t('chat:tui_command_hint', {
                defaultValue: 'TUI commands like /model and /vim aren\'t supported here — switch to the Agent view to use them.',
              })}
            </p>
            <button
              type="button"
              onClick={() => setTuiHintDismissed(true)}
              aria-label={t('common:action.dismiss', { defaultValue: 'Dismiss' })}
              className="shrink-0 rounded p-0.5 text-amber-700 hover:bg-amber-100 hover:text-amber-900"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-zinc-200 bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            // Default 4 rows, grows up to 4, scrolls past that. Comfortable
            // middle ground for both short prompts and paste-of-stack-traces.
            rows={Math.min(4, Math.max(4, input.split('\n').length))}
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

// Stable React key for a rendered list item: prefer the result's seq so a
// tool card keeps its key across the call→result grouping transition.
function itemKey(item, idx) {
  const seq = item.result?.seq ?? item.message?.seq ?? item.call?.seq;
  return seq != null ? `s${seq}` : `i${idx}`;
}

const ChatItem = memo(function ChatItem({ item, onKeys, onText }) {
  if (item.kind === 'message') return <ChatBubble message={item.message} />;
  if (item.kind === 'error') return <ErrorBubble message={item.message} />;
  if (item.kind === 'tool_call') return <ToolItem call={item.call} result={null} onKeys={onKeys} onText={onText} />;
  if (item.kind === 'tool_result') return <ToolItem call={null} result={item.result} onKeys={onKeys} onText={onText} />;
  return <ToolItem call={item.call} result={item.result} onKeys={onKeys} onText={onText} />;
}, (a, b) => (
  // Identity-based bail-out: renderedItems rebuilds the wrapper objects on
  // every messages change, but the underlying message objects keep stable
  // identity (mergeHistory appends without cloning), so an unchanged bubble /
  // tool card compares equal and skips re-render entirely. This is what makes
  // the 1s nowTick tick and per-keystroke input updates cheap on long pages.
  a.item === b.item
  || (a.item.kind === b.item.kind
    && a.item.message === b.item.message
    && a.item.call === b.item.call
    && a.item.result === b.item.result
    && a.onKeys === b.onKeys
    && a.onText === b.onText)
));

/**
 * A tool entry that may be an agent-question prompt (AskUserQuestion-style):
 * question calls render as an interactive confirmation card; everything else
 * falls back to the plain tool card.
 */
function ToolItem({ call, result, onKeys, onText }) {
  const questions = useMemo(
    () => parseQuestionTool(call?.tool, call?.content),
    [call?.tool, call?.content],
  );
  if (questions) {
    return <QuestionCard result={result} questions={questions} onKeys={onKeys} onText={onText} />;
  }
  return <ToolCard call={call} result={result} />;
}

/**
 * Interactive confirmation card for agent-question tool calls (AskUserQuestion
 * and friends). The agent's TUI shows an option picker for these; in chat mode
 * the same questions render here and each answer is replayed as terminal
 * keystrokes (ArrowDown/ArrowUp to highlight, Space to toggle multi-select,
 * Enter to confirm) over the WS input channel — exactly what the user would
 * press in the Agent view. Questions are answered sequentially, mirroring the
 * TUI's one-picker-at-a-time flow. Once the matching tool_result arrives the
 * card switches to an answered, read-only state.
 */
const QuestionCard = memo(function QuestionCard({ result, questions, onKeys, onText }) {
  const { t } = useTranslation();
  // Submitted answers, one slot per question: option index (single-select),
  // Set of indices (multi-select, after submit) or text (free-text).
  // Optimistic — the tool_result entry (`result`) is the authoritative
  // answered marker from the server.
  const [answers, setAnswers] = useState(() => questions.map(() => undefined));
  // Multi-select checkbox state before submit (kept separate so toggling does
  // not advance the sequential active-question pointer).
  const [multiSel, setMultiSel] = useState(() => questions.map(() => new Set()));
  const [multiCursor, setMultiCursor] = useState(() => questions.map(() => 0));
  const [freeText, setFreeText] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const answered = Boolean(result);

  const activeIdx = answered ? -1 : answers.findIndex((a) => a === undefined);

  const markAnswered = (i, value) => {
    setAnswers((prev) => prev.map((a, k) => (k === i ? value : a)));
  };

  // Single-select: highlight option optIdx from the top of the list, confirm.
  const answerSingle = (i, optIdx) => {
    const parts = [];
    for (let k = 0; k < optIdx; k += 1) parts.push(KEY_ARROW_DOWN);
    parts.push(KEY_ENTER);
    onKeys?.(parts);
    markAnswered(i, optIdx);
  };

  // Multi-select: move the highlight from the last touched option, toggle it
  // with Space; a separate submit button confirms the whole set with Enter.
  const toggleMulti = (i, optIdx) => {
    const from = multiCursor[i] ?? 0;
    const parts = [];
    for (let k = 0; k < Math.abs(optIdx - from); k += 1) {
      parts.push(optIdx > from ? KEY_ARROW_DOWN : KEY_ARROW_UP);
    }
    parts.push(KEY_SPACE);
    onKeys?.(parts);
    setMultiCursor((prev) => prev.map((c, k) => (k === i ? optIdx : c)));
    setMultiSel((prev) => prev.map((sel, k) => {
      if (k !== i) return sel;
      const next = new Set(sel);
      if (next.has(optIdx)) next.delete(optIdx); else next.add(optIdx);
      return next;
    }));
  };

  const submitMulti = (i) => {
    onKeys?.([KEY_ENTER]);
    markAnswered(i, multiSel[i] instanceof Set ? multiSel[i] : new Set());
  };

  const sendFreeText = (i) => {
    const text = freeText.trim();
    if (!text) return;
    onText?.(text);
    markAnswered(i, text);
    setFreeText('');
  };

  const hasResultRecord = answered && Boolean(result?.content);

  return (
    <div className="flex justify-start pr-2 sm:pr-12">
      <div className="w-full max-w-[80%] overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-[13px] text-zinc-700">
          <HelpCircle className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <span className="truncate font-medium">
            {t('chat:question_title', { defaultValue: 'Agent needs your confirmation' })}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-zinc-400">
            {answered
              ? t('chat:question_answered', { defaultValue: 'Answered' })
              : t('chat:question_pending', { defaultValue: 'Waiting for your answer' })}
          </span>
        </div>
        <div className="space-y-2.5 px-3 py-2.5">
          {questions.map((q, i) => {
            const isActive = i === activeIdx;
            const answer = answers[i];
            const locked = answered || i !== activeIdx;
            const multiCount = q.multiSelect && (answers[i] instanceof Set)
              ? [...answers[i]].map((j) => q.options[j]?.label).filter(Boolean)
              : null;
            return (
              <div
                key={i}
                className={`rounded-lg border px-3 py-2.5 ${isActive ? 'border-zinc-300 bg-white' : 'border-transparent bg-zinc-50'}`}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  {questions.length > 1 && (
                    <span className="shrink-0 text-[10px] text-zinc-400">
                      {t('chat:question_progress', { current: i + 1, total: questions.length })}
                    </span>
                  )}
                  {q.header && (
                    <span className="truncate rounded bg-zinc-200/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">
                      {q.header}
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-wrap break-words text-[13.5px] font-medium text-zinc-800">{q.text}</p>

                {q.options.length > 0 ? (
                  <>
                    <div className="mt-2 space-y-1.5">
                      {q.options.map((opt, j) => {
                        const selected = q.multiSelect
                          ? (multiSel[i]?.has(j) ?? false)
                          : answer === j;
                        return (
                          <button
                            key={j}
                            type="button"
                            disabled={locked}
                            title={locked ? undefined : opt.description || opt.label}
                            onClick={() => (q.multiSelect ? toggleMulti(i, j) : answerSingle(i, j))}
                            className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                              locked
                                ? 'cursor-default border-transparent bg-zinc-50 opacity-60'
                                : 'cursor-pointer border-zinc-200 bg-white hover:border-zinc-400 hover:bg-zinc-100'
                            } ${consoleButtonFocusClass}`}
                          >
                            <span
                              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border ${
                                q.multiSelect ? 'rounded' : 'rounded-full'
                              } ${selected ? 'border-zinc-900 bg-zinc-900' : 'border-zinc-300 bg-white'}`}
                            >
                              {selected && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium text-zinc-800">{opt.label}</span>
                              {opt.description && (
                                <span className="mt-0.5 block text-[12px] text-zinc-500">{opt.description}</span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {q.multiSelect && isActive && (
                      <div className="mt-2 flex items-center gap-2">
                        <p className="min-w-0 flex-1 text-[11px] text-zinc-400">
                          {t('chat:question_multi_hint', { defaultValue: 'Multiple choice: click to toggle, then submit.' })}
                        </p>
                        <button
                          type="button"
                          onClick={() => submitMulti(i)}
                          disabled={(multiSel[i]?.size ?? 0) === 0}
                          className={`inline-flex h-8 shrink-0 items-center rounded-md bg-zinc-900 px-3 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
                        >
                          {t('chat:question_multi_submit', { defaultValue: 'Submit selection' })}
                        </button>
                      </div>
                    )}
                    {!q.multiSelect && isActive && (
                      <p className="mt-1.5 text-[11px] text-zinc-400">
                        {t('chat:question_hint', { defaultValue: 'Click an option to answer — same as the terminal menu.' })}
                      </p>
                    )}
                  </>
                ) : (
                  // Option-less question tool (e.g. Cline ask_followup_question):
                  // answer with free text, sent as a normal prompt.
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="text"
                      value={freeText}
                      onChange={(e) => setFreeText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          sendFreeText(i);
                        }
                      }}
                      disabled={locked}
                      placeholder={t('chat:question_free_placeholder', { defaultValue: 'Type your answer…' })}
                      className={`${consoleInputClass} h-9 min-w-0 flex-1 py-1.5 text-[13px] disabled:opacity-50`}
                    />
                    <button
                      type="button"
                      onClick={() => sendFreeText(i)}
                      disabled={locked || !freeText.trim()}
                      className={`inline-flex h-9 shrink-0 items-center rounded-md bg-zinc-900 px-3 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
                    >
                      {t('chat:question_send_answer', { defaultValue: 'Send answer' })}
                    </button>
                  </div>
                )}

                {/* Local answer echo (raw record lives in the result section). */}
                {!q.multiSelect && typeof answer === 'number' && q.options[answer] && (
                  <p className="mt-1.5 text-[11px] text-emerald-600">
                    {t('chat:question_answered', { defaultValue: 'Answered' })}: {q.options[answer].label}
                  </p>
                )}
                {multiCount && (
                  <p className="mt-1.5 text-[11px] text-emerald-600">
                    {t('chat:question_answered', { defaultValue: 'Answered' })}: {multiCount.join(', ')}
                  </p>
                )}
                {typeof answer === 'string' && answer && (
                  <p className="mt-1.5 break-words text-[11px] text-emerald-600">
                    {t('chat:question_answered', { defaultValue: 'Answered' })}: {answer}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {hasResultRecord && (
          <div className="border-t border-zinc-200 px-3 py-2">
            <button
              type="button"
              onClick={() => setRawOpen((o) => !o)}
              className={`text-[11px] text-zinc-400 hover:text-zinc-600 ${consoleButtonFocusClass}`}
            >
              {rawOpen
                ? t('chat:question_raw_hide', { defaultValue: 'Hide raw record' })
                : t('chat:question_raw', { defaultValue: 'Show raw record' })}
            </button>
            {rawOpen && (
              <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-100 p-2 font-mono text-[12px] text-zinc-700">
                {result.content}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * LLM failure event (the proxy records one when the upstream rejects the
 * request — 429 rate limit, 5xx, gateway down — or when the CLI's quota is
 * exhausted). Renders inline so the dialog view immediately shows "request
 * failed" instead of flashing "Agent is thinking…" until the idle timeout.
 */
function ErrorBubble({ message }) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-start pr-2 sm:pr-12">
      <div className="flex max-w-[80%] items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-[13px] text-red-800">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
        <div className="min-w-0">
          <p className="font-medium">{t('chat:llm_error_label', { defaultValue: 'LLM request failed' })}</p>
          {message.content && (
            <p className="mt-0.5 break-words font-mono text-[12px] text-red-700/90">{message.content}</p>
          )}
        </div>
      </div>
    </div>
  );
}

const ChatBubble = memo(function ChatBubble({ message }) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  // 超长消息展示兜底：默认只渲染开头 LONG_MESSAGE_CHARS 字符（纯展示层截断，
  // 服务端数据完整），点「展开完整消息」再渲染全文——单条几百 KB 的回复一次
  // 性走 markdown/高亮管线可独自卡死页面，翻页只减条数不减单条渲染量。
  const [expanded, setExpanded] = useState(false);
  const contentTruncated = !expanded && message.content.length > LONG_MESSAGE_CHARS;
  const shownContent = contentTruncated ? message.content.slice(0, LONG_MESSAGE_CHARS) : message.content;

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
        {isUser ? (
          <pre className={`whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-2.5 text-zinc-800`}>
            {shownContent}
          </pre>
        ) : (
          <MarkdownView className="text-[13.5px]">
            {shownContent}
          </MarkdownView>
        )}
        {contentTruncated && (
          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            <span>{t('chat:long_truncated', { defaultValue: 'Very long message — showing the first part only.' })}</span>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className={`inline-flex h-6 items-center rounded-md border border-zinc-200 px-2 text-[11px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 ${consoleButtonFocusClass}`}
            >
              {t('chat:long_expand', { defaultValue: 'Show full message' })}
            </button>
          </div>
        )}
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
});

const ToolCard = memo(function ToolCard({ call, result }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // 工具结果超长同样只渲染开头（数据完整）：结果常是整个文件的 dump，
  // 展开卡片后一次性塞进 <pre> 也会卡。点「展开」后才渲染全文。
  const [resultExpanded, setResultExpanded] = useState(false);
  const resultText = result?.content ? String(result.content) : '';
  const resultTruncated = !resultExpanded && resultText.length > LONG_MESSAGE_CHARS;
  const shownResult = resultTruncated ? resultText.slice(0, LONG_MESSAGE_CHARS) : resultText;
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
                  {shownResult}
                </pre>
                {resultTruncated && (
                  <button
                    type="button"
                    onClick={() => setResultExpanded(true)}
                    className={`mt-1 inline-flex h-6 items-center rounded-md border border-zinc-200 px-2 text-[11px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 ${consoleButtonFocusClass}`}
                  >
                    {t('chat:long_expand', { defaultValue: 'Show full message' })}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
});

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
