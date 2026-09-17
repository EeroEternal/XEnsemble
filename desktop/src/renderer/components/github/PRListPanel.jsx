import React from 'react';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { usePullRequests } from '../../hooks/usePullRequests';
import { openExternal } from '../../lib/githubApi.js';
import {
  consoleAdminTableShellClass,
  consoleTableHeadRowClass,
  consoleTableHeadCellDenseClass,
  consoleTableHeadBandClass,
  consoleTableBodyDivideClass,
  consoleTableBodyRowClass,
  consoleTableBodyCellDenseClass,
  consoleEmptyStateClass,
  consoleIconButtonClass,
  textPlaceholder,
  textSecondary,
} from '../../lib/consoleTheme';

const STATUS_STYLES = {
  open: 'bg-green-100 text-green-800',
  merged: 'bg-purple-100 text-purple-800',
  closed: 'bg-zinc-100 text-zinc-700',
};

function formatDate(ts) {
  if (!ts) return '—';
  const date = new Date(ts);
  return isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

export default function PRListPanel({ projectId }) {
  const { pullRequests, loading, fetchPRs, sync } = usePullRequests(projectId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-[#E8EAED] px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#5F6368]">
          Pull Requests
        </h3>
        <button
          type="button"
          onClick={fetchPRs}
          disabled={loading}
          title="Refresh pull requests"
          aria-label="Refresh pull requests"
          className={consoleIconButtonClass}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <div className={consoleAdminTableShellClass}>
        {pullRequests.length === 0 ? (
          <div className={`m-3 p-4 text-center text-xs ${textPlaceholder} ${consoleEmptyStateClass}`}>
            No pull requests yet.
          </div>
        ) : (
          <>
          <div className={consoleTableHeadBandClass}>
          <table className="w-full table-fixed text-left">
            <colgroup>
              <col className="w-10" />
              <col />
              <col className="w-24" />
              <col className="w-56" />
              <col className="w-28" />
              <col className="w-16" />
            </colgroup>
            <thead>
              <tr>
                <th className={consoleTableHeadCellDenseClass}>#</th>
                <th className={consoleTableHeadCellDenseClass}>Title</th>
                <th className={consoleTableHeadCellDenseClass}>Status</th>
                <th className={consoleTableHeadCellDenseClass}>Branch</th>
                <th className={consoleTableHeadCellDenseClass}>Created</th>
                <th className={consoleTableHeadCellDenseClass}>Actions</th>
              </tr>
            </thead>
          </table>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          <table className="w-full table-fixed text-left">
            <colgroup>
              <col className="w-10" />
              <col />
              <col className="w-24" />
              <col className="w-56" />
              <col className="w-28" />
              <col className="w-16" />
            </colgroup>
            <tbody className={consoleTableBodyDivideClass}>
              {pullRequests.map((pr) => (
                <tr key={pr.id} className={consoleTableBodyRowClass}>
                  <td className={consoleTableBodyCellDenseClass}>
                    {pr.github_pr_number || pr.githubPrNumber}
                  </td>
                  <td className={`${consoleTableBodyCellDenseClass} min-w-0`}>
                    <span className="block truncate max-w-[12rem]" title={pr.title}>
                      {pr.title}
                    </span>
                  </td>
                  <td className={consoleTableBodyCellDenseClass}>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${
                        STATUS_STYLES[pr.status] || STATUS_STYLES.closed
                      }`}
                    >
                      {pr.status}
                    </span>
                  </td>
                  <td className={consoleTableBodyCellDenseClass}>
                    <span className="block truncate max-w-[8rem]" title={pr.source_branch || pr.sourceBranch}>
                      {pr.source_branch || pr.sourceBranch}
                    </span>
                  </td>
                  <td className={consoleTableBodyCellDenseClass}>
                    {formatDate(pr.created_at || pr.createdAt)}
                  </td>
                  <td className={consoleTableBodyCellDenseClass}>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openExternal(pr.github_pr_url || pr.githubPrUrl)}
                        title="Open on GitHub"
                        aria-label="Open on GitHub"
                        className={consoleIconButtonClass}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => sync(pr.id)}
                        disabled={loading}
                        title="Sync status"
                        aria-label="Sync status"
                        className={consoleIconButtonClass}
                      >
                        {loading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
