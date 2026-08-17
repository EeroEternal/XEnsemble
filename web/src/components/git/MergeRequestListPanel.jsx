import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, GitPullRequest, Loader2, RefreshCw, Search } from 'lucide-react';
import { openExternal } from '../../lib/githubApi';
import * as gitApi from '../../lib/gitApi';
import { buttonClass } from '../../lib/buttonStyles';
import {
  consoleIconButtonClass,
  consoleButtonFocusClass,
  consoleInputClass,
} from '../../lib/consoleTokens';
import { useToast } from '../Toast';

const STATUS_META = {
  open: {
    dot: 'bg-emerald-500',
    pill: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20',
  },
  merged: {
    dot: 'bg-purple-500',
    pill: 'bg-purple-50 text-purple-700 ring-1 ring-inset ring-purple-600/20',
  },
  closed: {
    dot: 'bg-zinc-400',
    pill: 'bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-500/20',
  },
};

const FILTER_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

function formatRelative(ts) {
  if (!ts) return '-';
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '-';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return date.toLocaleDateString();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return date.toLocaleDateString();
}

export default function MergeRequestListPanel({ projectId, provider, onSelectMR, refreshTrigger, onCreatePR }) {
  const { showToast } = useToast();
  const [mergeRequests, setMergeRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncingId, setSyncingId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('open');
  const [searchQuery, setSearchQuery] = useState('');

  const label = provider === 'gitlab' ? 'Merge Requests' : 'Pull Requests';

  const fetchMRs = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await gitApi.listMergeRequests(projectId);
      const rows = data.merge_requests || data.pull_requests || data;
      setMergeRequests(Array.isArray(rows) ? rows : []);
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, showToast]);

  useEffect(() => {
    fetchMRs();
  }, [fetchMRs]);

  useEffect(() => {
    if (refreshTrigger > 0) fetchMRs();
  }, [refreshTrigger, fetchMRs]);

  const handleSync = useCallback(async (mrId) => {
    if (!projectId || !mrId) return;
    setSyncingId(mrId);
    try {
      const updated = await gitApi.syncMergeRequest(projectId, mrId);
      setMergeRequests((prev) => prev.map((mr) => (mr.id === mrId ? updated : mr)));
      showToast('success', `${provider === 'gitlab' ? 'Merge request' : 'Pull request'} synchronized.`);
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setSyncingId(null);
    }
  }, [projectId, provider, showToast]);

  const filteredMRs = useMemo(() => {
    let result = mergeRequests;
    if (statusFilter !== 'all') {
      result = result.filter((mr) => mr.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((mr) =>
        (mr.title || '').toLowerCase().includes(q) ||
        (mr.source_branch || mr.sourceBranch || '').toLowerCase().includes(q) ||
        String(mr.remote_mr_number || mr.remoteMrNumber || '').includes(q)
      );
    }
    return result;
  }, [mergeRequests, statusFilter, searchQuery]);

  const countByStatus = useMemo(() => {
    const counts = { all: mergeRequests.length, open: 0, merged: 0, closed: 0 };
    for (const mr of mergeRequests) {
      if (counts[mr.status] != null) counts[mr.status]++;
    }
    return counts;
  }, [mergeRequests]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 shrink-0 bg-white">
        <div className="flex items-center gap-1">
          {FILTER_OPTIONS.map((opt) => {
            const active = statusFilter === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setStatusFilter(opt.value)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-full transition-colors ${consoleButtonFocusClass} ${
                  active
                    ? 'bg-black text-white'
                    : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
                }`}
              >
                {opt.label}
                <span className={`ml-1 ${active ? 'text-white/60' : 'text-zinc-400'}`}>
                  {countByStatus[opt.value] ?? 0}
                </span>
              </button>
            );
          })}
        </div>
        <div className="relative flex-1 max-w-[200px] ml-auto">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search…"
            className={`w-full pl-8 pr-2 py-1 text-xs ${consoleInputClass}`}
          />
        </div>
        <button
          type="button"
          onClick={fetchMRs}
          disabled={loading}
          title={`Refresh ${label.toLowerCase()}`}
          aria-label={`Refresh ${label.toLowerCase()}`}
          className={consoleIconButtonClass}
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
        {onCreatePR && (
          <button
            type="button"
            onClick={onCreatePR}
            className={`${buttonClass('primary', 'sm')} h-7 px-3 text-xs ${consoleButtonFocusClass}`}
          >
            <GitPullRequest className="h-3.5 w-3.5 shrink-0" />
            New Pull Request
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-zinc-50">
        {loading ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-xs">Loading {label.toLowerCase()}…</span>
          </div>
        ) : filteredMRs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
              <GitPullRequest className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-700">
                {mergeRequests.length === 0 ? `No ${label.toLowerCase()} yet` : 'No matching results'}
              </p>
              <p className="mt-0.5 text-xs text-zinc-400">
                {mergeRequests.length === 0
                  ? (onCreatePR ? 'Create your first pull request to get started.' : 'Pull requests will appear here once created.')
                  : 'Try a different filter or search term.'}
              </p>
            </div>
            {mergeRequests.length === 0 && onCreatePR && (
              <button
                type="button"
                onClick={onCreatePR}
                className={buttonClass('primary', 'sm')}
              >
                <GitPullRequest className="h-3.5 w-3.5 mr-1.5 inline" />
                New Pull Request
              </button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {filteredMRs.map((mr) => {
              const meta = STATUS_META[mr.status] || STATUS_META.closed;
              const number = mr.remote_mr_number || mr.remoteMrNumber || mr.github_pr_number;
              const src = mr.source_branch || mr.sourceBranch;
              const tgt = mr.target_branch || mr.targetBranch;
              const remoteUrl = mr.remoteMrUrl || mr.remote_mr_url || mr.remote_url || mr.remoteUrl;
              return (
                <li
                  key={mr.id}
                  className="group relative flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-zinc-100/60 focus-within:bg-zinc-100/60"
                >
                  <button
                    type="button"
                    onClick={() => onSelectMR?.(mr)}
                    className={`absolute inset-0 z-0 ${consoleButtonFocusClass}`}
                    aria-label={`Open pull request${number != null ? ` #${number}` : ''}${mr.title ? `: ${mr.title}` : ''}`}
                  />
                  <span className={`relative z-10 mt-1.5 h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                  <div className="relative z-10 min-w-0 flex-1 pointer-events-none">
                    <div className="flex items-center gap-2 min-w-0">
                      {number != null && (
                        <span className="font-mono text-xs text-zinc-400 shrink-0">#{number}</span>
                      )}
                      <span className="truncate text-sm font-medium text-zinc-900" title={mr.title}>
                        {mr.title || 'Untitled'}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 min-w-0 text-[11px] text-zinc-500">
                      {src && (
                        <span className="font-mono truncate" title={src}>{src}</span>
                      )}
                      {src && tgt && (
                        <span className="text-zinc-300 shrink-0">{'→'}</span>
                      )}
                      {tgt && (
                        <span className="font-mono truncate" title={tgt}>{tgt}</span>
                      )}
                      {(src || tgt) && (
                        <span className="text-zinc-300 shrink-0">·</span>
                      )}
                      <span className="shrink-0 text-zinc-400">
                        {formatRelative(mr.created_at || mr.createdAt)}
                      </span>
                    </div>
                  </div>
                  <div className="relative z-10 flex items-center gap-1 shrink-0 pointer-events-none">
                    <span className={`pointer-events-none inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${meta.pill}`}>
                      {mr.status}
                    </span>
                    {remoteUrl && (
                      <button
                        type="button"
                        onClick={() => openExternal(remoteUrl)}
                        title={`Open on ${provider}`}
                        aria-label={`Open on ${provider}`}
                        className={`${consoleIconButtonClass} pointer-events-auto`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleSync(mr.id)}
                      disabled={syncingId === mr.id}
                      title="Sync status"
                      aria-label="Sync status"
                      className={`${consoleIconButtonClass} pointer-events-auto`}
                    >
                      {syncingId === mr.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
