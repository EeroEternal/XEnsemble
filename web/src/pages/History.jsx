import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, RotateCcw, Bot, Folder, Clock, FileText, ChevronLeft, ChevronRight,
  ChevronDown, Lightbulb, User, RefreshCw, Loader2,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import SelectMenu from '../components/SelectMenu';
import {
  consoleButtonFocusClass,
  consoleEmptyStateClass,
  consoleToolbarInputClass,
  consoleStatusBadgeClass,
} from '../lib/consoleTokens';

const PAGE_SIZE = 20;

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
 * Inline distilled-conversation summary shown when a history row is expanded.
 * Fetches GET .../conversation and renders overview / key decisions / files /
 * distilled turns, with a manual Refresh (POST .../conversation/refresh).
 */
function ConversationDetail({ sessionId }) {
  const { t } = useTranslation();
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/conversation`);
      if (res.status === 404) {
        setNotFound(true);
        setView(null);
        return;
      }
      if (!res.ok) {
        setError(t('sessions:conversation.load_failed', { defaultValue: 'Failed to load conversation' }));
        return;
      }
      const data = await res.json();
      setView(data);
      setNotFound(false);
    } catch {
      setError(t('sessions:conversation.load_failed', { defaultValue: 'Failed to load conversation' }));
    } finally {
      setLoading(false);
    }
  }, [sessionId, t]);

  useEffect(() => { void load(); }, [load]);

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
      className={`inline-flex h-7 items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-50 ${consoleButtonFocusClass}`}
    >
      {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      {refreshing
        ? t('sessions:conversation.refreshing', { defaultValue: 'Refreshing…' })
        : t('sessions:conversation.refresh', { defaultValue: 'Refresh' })}
    </button>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 border-t border-zinc-100 px-4 py-6 text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (notFound || !view) {
    return (
      <div className="flex flex-col items-start gap-3 border-t border-zinc-100 px-4 py-4">
        <p className="text-sm font-medium text-zinc-700">
          {t('sessions:conversation.empty_title', { defaultValue: 'No conversation yet' })}
        </p>
        <p className="text-xs text-zinc-400">
          {t('sessions:conversation.empty_hint', { defaultValue: 'Run the agent for a few turns, then refresh to generate a summary.' })}
        </p>
        <div className="flex items-center gap-3">
          {refreshBtn}
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </div>
    );
  }

  const summary = view.summary || {};
  const overview = summary.overview;
  const keyDecisions = Array.isArray(summary.keyDecisions) ? summary.keyDecisions : [];
  const filesTouched = Array.isArray(summary.filesTouched) ? summary.filesTouched : [];
  const summaryTurns = Array.isArray(summary.turns) ? summary.turns : [];
  const rawTurns = Array.isArray(view.turns) ? view.turns : [];
  // A+B: turns come live from the structured chat transcript (view.turns);
  // legacy summary.turns kept only as a fallback for old rows.
  const turns = rawTurns.length > 0 ? rawTurns : summaryTurns;

  return (
    <div className="flex flex-col gap-3 border-t border-zinc-100 bg-zinc-50/60 px-4 py-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          {t('sessions:conversation.summary', { defaultValue: 'Conversation summary' })}
        </p>
        <div className="flex items-center gap-3">
          {error && <span className="text-xs text-red-600">{error}</span>}
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

      {turns.length > 0 && (
        <div className="flex flex-col gap-2">
          {turns.map((turn, i) => {
            const isUser = turn.role === 'user';
            const text = turn.summary ?? turn.text ?? '';
            const tools = Array.isArray(turn.tools) ? turn.tools : [];
            return (
              <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div className={`flex max-w-[85%] flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
                  <div className={`flex items-center gap-1 text-[10px] font-medium ${isUser ? 'text-zinc-500' : 'text-zinc-400'}`}>
                    {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                    {isUser
                      ? t('sessions:conversation.you', { defaultValue: 'You' })
                      : t('sessions:conversation.agent', { defaultValue: 'Agent' })}
                  </div>
                  <div className={`rounded-lg px-3 py-1.5 text-sm ${isUser ? 'bg-zinc-100 text-zinc-900' : 'bg-white text-zinc-900'}`}>
                    <p className="whitespace-pre-wrap">{text}</p>
                  </div>
                  {tools.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {tools.map((tool, j) => (
                        <span key={j} className="rounded bg-zinc-200/60 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                          {tool}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function History({ agents, projects, className = '', 'aria-hidden': ariaHidden }) {
  const { t } = useTranslation();

  const [status, setStatus] = useState('');
  const [agentId, setAgentId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
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
      params.set('sort', 'created_at:desc');
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

  const resetFilters = useCallback(() => {
    setStatus('');
    setAgentId('');
    setProjectId('');
    setSearch('');
    setPage(1);
  }, []);

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

  return (
    <div className={`flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-surface ${className}`} aria-hidden={ariaHidden}>
      {/* Filter bar */}
      <div className="shrink-0 border-b border-zinc-200 bg-surface px-4 py-3">
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
      <div className="min-h-0 flex-1 overflow-y-auto console-scroll-hidden px-4 py-3">
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
              const expanded = expandedId === s.id;
              return (
                <div
                  key={s.id}
                  className={`rounded-lg border bg-surface transition-colors ${expanded ? 'border-zinc-300' : 'border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50'} ${isExited ? 'opacity-60 hover:opacity-100' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : s.id)}
                    aria-expanded={expanded}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left ${consoleButtonFocusClass}`}
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
                      <ChevronDown className={`h-4 w-4 text-zinc-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                    </div>
                  </button>
                  {expanded && <ConversationDetail sessionId={s.id} />}
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
    </div>
  );
}
