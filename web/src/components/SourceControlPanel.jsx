import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  GitCommit, GitPullRequest, RefreshCw, PanelLeftClose,
  Loader2, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, Folder,
  Upload, Download, AlertTriangle, RotateCcw, User,
} from 'lucide-react';
import {
  consoleButtonFocusClass,
  consoleInputClass,
  consoleDropdownPanelClass,
  consoleMenuDropdownZClass,
  consoleDialogSmClass,
} from '../lib/consoleTokens';
import { buttonClass } from '../lib/buttonStyles';
import { ConsoleDialogShell } from './ConsoleDialog';
import CreatePRDialog from './git/CreatePRDialog';
import { ConflictFileItem } from './git/ConflictResolutionPanel';
import { DiffText } from './git/DiffText';
import { getGitFileDiff } from '../lib/githubApi';
import { apiFetch } from '../lib/api';
import { withSessionId } from '../lib/sessionContext';
import { useToast } from './Toast';

const GIT_STATUS_LABELS = {
  'M ': 'M', ' M': 'M', 'MM': 'M',
  'A ': 'A', 'AM': 'A',
  'D ': 'D',
  '??': 'U',
  'R ': 'R',
};

const GIT_STATUS_COLORS = {
  'M ': 'text-red-600', ' M': 'text-red-600', 'MM': 'text-red-600',
  'A ': 'text-emerald-600', 'AM': 'text-emerald-600',
  'D ': 'text-red-600',
  '??': 'text-emerald-600',
  'R ': 'text-black',
};

const GIT_STATUS_DESC = {
  'M ': 'Modified', ' M': 'Modified', 'MM': 'Modified',
  'A ': 'Added', 'AM': 'Added',
  'D ': 'Deleted',
  '??': 'Untracked',
  'R ': 'Renamed',
};

