import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react';
import { openExternal } from '../../lib/githubApi.js';
import * as gitApi from '../../lib/gitApi.js';
import {
  consoleTableShellClass,
  consoleTableHeadRowClass,
  consoleTableHeadCellDenseClass,
  consoleTableBodyDivideClass,
  consoleTableBodyRowClass,
  consoleTableBodyCellDenseClass,
  consoleEmptyStateClass,
  consoleIconButtonClass,
  consoleButtonFocusClass,
  consoleInputClass,
  textPlaceholder,
} from '../../lib/consoleTheme';
import { useToast } from '../Toast';

const STATUS_STYLES = {
  open: 'bg-green-100 text-green-800',
  merged: 'bg-purple-100 text-purple-800',
  closed: 'bg-zinc-100 text-zinc-700',
};

const FILTER_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

function formatDate(ts) {
  if (!ts) return '-';
  const date = new Date(ts);
  return isNaN(date.getTime()) ? '-' : date.toLocaleDateString();
}

export default function MergeRequestListPanel({ projectId, provider, onSelectMR, refreshTrigger }) {
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
      <div className="flex items-center justify-between border-b border-[#DADCE0] px-3 py-2 shrink-0 bg-white">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#5F6368]">
          {label}
        </h3>
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
      </div>
      <div className="flex items-center gap-2 border-b border-[#E8EAED] px-3 py-2 shrink-0 bg-white">
        <div className="flex items-center gap-1">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatusFilter(opt.value)}
              className={`px-2 py-0.5 text-[10px] font-medium rounded-full transition-colors ${consoleButtonFocusClass} ${
                statusFilter === opt.value
                  ? 'bg-[#202124] text-white'
                  : 'text-[#5F6368] hover:bg-[#E8EAED]'
              }`}
            >
              {opt.label} ({countByStatus[opt.value] ?? 0})
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-[180px] ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[#9AA0A6]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search…"
            className={`w-full pl-7 pr-2 py-1 text-xs ${consoleInputClass}`}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[#F0F1F3] p-3">
        {filteredMRs.length === 0 ? (
          <div className={`p-6 text-center text-xs ${textPlaceholder} ${consoleEmptyStateClass} rounded-xl bg-white shadow-sm border border-[#E8EAED]`}>
            {mergeRequests.length === 0 ? `No ${label.toLowerCase()} yet.` : 'No results match your filter.'}
          </div>
        ) : (
          <div className="rounded-xl bg-white shadow-sm border border-[#E8EAED] overflow-hidden">
            <table className={`w-full text-left ${consoleTableShellClass}`}>
              <thead className={consoleTableHeadRowClass}>
                <tr>
                  <th className={consoleTableHeadCellDenseClass}>#</th>
                  <th className={consoleTableHeadCellDenseClass}>Title</th>
                  <th className={consoleTableHeadCellDenseClass}>Status</th>
                  <th className={consoleTableHeadCellDenseClass}>Branch</th>
                  <th className={consoleTableHeadCellDenseClass}>Created</th>
                  <th className={consoleTableHeadCellDenseClass}>Actions</th>
                </tr>
              </thead>
              <tbody className={consoleTableBodyDivideClass}>
                {filteredMRs.map((mr) => (
                  <tr key={mr.id} className={`${consoleTableBodyRowClass} transition-colors hover:bg-[#F4F5F6]`}>
                    <td className={consoleTableBodyCellDenseClass}>
                      {mr.remote_mr_number || mr.remoteMrNumber || mr.github_pr_number || '-'}
                    </td>
                    <td className={`${consoleTableBodyCellDenseClass} min-w-0`}>
                      <button
                        type="button"
                        onClick={() => onSelectMR?.(mr)}
                        className="block truncate max-w-[12rem] text-[#202124] hover:text-[#5B8DB8] transition-colors font-medium"
                        title={mr.title}
                      >
                        {mr.title}
                      </button>
                    </td>
                    <td className={consoleTableBodyCellDenseClass}>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${STATUS_STYLES[mr.status] || STATUS_STYLES.closed}`}>
                        {mr.status}
                      </span>
                    </td>
                    <td className={consoleTableBodyCellDenseClass}>
                      <span className="block truncate max-w-[8rem] font-mono text-[10px] text-[#5F6368]" title={mr.source_branch || mr.sourceBranch}>
                        {mr.source_branch || mr.sourceBranch}
                      </span>
                    </td>
                    <td className={consoleTableBodyCellDenseClass}>
                      {formatDate(mr.created_at || mr.createdAt)}
                    </td>
                    <td className={consoleTableBodyCellDenseClass}>
                      <div className="flex items-center gap-1">
                        {(mr.remoteMrUrl || mr.remote_mr_url || mr.remote_url || mr.remoteUrl) && (
                          <button
                            type="button"
                            onClick={() => openExternal(mr.remoteMrUrl || mr.remote_mr_url || mr.remote_url || mr.remoteUrl)}
                            title={`Open on ${provider}`}
                            aria-label={`Open on ${provider}`}
                            className={consoleIconButtonClass}
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
                          className={consoleIconButtonClass}
                        >
                          {syncingId === mr.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
