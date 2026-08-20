import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, GitPullRequest, Loader2, Search } from 'lucide-react';
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
  const [statusFilter, setStatusFilter] = useState('open');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  // 当前用户在该仓库的写权限（merge/approve/close/reopen），来自列表接口
  const [permissions, setPermissions] = useState(null);

  const label = provider === 'gitlab' ? 'Merge Requests' : 'Pull Requests';

  const fetchMRs = useCallback(async (silent = false) => {
    if (!projectId) return;
    if (!silent) setLoading(true);
    try {
      const data = await gitApi.listMergeRequests(projectId);
      const rows = data.merge_requests || data.pull_requests || data;
      setMergeRequests(Array.isArray(rows) ? rows : []);
      setPermissions(data.permissions || null);
    } catch (err) {
      showToast('error', err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [projectId, showToast]);

  useEffect(() => {
    fetchMRs();
  }, [fetchMRs]);

  useEffect(() => {
    if (refreshTrigger > 0) fetchMRs();
  }, [refreshTrigger, fetchMRs]);

  // 定期轮询替代手动刷新按钮（静默刷新，不闪 loading），卸载时停止
  useEffect(() => {
    if (!projectId) return;
    const t = setInterval(() => fetchMRs(true), 60000);
    return () => clearInterval(t);
  }, [projectId, fetchMRs]);

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
    // 固定排序：时间由近到远；all 列表 open 最前、merged 次之、closed 最后（组内按时间）
    const timeOf = (mr) => {
      const t = mr.created_at || mr.createdAt || mr.updated_at || mr.updatedAt;
      return typeof t === 'number' ? t : (t ? Date.parse(t) : 0);
    };
    const statusRank = { open: 0, merged: 1, closed: 2 };
    const sorted = [...result];
    if (statusFilter === 'all') {
      sorted.sort((a, b) => {
        const ra = statusRank[a.status] ?? 9;
        const rb = statusRank[b.status] ?? 9;
        if (ra !== rb) return ra - rb;
        return timeOf(b) - timeOf(a);
      });
    } else {
      sorted.sort((a, b) => timeOf(b) - timeOf(a));
    }
    return sorted;
  }, [mergeRequests, statusFilter, searchQuery]);

  const countByStatus = useMemo(() => {
    const counts = { all: mergeRequests.length, open: 0, merged: 0, closed: 0 };
    for (const mr of mergeRequests) {
      if (counts[mr.status] != null) counts[mr.status]++;
    }
    return counts;
  }, [mergeRequests]);

  const PAGE_SIZE = 10;
  useEffect(() => { setPage(1); }, [statusFilter, searchQuery]);
  const totalItems = filteredMRs.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedMRs = useMemo(
    () => filteredMRs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredMRs, currentPage],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 shrink-0 bg-white">
        <div className="flex items-center gap-1 shrink-0">
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
        <div className="relative flex-1 min-w-0 max-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search…"
            className={`w-full pl-8 pr-2 py-1 text-xs ${consoleInputClass}`}
          />
        </div>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {onCreatePR && (
            <button
              type="button"
              onClick={onCreatePR}
              className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-zinc-700 rounded-md border border-zinc-200 hover:bg-zinc-100 ${consoleButtonFocusClass}`}
            >
              <GitPullRequest className="h-3.5 w-3.5 shrink-0" />
              New Pull Request
            </button>
          )}
        </div>
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
            {pagedMRs.map((mr) => {
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
                    onClick={() => onSelectMR?.({ ...mr, permissions })}
                    className={`absolute inset-0 z-0 ${consoleButtonFocusClass}`}
                    aria-label={`Open pull request${number != null ? ` #${number}` : ''}${mr.title ? `: ${mr.title}` : ''}`}
                  />
                  <span className={`relative z-10 mt-1.5 h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                  <div className="relative z-10 min-w-0 flex-1 pointer-events-none">
                    <div className="flex items-start gap-2 min-w-0">
                      {number != null && (
                        <span className="font-mono text-xs text-zinc-400 shrink-0 mt-0.5">#{number}</span>
                      )}
                      <span className="break-words text-sm font-medium leading-snug text-zinc-900">
                        {mr.title || 'Untitled'}
                      </span>
                    </div>
                    <div className="mt-1 flex items-start gap-1.5 min-w-0 text-[11px] text-zinc-500">
                      {src && (
                        <span className="font-mono break-all" title={src}>{src}</span>
                      )}
                      {src && tgt && (
                        <span className="text-zinc-300 shrink-0">{'→'}</span>
                      )}
                      {tgt && (
                        <span className="font-mono break-all" title={tgt}>{tgt}</span>
                      )}
                      {(src || tgt) && (
                        <span className="text-zinc-300 shrink-0">·</span>
                      )}
                      <span className="shrink-0 text-zinc-400">
                        {formatRelative(mr.created_at || mr.createdAt)}
                      </span>
                    </div>
                  </div>
                  <div className="relative z-10 ml-auto flex items-center gap-1 shrink-0 pointer-events-none">
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
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-3 py-1.5 shrink-0 bg-white">
          <span className="text-[11px] text-zinc-500 tabular-nums">
            {currentPage * PAGE_SIZE - PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, totalItems)} of {totalItems}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              title="Previous page"
              aria-label="Previous page"
              className={consoleIconButtonClass}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="text-[11px] text-zinc-500 tabular-nums min-w-[2.5rem] text-center">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              title="Next page"
              aria-label="Next page"
              className={consoleIconButtonClass}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