export default function SourceControlPanel({ projectId, gitChanges, onJumpToFile, onCollapse, provider, sessionLive }) {
  const { showToast } = useToast();
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [generatingMsg, setGeneratingMsg] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [showAuthorDialog, setShowAuthorDialog] = useState(false);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [createPROpen, setCreatePROpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [actionMenuRect, setActionMenuRect] = useState(null);
  const [authorName, setAuthorName] = useState(() => localStorage.getItem('xe_git_author_name') || '');
  const [authorEmail, setAuthorEmail] = useState(() => localStorage.getItem('xe_git_author_email') || '');
  const [expandedFiles, setExpandedFiles] = useState(new Set());
  const [fileDiffs, setFileDiffs] = useState({});
  const [loadingDiff, setLoadingDiff] = useState(null);
  const [resolvedPaths, setResolvedPaths] = useState(new Set());
  const authorNameRef = useRef(null);
  const commitMsgRef = useRef(null);
  const actionMenuBtnRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/v1/user/preferences')
      .then((res) => res.ok ? res.json() : null)
      .then((prefs) => {
        if (cancelled || !prefs) return;
        if (prefs.git_author_name) { setAuthorName(prefs.git_author_name); localStorage.setItem('xe_git_author_name', prefs.git_author_name); }
        if (prefs.git_author_email) { setAuthorEmail(prefs.git_author_email); localStorage.setItem('xe_git_author_email', prefs.git_author_email); }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (showAuthorDialog && authorNameRef.current) {
      authorNameRef.current.focus();
    }
  }, [showAuthorDialog]);

  useEffect(() => {
    if (showCommitDialog && commitMsgRef.current) {
      commitMsgRef.current.focus();
    }
  }, [showCommitDialog]);

  useEffect(() => {
    if (!actionMenuOpen) {
      setActionMenuRect(null);
      return undefined;
    }
    const update = () => {
      const el = actionMenuBtnRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const menuWidth = 180;
      const menuEstHeight = 160;
      const spaceBelow = window.innerHeight - rect.bottom;
      const openAbove = spaceBelow < menuEstHeight + 8 && rect.top > menuEstHeight + 8;
      setActionMenuRect({
        top: openAbove ? null : rect.bottom + 4,
        bottom: openAbove ? window.innerHeight - rect.top + 4 : null,
        left: Math.max(8, rect.right - menuWidth),
        width: menuWidth,
      });
    };
    update();
    const onDoc = (e) => {
      if (actionMenuBtnRef.current?.contains(e.target)) return;
      const menu = document.getElementById('changes-action-menu');
      if (menu?.contains(e.target)) return;
      setActionMenuOpen(false);
    };
    window.addEventListener('resize', update);
    document.addEventListener('mousedown', onDoc);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [actionMenuOpen]);

  const gitStagedFiles = gitChanges?.stagedFiles || [];
  const gitUnstagedFiles = gitChanges?.unstagedFiles || [];
  const gitHasChanges = gitStagedFiles.length + gitUnstagedFiles.length > 0;
  const branch = gitChanges?.branch || '';
  const isLocalGit = !provider || provider === 'none' || provider === 'local_git';
  const conflictFiles = (gitChanges?.conflicts || []).filter((f) => !resolvedPaths.has(f.path));

  const handleConflictResolved = useCallback((resolvedPath) => {
    setResolvedPaths((prev) => new Set([...prev, resolvedPath]));
    gitChanges?.fetchStatus?.({ silent: true });
  }, [gitChanges]);

  const [discarding, setDiscarding] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(null);

  const requestDiscardFile = useCallback((path) => {
    setDiscardConfirm({
      kind: 'file',
      path,
      title: 'Discard Changes',
      message: `Discard changes to ${path}? This cannot be undone.`,
      confirmLabel: 'Discard',
    });
  }, []);

  const requestDiscardAll = useCallback(() => {
    const allPaths = [...gitStagedFiles, ...gitUnstagedFiles].map((f) => f.path).filter(Boolean);
    if (allPaths.length === 0) return;
    setDiscardConfirm({
      kind: 'all',
      paths: allPaths,
      title: 'Discard All Changes',
      message: `Discard all ${allPaths.length} change(s)? This cannot be undone.`,
      confirmLabel: 'Discard All',
    });
  }, [gitStagedFiles, gitUnstagedFiles]);

  const cancelDiscard = useCallback(() => setDiscardConfirm(null), []);

  const executeDiscard = useCallback(async () => {
    const target = discardConfirm;
    if (!target) return;
    setDiscarding(true);
    try {
      if (target.kind === 'file') {
        setFileDiffs((prev) => { const next = { ...prev }; delete next[target.path]; return next; });
        await gitChanges?.discard([target.path]);
        showToast('success', 'Changes discarded.');
      } else {
        setFileDiffs({});
        await gitChanges?.discard(target.paths);
        showToast('success', 'All changes discarded.');
      }
    } catch (err) {
      showToast('error', err.message || 'Discard failed');
    } finally {
      setDiscarding(false);
      setDiscardConfirm(null);
    }
  }, [discardConfirm, gitChanges, showToast]);

  useEffect(() => {
    if (!discardConfirm) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelDiscard(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [discardConfirm, cancelDiscard]);

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    try {
      // Stage and commit in one action: stage every changed (unstaged) file,
      // then commit the resulting index.
      const unstagedPaths = gitUnstagedFiles.map((f) => f.path).filter(Boolean);
      if (unstagedPaths.length > 0) {
        await gitChanges?.stage(unstagedPaths);
      }
      const author = authorName && authorEmail ? { name: authorName, email: authorEmail } : undefined;
      await gitChanges?.commit(commitMessage.trim(), author);
      setCommitMessage('');
      setShowCommitDialog(false);
      showToast('success', 'Committed.');
    } catch (err) {
      if (err.code === 'AUTHOR_REQUIRED' || (err.message && err.message.includes('author'))) {
        setShowAuthorDialog(true);
        return;
      }
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, gitChanges, authorName, authorEmail, gitUnstagedFiles]);

  const handleGenerateMessage = useCallback(async () => {
    setGeneratingMsg(true);
    try {
      const res = await apiFetch(withSessionId(`/api/v1/projects/${encodeURIComponent(projectId)}/git/commit-message`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate message');
      if (data.message) setCommitMessage(data.message);
      else showToast('error', data.error || 'No changes to describe');
    } catch (err) {
      showToast('error', err.message || 'Failed to generate message');
    } finally {
      setGeneratingMsg(false);
    }
  }, [projectId, showToast]);

  // 打开 commit 对话框时自动用 AI 总结当前变更并填入 commit 信息（无需手动点 AI draft）
  useEffect(() => {
    if (!showCommitDialog) return;
    handleGenerateMessage();
  }, [showCommitDialog, handleGenerateMessage]);

  const handlePull = useCallback(async () => {
    setActionMenuOpen(false);
    setPulling(true);
    try {
      await gitChanges?.pull();
    } catch {
      // useGitStatus already shows error toast
    } finally {
      setPulling(false);
    }
  }, [gitChanges]);

  const handleAuthorConfirm = useCallback(async () => {
    if (!authorName.trim() || !authorEmail.trim()) return;
    localStorage.setItem('xe_git_author_name', authorName.trim());
    localStorage.setItem('xe_git_author_email', authorEmail.trim());
    apiFetch('/api/v1/user/preferences', {
      method: 'PUT',
      body: JSON.stringify({ git_author_name: authorName.trim(), git_author_email: authorEmail.trim() }),
    }).catch(() => {});
    setShowAuthorDialog(false);
    setCommitting(true);
    try {
      const author = { name: authorName.trim(), email: authorEmail.trim() };
      await gitChanges?.commit(commitMessage.trim(), author);
      setCommitMessage('');
      setShowCommitDialog(false);
    } catch (_) {
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, gitChanges, authorName, authorEmail]);

  const handlePush = useCallback(async () => {
    setActionMenuOpen(false);
    setPushing(true);
    try {
      await gitChanges?.push();
    } catch {
      // useGitStatus already shows error toast
    } finally {
      setPushing(false);
    }
  }, [gitChanges]);

  const handleOpenCreatePR = useCallback(() => {
    setActionMenuOpen(false);
    setCreatePROpen(true);
  }, []);

  const normalizeDiffEntry = useCallback((data, fallbackText = '') => {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return {
        diff: typeof data.diff === 'string' ? data.diff : fallbackText,
        binary: Boolean(data.binary),
        truncated: Boolean(data.truncated),
      };
    }
    return {
      diff: typeof data === 'string' ? data : fallbackText,
      binary: false,
      truncated: false,
    };
  }, []);

  const toggleFileExpand = useCallback(async (filePath) => {
    const newExpanded = new Set(expandedFiles);
    if (newExpanded.has(filePath)) {
      newExpanded.delete(filePath);
      setExpandedFiles(newExpanded);
    } else {
      newExpanded.add(filePath);
      setExpandedFiles(newExpanded);
      if (!fileDiffs[filePath]) {
        setLoadingDiff(filePath);
        try {
          const data = await getGitFileDiff(projectId, filePath);
          setFileDiffs((prev) => ({ ...prev, [filePath]: normalizeDiffEntry(data) }));
        } catch (_) {
          setFileDiffs((prev) => ({
            ...prev,
            [filePath]: normalizeDiffEntry({ diff: 'Failed to load diff' }),
          }));
        } finally {
          setLoadingDiff(null);
        }
      }
    }
  }, [expandedFiles, fileDiffs, projectId, normalizeDiffEntry]);

  const allFiles = useMemo(() => {
    const map = new Map();
    for (const f of [...gitStagedFiles, ...gitUnstagedFiles]) {
      if (f?.path && !map.has(f.path)) map.set(f.path, f);
    }
    return [...map.values()];
  }, [gitStagedFiles, gitUnstagedFiles]);
  const allExpanded = allFiles.length > 0 && allFiles.every((f) => expandedFiles.has(f.path));

  const toggleExpandAll = useCallback(async () => {
    if (allExpanded) {
      setExpandedFiles(new Set());
      return;
    }
    const newExpanded = new Set(allFiles.map((f) => f.path));
    setExpandedFiles(newExpanded);
    const toFetch = allFiles.filter((f) => !fileDiffs[f.path]).map((f) => f.path);
    if (toFetch.length === 0) return;
    setLoadingDiff('batch');
    try {
      const results = await Promise.all(
        toFetch.map((p) => getGitFileDiff(projectId, p)
          .then((d) => [p, normalizeDiffEntry(d)])
          .catch(() => [p, normalizeDiffEntry({ diff: 'Failed to load diff' })])),
      );
      setFileDiffs((prev) => {
        const next = { ...prev };
        for (const [p, d] of results) next[p] = d;
        return next;
      });
    } finally {
      setLoadingDiff(null);
    }
  }, [allExpanded, allFiles, fileDiffs, projectId, normalizeDiffEntry]);

  // Build a directory tree from the deduped changed files.
  const changesTree = useMemo(() => {
    const root = { dirs: {}, files: [] };
    for (const f of allFiles) {
      const parts = f.path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        node.dirs[part] = node.dirs[part] || { dirs: {}, files: [] };
        node = node.dirs[part];
      }
      node.files.push(f);
    }
    return root;
  }, [allFiles]);

  const [collapsedDirs, setCollapsedDirs] = useState(() => new Set());
  const toggleDir = useCallback((dirPath) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath); else next.add(dirPath);
      return next;
    });
  }, []);

  const renderFileRow = (f, depth) => {
    const label = GIT_STATUS_LABELS[f.status] || f.status;
    const colorCls = GIT_STATUS_COLORS[f.status] || 'text-zinc-400';
    const desc = GIT_STATUS_DESC[f.status] || '';
    const isExpanded = expandedFiles.has(f.path);
    const diffEntry = fileDiffs[f.path];
    const diffText = typeof diffEntry === 'string' ? diffEntry : diffEntry?.diff;
    const diffBinary = Boolean(diffEntry && typeof diffEntry === 'object' && diffEntry.binary);
    const diffTruncated = Boolean(diffEntry && typeof diffEntry === 'object' && diffEntry.truncated);
    const isLoading = loadingDiff === f.path;
    return (
      <div key={f.path}>
        <div className="flex items-center group hover:bg-zinc-50" style={{ paddingLeft: depth * 12 }}>
          <button
            onClick={() => toggleFileExpand(f.path)}
            className="shrink-0 p-0.5 text-zinc-400 hover:text-zinc-600"
            title={isExpanded ? 'Collapse diff' : 'Expand diff'}
          >
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => toggleFileExpand(f.path)}
            onDoubleClick={() => onJumpToFile?.(f.path)}
            className={`flex items-center gap-2 flex-1 min-w-0 px-1.5 py-1.5 text-left ${consoleButtonFocusClass}`}
            title={f.path}
          >
            <span className={`w-3.5 text-center font-mono text-[11px] font-semibold ${colorCls} shrink-0`} title={desc || f.status}>{label}</span>
            <span className="truncate text-zinc-900 text-xs">{f.path.split('/').pop()}</span>
            <span className="truncate text-zinc-400 text-[10px]">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
          </button>
          <button
            onClick={() => requestDiscardFile(f.path)}
            title="Discard changes"
            className={`shrink-0 p-1 rounded text-zinc-400 hover:text-red-600 hover:bg-zinc-200 opacity-0 group-hover:opacity-100 focus:opacity-100 ${consoleButtonFocusClass}`}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
        {isExpanded && (
          <div className="border-t border-zinc-200 bg-zinc-50">
            {isLoading ? (
              <div className="flex items-center justify-center py-4 text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : diffEntry != null ? (
              diffBinary ? (
                <div className="px-3 py-3 text-[11px] text-zinc-500" data-testid="inline-diff-binary">
                  Binary file, cannot display text diff
                </div>
              ) : (
                <div className="text-[11px] leading-relaxed overflow-x-auto font-mono select-text"
                     style={{ tabSize: 4, MozTabSize: 4 }}>
                  <DiffText diff={diffText} />
                  {diffTruncated && (
                    <div className="px-2 py-1 text-amber-700 bg-amber-50 border-t border-amber-200" data-testid="inline-diff-truncated">
                      Content too large, truncated
                    </div>
                  )}
                </div>
              )
            ) : null}
          </div>
        )}
      </div>
    );
  };

  const renderNodes = (node, depth, parentPath) => {
    const dirs = Object.entries(node.dirs).sort(([a], [b]) => a.localeCompare(b));
    const files = node.files.slice().sort((a, b) => a.path.localeCompare(b.path));
    return (
      <>
        {dirs.map(([name, child]) => {
          const dirPath = parentPath ? `${parentPath}/${name}` : name;
          const collapsed = collapsedDirs.has(dirPath);
          return (
            <div key={'dir-' + dirPath}>
              <button
                onClick={() => toggleDir(dirPath)}
                className={`flex items-center gap-1 w-full px-1.5 py-1 text-left hover:bg-zinc-50 ${consoleButtonFocusClass}`}
                style={{ paddingLeft: depth * 12 }}
              >
                {collapsed ? <ChevronRight className="h-3.5 w-3.5 text-zinc-400" /> : <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />}
                <Folder className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-xs font-medium text-zinc-700 truncate">{name}</span>
              </button>
              {!collapsed && renderNodes(child, depth + 1, dirPath)}
            </div>
          );
        })}
        {files.map((f) => renderFileRow(f, depth))}
      </>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0 w-full relative">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-1.5 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {(gitChanges?.ahead > 0) && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-[11px] font-medium text-amber-700" title={`${gitChanges.ahead} committed but not pushed`}>
              <Upload className="h-3 w-3" />
              {gitChanges.ahead} unpushed
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <div className="flex items-stretch shrink-0 rounded-md border border-zinc-200 overflow-hidden">
            {gitHasChanges ? (
              <button
                type="button"
                onClick={() => setShowCommitDialog(true)}
                disabled={committing || gitChanges?.operation === 'commit'}
                title="Stage all changes and commit"
                className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
              >
                {committing || gitChanges?.operation === 'commit' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GitCommit className="h-3.5 w-3.5" />
                )}
                Commit
              </button>
            ) : gitChanges?.ahead > 0 ? (
              <button
                type="button"
                onClick={handlePush}
                disabled={pushing || gitChanges?.operation === 'push'}
                title={`Push ${gitChanges.ahead} commit(s) to remote`}
                className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
              >
                {pushing || gitChanges?.operation === 'push' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                Push
              </button>
            ) : (
              <button
                type="button"
                onClick={handlePull}
                disabled={pulling || gitChanges?.operation === 'pull'}
                title="Pull latest changes"
                className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
              >
                {pulling || gitChanges?.operation === 'pull' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                Pull
              </button>
            )}
            <button
              ref={actionMenuBtnRef}
              type="button"
              onClick={() => setActionMenuOpen((v) => !v)}
              title="More git actions"
              aria-label="More git actions"
              aria-haspopup="menu"
              aria-expanded={actionMenuOpen}
              className={`flex items-center px-1.5 text-zinc-500 hover:bg-zinc-100 border-l border-zinc-200 ${consoleButtonFocusClass} ${actionMenuOpen ? 'bg-zinc-100 text-zinc-900' : ''}`}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
          {gitHasChanges && (
            <button
              title={allExpanded ? 'Collapse all' : 'Expand all'}
              onClick={toggleExpandAll}
              className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
            >
              {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
            </button>
          )}
          <button
            title="Refresh"
            onClick={() => gitChanges?.fetchStatus()}
            className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
          >
            <RefreshCw className="h-3 w-3" />
          </button>
          {onCollapse && (
            <button
              title="Collapse sidebar"
              onClick={onCollapse}
              className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <div className="flex flex-col h-full min-h-0 relative">
          <div className="flex-1 min-h-0 overflow-y-auto console-scroll-hidden">
            {conflictFiles.length > 0 && (
              <div className="border-b border-zinc-200">
                <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-200 bg-amber-50">
                  <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
                  <span className="text-[10px] font-semibold text-amber-700 uppercase tracking-wider">
                    Conflicts ({conflictFiles.length})
                  </span>
                </div>
                <div className="p-2 space-y-1.5">
                  {conflictFiles.map((file) => (
                    <ConflictFileItem
                      key={file.path}
                      file={file}
                      projectId={projectId}
                      onResolved={handleConflictResolved}
                    />
                  ))}
                </div>
              </div>
            )}
            {!gitHasChanges && conflictFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 gap-2 text-zinc-400">
                <GitCommit className="h-6 w-6" />
                <p className="text-[10px]">No changes yet</p>
                <p className="text-[10px] text-zinc-400">Let the agent edit some code first.</p>
              </div>
            ) : (
              <div className="flex flex-col">
                {renderNodes(changesTree, 0, '')}
              </div>
            )}
          </div>
        </div>
      </div>

      {actionMenuOpen && actionMenuRect && createPortal(
        <div
          id="changes-action-menu"
          className={`fixed ${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} py-1 shadow-lg`}
          style={{ top: actionMenuRect.top, bottom: actionMenuRect.bottom, left: actionMenuRect.left, width: actionMenuRect.width }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            disabled={pulling || gitChanges?.operation === 'pull'}
            onClick={handlePull}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 ${consoleButtonFocusClass}`}
          >
            {pulling || gitChanges?.operation === 'pull' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Pull{gitChanges?.behind > 0 ? ` (${gitChanges.behind})` : ''}
          </button>
          {!isLocalGit && (
            <button
              type="button"
              role="menuitem"
              disabled={pushing || gitChanges?.operation === 'push'}
              onClick={handlePush}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 ${consoleButtonFocusClass}`}
            >
              {pushing || gitChanges?.operation === 'push' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Push
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={gitStagedFiles.length === 0 && gitUnstagedFiles.length === 0 || committing}
            onClick={() => { setActionMenuOpen(false); setShowCommitDialog(true); }}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 ${consoleButtonFocusClass}`}
          >
            <GitCommit className="h-3.5 w-3.5" />
            Commit
          </button>
          {!isLocalGit && (
            <button
              type="button"
              role="menuitem"
              disabled={!branch}
              onClick={handleOpenCreatePR}
              title="Will push and create pull request"
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 ${consoleButtonFocusClass}`}
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              Create PR
            </button>
          )}
          {gitHasChanges && (
            <button
              type="button"
              role="menuitem"
              disabled={discarding}
              onClick={() => { setActionMenuOpen(false); requestDiscardAll(); }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-red-600 hover:bg-red-50 disabled:opacity-40 ${consoleButtonFocusClass}`}
            >
              {discarding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              Discard All
            </button>
          )}
        </div>,
        document.body,
      )}

      <CreatePRDialog
        open={createPROpen}
        projectId={projectId}
        sourceBranch={branch}
        defaultTargetBranch="main"
        onClose={() => setCreatePROpen(false)}
        onCreated={() => { setCreatePROpen(false); gitChanges?.fetchStatus?.({ silent: true }); showToast('success', 'Pull request created.'); }}
      />

      {/* Commit dialog */}
      {showCommitDialog && (
        <ConsoleDialogShell onClose={() => setShowCommitDialog(false)} panelClassName={consoleDialogSmClass}>
          <div className="px-5 pt-5 pb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-900">Stage & commit changes</h3>
          </div>
          <div className="px-5 pb-5 flex flex-col gap-3">
            <textarea
              ref={commitMsgRef}
              placeholder={generatingMsg ? 'AI 正在总结你的变更…' : 'Describe what changed'}
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleCommit();
                }
              }}
              rows={3}
              className={`${consoleInputClass} text-xs resize-none`}
            />
            <div className="flex items-center gap-1.5">
              <User className="h-3 w-3 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500 truncate">
                {authorName && authorEmail
                  ? `${authorName} <${authorEmail}>`
                  : 'No author identity set'}
              </span>
              <button
                type="button"
                onClick={() => setShowAuthorDialog(true)}
                className={`text-xs text-black hover:text-zinc-800 shrink-0 ${consoleButtonFocusClass}`}
              >
                {authorName ? 'Edit' : 'Set'}
              </button>
            </div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-200">
            <button
              type="button"
              onClick={() => setShowCommitDialog(false)}
              className={buttonClass('secondary', 'sm')}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCommit}
              disabled={!commitMessage.trim() || committing}
              className={buttonClass('primary', 'sm')}
            >
              {committing ? 'Committing…' : 'Stage & commit'}
            </button>
          </div>
        </ConsoleDialogShell>
      )}

      {/* Author dialog */}
      {showAuthorDialog && (
        <ConsoleDialogShell onClose={() => setShowAuthorDialog(false)} panelClassName={consoleDialogSmClass}>
          <div className="px-5 pt-5 pb-2">
            <h3 className="text-sm font-semibold text-zinc-900">Set Git author info</h3>
          </div>
          <div className="px-5 pb-5 flex flex-col gap-3">
            <input
              ref={authorNameRef}
              type="text"
              placeholder="Name"
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              className={`w-full ${consoleInputClass} text-xs`}
            />
            <input
              type="email"
              placeholder="Email"
              value={authorEmail}
              onChange={(e) => setAuthorEmail(e.target.value)}
              className={`w-full ${consoleInputClass} text-xs`}
            />
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-200">
            <button
              onClick={() => setShowAuthorDialog(false)}
              className={buttonClass('secondary', 'sm')}
            >
              Cancel
            </button>
            <button
              onClick={handleAuthorConfirm}
              disabled={!authorName.trim() || !authorEmail.trim()}
              className={buttonClass('primary', 'sm')}
            >
              Confirm
            </button>
          </div>
        </ConsoleDialogShell>
      )}

      {discardConfirm && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-3"
          onClick={cancelDiscard}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={discardConfirm.title}
            className="pointer-events-auto w-full max-w-sm rounded-lg border border-zinc-200 bg-white shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 pt-4 pb-2">
              <h3 className="text-sm font-semibold text-zinc-900">{discardConfirm.title}</h3>
            </div>
            <div className="px-4 pb-4">
              <p className="text-xs text-zinc-600 leading-relaxed whitespace-pre-wrap break-words">{discardConfirm.message}</p>
            </div>
            <div className="flex justify-end gap-2 flex-wrap px-4 py-3 border-t border-zinc-200">
              <button
                type="button"
                onClick={cancelDiscard}
                disabled={discarding}
                className={`${buttonClass('secondary', 'sm')} ${consoleButtonFocusClass}`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeDiscard}
                disabled={discarding}
                className={`${buttonClass('danger', 'sm')} ${consoleButtonFocusClass}`}
              >
                {discarding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : discardConfirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}