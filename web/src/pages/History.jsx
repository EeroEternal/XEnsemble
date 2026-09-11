import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Search, RotateCcw, Bot, Folder, Clock, FileText, ChevronLeft, ChevronRight,
  ChevronDown, Lightbulb, User, RefreshCw, Loader2, X, ChevronsDown, Wrench, Sparkles, Trash2,
} from 'lucide-react';
import { apiFetch, getAccessToken } from '../lib/api';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { useToast } from '../components/Toast';
import SelectMenu from '../components/SelectMenu';
import MarkdownView from '../components/Markdown';
import PageHeader from '../components/PageHeader';
import { extractSkillFromSession } from '../lib/skillsApi';
import {
  consoleAdminPageClass,
  consoleButtonFocusClass,
  consoleEmptyStateClass,
  consoleToolbarInputClass,
  consoleStatusBadgeClass,
  consoleIconButtonClass,
} from '../lib/consoleTokens';

const PAGE_SIZE = 20;
const CONVERSATION_PAGE_TURNS = 40;

const STATUS_OPTIONS = [
  { value: '', labelKey: 'all' },
  { value: 'running', labelKey: 'running' },
  { value: 'idle', labelKey: 'idle' },
  { value: 'exited', labelKey: 'exited' },
];

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

function statusDotClass(status) {
  if (status === 'running') return 'bg-emerald-500 animate-pulse';
  if (status === 'idle') return 'bg-amber-400';
  return 'bg-zinc-300';
}

/**
 * Group flat turns into exchanges: each user turn opens a group, and the
 * assistant turns that follow it belong to that group. A leading assistant
 * turn with no preceding user turn forms its own group.
 */
function groupTurns(turns) {
  const groups = [];
  let current = null;
  for (const turn of turns) {
    if (turn.role === 'user') {
      current = { user: turn, replies: [] };
      groups.push(current);
    } else if (current) {
      current.replies.push(turn);
    } else {
      current = { user: null, replies: [turn] };
      groups.push(current);
    }
  }
  return groups;
}

