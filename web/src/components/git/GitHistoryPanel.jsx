import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitCommit, Loader2, RefreshCw, Cloud, FileText } from 'lucide-react';
import * as gitApi from '../../lib/gitApi';
import { useToast } from '../Toast';
import {
  consoleIconButtonClass,
  textPrimary,
  textSecondary,
} from '../../lib/consoleTokens';

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 2592000)}mo`;
}

const FILE_STATUS_LABELS = {
  A: 'A',
  M: 'M',
  D: 'D',
  R: 'R',
  C: 'C',
};

const FILE_STATUS_COLORS = {
  A: 'text-emerald-600',
  M: 'text-red-600',
  D: 'text-red-600',
  R: 'text-blue-600',
  C: 'text-blue-600',
};

function isBranchRef(ref) {
  return ref && !ref.name.startsWith('tag:') && ref.label !== 'tag';
}

function isRemoteRef(ref) {
  return ref.name.startsWith('origin/') || ref.name.startsWith('upstream/');
}

function getGraphDotColor(refs) {
  const branchRefs = (refs || []).filter(isBranchRef);
  if (branchRefs.length === 0) return '#a1a1aa';
  if (branchRefs.some((r) => r.name === 'HEAD' || r.name === 'main' || r.name === 'master'))
    return '#18181b';
  if (branchRefs.some((r) => isRemoteRef(r)))
    return '#2563eb';
  return '#059669';
}

function BranchBadge({ branchRef }) {
  if (!branchRef) return null;
  const remote = isRemoteRef(branchRef);
  const name = branchRef.name.replace(/^(origin|upstream)\//, '');
  if (remote) {
    return (
      <span
        className="inline-flex items-center gap-0.5 text-[10px] font-medium rounded-full px-1.5 py-px whitespace-nowrap"
        style={{ backgroundColor: '#eff6ff', color: '#2563eb' }}
        title="remote"
      >
        <Cloud className="h-2.5 w-2.5 shrink-0" />
        {name}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[10px] font-medium rounded-full px-1.5 py-px whitespace-nowrap"
      style={{ backgroundColor: '#f4f4f5', color: '#71717a' }}
      title="local"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
        <circle cx="5" cy="5" r="4" fill="none" stroke="#71717a" strokeWidth="1" />
        <circle cx="5" cy="5" r="2.5" fill="none" stroke="#71717a" strokeWidth="1" />
        <circle cx="5" cy="5" r="1" fill="#71717a" />
      </svg>
      {name}
    </span>
  );
}

function CommitRow({ commit, projectId }) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const graphLines = (commit.graph || '').split('\n');
  const refs = (commit.refs || []).filter(isBranchRef);
  const dotColor = getGraphDotColor(commit.refs || []);
  const rowH = graphLines.length * 11;
  const curH = `${rowH}px`;

  const handleClick = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!files && commit.sha) {
      setLoadingFiles(true);
      try {
        const data = await gitApi.getCommitFiles(projectId, commit.sha);
        setFiles(data.files || []);
      } catch {
        setFiles([]);
      } finally {
        setLoadingFiles(false);
      }
    }
  }, [expanded, files, commit.sha, projectId]);

  return (
    <div>
      <div className="flex items-center group cursor-pointer"
           style={{ minHeight: curH }}
           onClick={handleClick}>
        <div className="font-mono text-[11px] leading-[11px] select-none shrink-0 w-12 overflow-hidden"
             style={{ width: '48px', minWidth: '48px' }}>
          {graphLines.map((line, i) => {
            const starIdx = line.indexOf('*');
            if (starIdx === -1) {
              return (
                <div key={i} className="h-[11px] text-zinc-400 whitespace-pre">
                  {line || ' '}
                </div>
              );
            }
            return (
              <div key={i} className="h-[11px] text-zinc-500 whitespace-pre flex items-center">
                <span>{line.slice(0, starIdx)}</span>
                <span className="inline-flex items-center">
                  <svg width="11" height="11" viewBox="0 0 11 11" className="shrink-0">
                    <circle cx="5.5" cy="5.5" r="4.5" fill={dotColor} stroke="none" />
                  </svg>
                </span>
                <span>{line.slice(starIdx + 1)}</span>
              </div>
            );
          })}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 pr-2">
            <span className="text-[13px] font-medium text-zinc-900 line-clamp-1 flex-1 min-w-0">
              {commit.message}
            </span>
            {refs.length > 0 && (
              <span className="flex items-center gap-0.5 shrink-0">
                {refs.map((ref, i) => (
                  <BranchBadge key={i} branchRef={ref} />
                ))}
              </span>
            )}
            <span className="text-[11px] text-zinc-400 shrink-0 max-w-[80px] truncate"
                  title={commit.author}>
              {commit.author?.split(/\s+/)[0]}
            </span>
            <span className="text-[11px] text-zinc-400 shrink-0 w-[24px] text-right"
                  title={formatTimestamp(commit.timestamp)}>
              {formatTimeAgo(commit.timestamp)}
            </span>
            <span className="font-mono text-[10px] text-zinc-400 shrink-0 hidden group-hover:inline">
              {commit.sha?.slice(0, 7)}
            </span>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="pl-12 pb-2 pr-3">
          {loadingFiles ? (
            <div className="flex items-center gap-1.5 py-1.5 text-[11px] text-zinc-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading files...
            </div>
          ) : files && files.length > 0 ? (
            <div className="flex flex-col gap-px">
              {files.map((f, i) => (
                <div key={i} className="flex items-center gap-1.5 py-0.5 text-[11px]">
                  <span className={`font-mono font-semibold w-4 text-center shrink-0 ${FILE_STATUS_COLORS[f.status] || 'text-zinc-400'}`}>
                    {FILE_STATUS_LABELS[f.status] || f.status}
                  </span>
                  <FileText className="h-3 w-3 text-zinc-400 shrink-0" />
                  <span className="font-mono text-zinc-900 truncate">{f.path}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-zinc-400 py-1">No files changed.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function GitHistoryPanel({ projectId, filePath }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [commits, setCommits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(30);

  const fetchHistory = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await gitApi.getGraphLog(projectId, count);
      setCommits(data.commits || []);
    } catch (err) {
      showToast('error', err.message);
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, count, showToast]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const loadMore = () => setCount((c) => c + 30);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-1.5 shrink-0">
        <div className="flex items-center gap-2">
          <GitCommit className="h-3.5 w-3.5 text-zinc-500" />
          <h3 className={`text-xs font-semibold ${textPrimary}`}>History</h3>
        </div>
        <button
          type="button"
          onClick={fetchHistory}
          disabled={loading}
          title={t('common:action.refresh')}
          className={consoleIconButtonClass}
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {loading && commits.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading history...
          </div>
        ) : commits.length === 0 ? (
          <div className="text-center py-8">
            <GitCommit className="mx-auto h-8 w-8 text-zinc-400 mb-2" />
            <p className={`text-sm ${textSecondary}`}>No commits found.</p>
          </div>
        ) : (
          <div>
            {commits.map((commit, idx) => (
              <CommitRow
                key={commit.sha || idx}
                commit={commit}
                projectId={projectId}
              />
            ))}
            {commits.length >= count && (
              <div className="text-center py-2">
                <button
                  type="button"
                  onClick={loadMore}
                  className="text-xs font-medium text-zinc-500 hover:text-zinc-900 transition-colors"
                >
                  Load more...
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