function ToolCard({ tool }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const name = tool.tool || 'tool';
  const args = tool.args;
  const result = tool.result;
  const hasDetail = Boolean(args) || Boolean(result);
  return (
    <div className="w-full max-w-[85%] overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-zinc-700 ${hasDetail ? 'cursor-pointer hover:bg-zinc-100' : 'cursor-default'} ${consoleButtonFocusClass}`}
      >
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Wrench className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <span className="truncate font-medium">{name}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-200 px-3 py-2">
          {args ? (
            <div>
              <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                {t('sessions:conversation.tool_args', { defaultValue: 'Arguments' })}
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-100 p-2 font-mono text-[12px] text-zinc-700">
                {formatArgs(args)}
              </pre>
            </div>
          ) : null}
          {result ? (
            <div>
              <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                {t('sessions:conversation.tool_result_label', { defaultValue: 'Result' })}
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-100 p-2 font-mono text-[12px] text-zinc-700">
                {result}
              </pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// Pretty-print tool-call argument JSON when possible.
function formatArgs(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return raw || '';
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function TurnBubble({ turn, isUser }) {
  const { t } = useTranslation();
  const text = turn.summary ?? turn.text ?? '';
  const tools = Array.isArray(turn.tools) ? turn.tools : [];
  return (
    <div className={`flex w-full flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <div className={`flex items-center gap-1 text-[10px] font-medium ${isUser ? 'text-zinc-500' : 'text-zinc-400'}`}>
        {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
        {isUser
          ? t('sessions:conversation.you', { defaultValue: 'You' })
          : t('sessions:conversation.agent', { defaultValue: 'Agent' })}
      </div>
      {text && (
        <div className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${isUser ? 'border border-zinc-200 bg-zinc-50 text-zinc-800' : 'text-zinc-800'}`}>
          <MarkdownView>{text}</MarkdownView>
        </div>
      )}
      {tools.length > 0 && (
        <div className={`flex w-full flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}>
          {tools.map((tool, j) => (
            typeof tool === 'string'
              ? (
                <span key={j} className="rounded bg-zinc-200/60 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                  {tool}
                </span>
              )
              : <ToolCard key={j} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Right-side drawer showing one session's conversation detail.
 * Fetches GET .../conversation, groups turns by user question, renders
 * summary + grouped turns with a "load more" reveal.
 */
function ConversationDrawer({ session, onClose }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState(null);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [allTurns, setAllTurns] = useState([]);
  const [totalTurns, setTotalTurns] = useState(0);
  const [hasMoreTurns, setHasMoreTurns] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mounted, setMounted] = useState(false);
  const sessionId = session.id;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setView(null);
    setAllTurns([]);
    setTotalTurns(0);
    setHasMoreTurns(false);
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/conversation?limit=${CONVERSATION_PAGE_TURNS}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        setError(t('sessions:conversation.load_failed', { defaultValue: 'Failed to load conversation' }));
        return;
      }
      const data = await res.json();
      setView(data);
      const turns = Array.isArray(data.turns) ? data.turns : [];
      setAllTurns(turns);
      // total 为对话轮数（user 消息条数）；fallback 保持同口径
      setTotalTurns(Number(data.total) || turns.filter((t) => t && t.role === 'user').length);
      setHasMoreTurns(Boolean(data.hasMore));
      setNotFound(false);
    } catch {
      setError(t('sessions:conversation.load_failed', { defaultValue: 'Failed to load conversation' }));
    } finally {
      setLoading(false);
    }
  }, [sessionId, t]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreTurns) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/conversation?offset=${allTurns.length}&limit=${CONVERSATION_PAGE_TURNS}`);
      if (!res.ok) throw new Error('load_more_failed');
      const data = await res.json();
      const more = Array.isArray(data.turns) ? data.turns : [];
      setAllTurns((prev) => [...prev, ...more]);
      // total 为对话轮数（user 消息条数）；fallback 保持同口径
      setTotalTurns(Number(data.total) || more.filter((t) => t && t.role === 'user').length + allTurns.filter((t) => t && t.role === 'user').length);
      setHasMoreTurns(Boolean(data.hasMore));
    } catch {
      // keep hasMore so the user can retry
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMoreTurns, allTurns.length, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates: re-fetch when the backend broadcasts a summary update for
  // this session (P2 Scheduler / manual refresh). Silent, no toast.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es = null;
    let closed = false;
    let reconnectTimer = null;
    const base = import.meta.env.VITE_API_BASE_URL
      || (typeof window !== 'undefined' ? window.location.origin : '');
    const connect = () => {
      const token = getAccessToken();
      es = new EventSource(`${base}/api/v1/events?access_token=${encodeURIComponent(token || '')}`);
      es.addEventListener('message', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'session_conversation_updated' && data.sessionId === sessionId) {
            void load();
          }
        } catch { /* ignore invalid data */ }
      });
      es.addEventListener('error', () => {
        es?.close();
        if (closed) return;
        reconnectTimer = setTimeout(connect, 3000);
      });
    };
    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [sessionId, load]);

  // Mount animation + Escape to close.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/conversation/refresh`, {
        method: 'POST',
      });
      if (res.status === 409) {
        setError(t('sessions:conversation.refresh_in_progress', { defaultValue: 'Refresh already in progress' }));
        return;
      }
      if (res.status === 503) {
        setError(t('sessions:conversation.llm_not_configured', { defaultValue: 'LLM analysis is not configured' }));
        return;
      }
      if (!res.ok) {
        setError(t('sessions:conversation.refresh_failed', { defaultValue: 'Failed to refresh conversation' }));
        return;
      }
      const data = await res.json();
      setView(data);
      setNotFound(false);
    } catch {
      setError(t('sessions:conversation.refresh_failed', { defaultValue: 'Failed to refresh conversation' }));
    } finally {
      setRefreshing(false);
    }
  }, [sessionId, refreshing, t]);

  const refreshBtn = (
    <button
      type="button"
      onClick={refresh}
      disabled={refreshing}
      className={`inline-flex h-7 items-center gap-2 rounded-md border border-zinc-200 bg-surface px-2.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-50 ${consoleButtonFocusClass}`}
    >
      {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      {refreshing
        ? t('sessions:conversation.refreshing', { defaultValue: 'Refreshing…' })
        : t('sessions:conversation.refresh', { defaultValue: 'Refresh' })}
    </button>
  );

  // P3: 从当前会话手动提炼 skill（US-3，直跳 L4）。成功提示并跳转我的技能页。
  const extractSkill = useCallback(async () => {
    if (extracting) return;
    setExtracting(true);
    setError(null);
    try {
      await extractSkillFromSession(sessionId);
      showToast('success', t('skills:extract_from_session_done', { defaultValue: 'Skill draft created.' }));
      window.dispatchEvent(new CustomEvent('xensemble:skills_changed'));
    } catch (err) {
      setError(t('skills:extract_failed', { defaultValue: 'Failed to extract skill.' }));
      console.error('[skill] extract failed', err);
    } finally {
      setExtracting(false);
    }
  }, [extracting, sessionId, showToast, t]);

  const extractBtn = (
    <button
      type="button"
      onClick={extractSkill}
      disabled={extracting}
      title={t('skills:extract_from_session', { defaultValue: 'Extract as Skill' })}
      className={`inline-flex h-7 items-center gap-2 rounded-md border border-zinc-200 bg-surface px-2.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-50 ${consoleButtonFocusClass}`}
    >
      {extracting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
      {extracting
        ? t('skills:extract_from_session_loading', { defaultValue: 'Extracting…' })
        : t('skills:extract_from_session', { defaultValue: 'Extract as Skill' })}
    </button>
  );

  const title = session.title?.trim() || t('sessions:history.untitled', { defaultValue: 'Untitled session' });
  const summary = view?.summary || {};
  const overview = summary.overview;
  const keyDecisions = Array.isArray(summary.keyDecisions) ? summary.keyDecisions : [];
  const filesTouched = Array.isArray(summary.filesTouched) ? summary.filesTouched : [];
  const summaryTurns = Array.isArray(summary.turns) ? summary.turns : [];
  // 真正分页：渲染累计加载的 turns（首页 + 后续页）；老数据无 chat transcript 时回退 summary.turns
  const turns = allTurns.length > 0 ? allTurns : summaryTurns;
  const groups = useMemo(() => groupTurns(turns), [turns]);

  return (
    <div className="fixed inset-0 z-[120]" role="dialog" aria-modal="true" aria-label={title}>
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${mounted ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div className={`absolute right-0 top-0 flex h-full w-full max-w-[720px] flex-col border-l border-zinc-200 bg-surface shadow-2xl transition-transform duration-200 ${mounted ? 'translate-x-0' : 'translate-x-full'}`}>
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-zinc-900">{title}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
              <span className="inline-flex min-w-0 items-center gap-1">
                <Bot className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{session.agentId}</span>
              </span>
              {session.projectName && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <Folder className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                  <span className="truncate">{session.projectName}</span>
                </span>
              )}
              <span className="shrink-0">{formatRelativeTime(session.createdAt)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`${consoleIconButtonClass} shrink-0`}
            aria-label={t('sessions:conversation.close', { defaultValue: 'Close' })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover px-4 py-4">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (notFound || !view) ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm font-medium text-zinc-700">
                {t('sessions:conversation.empty_title', { defaultValue: 'No conversation yet' })}
              </p>
              <p className="max-w-xs text-xs text-zinc-400">
                {t('sessions:conversation.empty_hint', { defaultValue: 'Run the agent for a few turns, then refresh to generate a summary.' })}
              </p>
              <div className="flex items-center gap-3">
                {refreshBtn}
                {error && <span className="text-xs text-red-600">{error}</span>}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Summary toolbar */}
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  {t('sessions:conversation.summary', { defaultValue: 'Conversation summary' })}
                </p>
                <div className="flex items-center gap-3">
                  {error && <span className="text-xs text-red-600">{error}</span>}
                  {extractBtn}
                  {refreshBtn}
                </div>
              </div>

              {overview && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    {t('sessions:conversation.overview', { defaultValue: 'Overview' })}
                  </p>
                  <p className="mt-1 text-sm text-zinc-700">{overview}</p>
                </div>
              )}

              {keyDecisions.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setDecisionsOpen((v) => !v)}
                    className={`flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-600 ${consoleButtonFocusClass}`}
                  >
                    {decisionsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    <Lightbulb className="h-3.5 w-3.5" />
                    {t('sessions:conversation.key_decisions', { defaultValue: 'Key decisions' })}
                  </button>
                  {decisionsOpen && (
                    <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-zinc-700">
                      {keyDecisions.map((d, i) => <li key={i}>{d}</li>)}
                    </ul>
                  )}
                </div>
              )}

              {filesTouched.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setFilesOpen((v) => !v)}
                    className={`flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-600 ${consoleButtonFocusClass}`}
                  >
                    {filesOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    <FileText className="h-3.5 w-3.5" />
                    {t('sessions:conversation.files_touched', { defaultValue: 'Files touched' })}
                  </button>
                  {filesOpen && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {filesTouched.map((f, i) => (
                        <span key={i} className="rounded bg-zinc-200/70 px-2 py-0.5 font-mono text-xs text-zinc-700">
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Grouped turns */}
              {groups.length > 0 ? (
                <div className="flex flex-col gap-4">
                  {totalTurns > 0 && (
                    <p className="text-[11px] text-zinc-400">
                      {t('sessions:conversation.showing_groups', { shown: groups.filter((g) => g.user).length, total: totalTurns, defaultValue: 'Showing {{shown}} of {{total}} exchanges' })}
                    </p>
                  )}
                  {groups.map((g, i) => (
                    <div key={i} className="flex flex-col gap-2 border-l-2 border-zinc-200 pl-3">
                      {g.user && <TurnBubble turn={g.user} isUser />}
                      {g.replies.map((r, j) => <TurnBubble key={j} turn={r} isUser={false} />)}
                    </div>
                  ))}
                  {hasMoreTurns && (
                    <button
                      type="button"
                      onClick={loadMore}
                      disabled={loadingMore}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 bg-surface px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-50 ${consoleButtonFocusClass}`}
                    >
                      {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronsDown className="h-3.5 w-3.5" strokeWidth={1.75} />}
                      {t('sessions:conversation.load_more', { count: CONVERSATION_PAGE_TURNS, defaultValue: 'Show more turns' })}
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-sm text-zinc-400">
                  {t('sessions:conversation.empty_title', { defaultValue: 'No conversation yet' })}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function History({ agents, projects, active = true, className = '', 'aria-hidden': ariaHidden }) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [status, setStatus] = useState('');
  const [agentId, setAgentId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const requestIdRef = useRef(0);

  // Debounce title search (300ms).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    const id = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('withStats', 'true');
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      params.set('sort', 'status_created:desc');
      if (status) params.set('status', status);
      if (agentId) params.set('agentId', agentId);
      if (projectId) params.set('projectId', projectId);
      if (debouncedSearch) params.set('q', debouncedSearch);

      const res = await apiFetch(`/api/v1/sessions?${params.toString()}`);
      if (!res.ok) {
        if (id === requestIdRef.current) {
          setError(t('sessions:history.load_failed', { defaultValue: 'Failed to load history' }));
        }
        return;
      }
      const json = await res.json();
      if (id === requestIdRef.current) {
        setData({ items: json.items || [], total: Number(json.total) || 0 });
      }
    } catch {
      if (id === requestIdRef.current) {
        setError(t('sessions:history.load_failed', { defaultValue: 'Failed to load history' }));
      }
    } finally {
      if (id === requestIdRef.current) setLoading(false);
    }
  }, [status, agentId, projectId, debouncedSearch, page, t]);

  useEffect(() => { void load(); }, [load]);

  // The page stays mounted while hidden (off-route) — refetch every time the
  // user opens it so statuses / new sessions are never stale.
  const activeRef = useRef(active);
  useEffect(() => {
    if (active && !activeRef.current) {
      setPage(1);
      void load();
    }
    activeRef.current = active;
  }, [active, load]);

  const resetFilters = useCallback(() => {
    setStatus('');
    setAgentId('');
    setProjectId('');
    setSearch('');
    setPage(1);
  }, []);

  const handleDeleteSession = async (sessionId) => {
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || t('sessions:error.delete_session_failed', { defaultValue: 'Failed to delete session' }));
      }
      setData((prev) => ({ items: prev.items.filter((s) => s.id !== sessionId), total: Math.max(0, prev.total - 1) }));
      if (selectedId === sessionId) setSelectedId(null);
      showToast('success', t('sessions:toast.session_deleted', { defaultValue: 'Session deleted.' }));
    } catch (err) {
      showToast('error', err.message);
    }
  };

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  const agentOptions = useMemo(() => {
    const opts = [{ value: '', label: t('sessions:history.agent_all', { defaultValue: 'All agents' }) }];
    for (const a of agents || []) opts.push({ value: a.id, label: a.name || a.id });
    return opts;
  }, [agents, t]);

  const projectOptions = useMemo(() => {
    const opts = [{ value: '', label: t('sessions:history.project_all', { defaultValue: 'All projects' }) }];
    for (const p of projects || []) opts.push({ value: p.id, label: p.name || p.id });
    return opts;
  }, [projects, t]);

  const statusLabel = (value) => {
    const opt = STATUS_OPTIONS.find((o) => o.value === value);
    if (!opt) return '';
    return t(`sessions:history.status_${opt.labelKey}`, { defaultValue: opt.labelKey });
  };

  const selectedSession = data.items.find((s) => s.id === selectedId) || null;

  return (
    <div className={`${consoleAdminPageClass} px-4 sm:px-6 lg:px-8 py-6 ${className}`} aria-hidden={ariaHidden}>
      <PageHeader title={t('sessions:history.title', { defaultValue: 'Session history' })} />
      {/* Filter bar */}
      <div className="shrink-0 border-b border-zinc-200 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-44">
            <SelectMenu
              value={projectId}
              onChange={(v) => { setProjectId(v); setPage(1); }}
              options={projectOptions}
              placeholder={t('sessions:history.project_all', { defaultValue: 'All projects' })}
            />
          </div>
          <div className="w-44">
            <SelectMenu
              value={agentId}
              onChange={(v) => { setAgentId(v); setPage(1); }}
              options={agentOptions}
              placeholder={t('sessions:history.agent_all', { defaultValue: 'All agents' })}
            />
          </div>
          <div className="w-36">
            <SelectMenu
              value={status}
              onChange={(v) => { setStatus(v); setPage(1); }}
              options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: t(`sessions:history.status_${o.labelKey}`, { defaultValue: o.labelKey }) }))}
              placeholder={t('sessions:history.status_all', { defaultValue: 'All statuses' })}
            />
          </div>
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('sessions:history.search_placeholder', { defaultValue: 'Search title…' })}
              className={`${consoleToolbarInputClass} pl-8`}
            />
          </div>
          <button
            type="button"
            onClick={resetFilters}
            className={`inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 px-3 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 ${consoleButtonFocusClass}`}
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
            {t('sessions:history.reset', { defaultValue: 'Reset' })}
          </button>
        </div>
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto console-scroll-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <div className={`${consoleEmptyStateClass} h-full`}>
            <p className="text-sm text-zinc-500">{error}</p>
          </div>
        ) : data.items.length === 0 ? (
          <div className={`${consoleEmptyStateClass} h-full`}>
            <p className="text-sm text-zinc-500">{t('sessions:history.empty', { defaultValue: 'No sessions found' })}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {data.items.map((s) => {
              const isExited = s.status === 'exited';
              const stats = s.stats;
              const duration = formatDuration(stats?.durationMs);
              const title = s.title?.trim();
              return (
                <div
                  key={s.id}
                  className={`flex items-center rounded-lg border bg-surface transition-colors ${selectedId === s.id ? 'border-zinc-300' : 'border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50'} ${isExited ? 'opacity-60 hover:opacity-100' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    className={`flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left ${consoleButtonFocusClass}`}
                    aria-label={t('sessions:history.open_detail', { defaultValue: 'Open conversation' })}
                  >
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusDotClass(s.status)}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`truncate text-sm font-medium text-zinc-900 ${title ? '' : 'italic text-zinc-400'}`}>
                          {title || t('sessions:history.untitled', { defaultValue: 'Untitled session' })}
                        </span>
                        <span className={`${consoleStatusBadgeClass} rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500`}>
                          <Bot className="h-3 w-3" strokeWidth={1.75} />
                          {s.agentId}
                        </span>
                        {s.projectName && (
                          <span className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                            <Folder className="h-3 w-3" strokeWidth={1.75} />
                            {s.projectName}
                          </span>
                        )}
                      </div>
                      {stats && (
                        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
                          <span>{t('sessions:history.turns', { count: stats.turnCount, defaultValue: '{{count}} turns' })}</span>
                          {duration && (
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-3 w-3" strokeWidth={1.75} />
                              {duration}
                            </span>
                          )}
                          {typeof stats.filesTouched === 'number' && (
                            <span className="inline-flex items-center gap-1">
                              <FileText className="h-3 w-3" strokeWidth={1.75} />
                              {t('sessions:history.files', { count: stats.filesTouched, defaultValue: '{{count}} files' })}
                            </span>
                          )}
                          {isExited && s.exitCode != null && (
                            <span>{t('sessions:history.exit_code', { code: s.exitCode, defaultValue: 'exit {{code}}' })}</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-right">
                      <div>
                        <div className="text-xs text-zinc-400">{formatRelativeTime(s.createdAt)}</div>
                        <div className="mt-0.5 text-xs text-zinc-500">{statusLabel(s.status)}</div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-zinc-400" />
                    </div>
                  </button>
                  {isExited && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                      title={t('sessions:action.delete', { defaultValue: 'Delete' })}
                      className="mr-2 shrink-0 rounded-md p-2 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {!loading && data.total > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t border-zinc-200 bg-surface px-4 py-2.5">
          <span className="text-xs text-zinc-400">
            {t('sessions:history.total', { total: data.total, defaultValue: '{{total}} sessions' })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-100 disabled:pointer-events-none disabled:opacity-40 ${consoleButtonFocusClass}`}
              aria-label={t('sessions:history.prev', { defaultValue: 'Previous page' })}
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <span className="text-xs text-zinc-500">{page} / {totalPages}</span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-100 disabled:pointer-events-none disabled:opacity-40 ${consoleButtonFocusClass}`}
              aria-label={t('sessions:history.next', { defaultValue: 'Next page' })}
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}

      {selectedSession && createPortal(
        <ConversationDrawer session={selectedSession} onClose={() => setSelectedId(null)} />,
        document.body,
      )}
    </div>
  );
}
