import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  GitBranch, GitCommit, GitPullRequest, RefreshCw, PanelLeftClose, ArrowUp, ArrowDown,
  Plus, Minus, Loader2, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, FileText,
  Upload, Download, AlertTriangle, RotateCcw,
} from 'lucide-react';
import { consoleButtonFocusClass, consoleInputClass, consoleDropdownPanelClass, consoleMenuDropdownZClass } from '@/lib/consoleTheme';
import { buttonClass } from '../lib/buttonStyles';
import { ConsoleDialogShell } from './ConsoleDialog';
import CreatePRDialog from './github/CreatePRDialog';
import { ConflictFileItem } from './git/ConflictResolutionPanel';
import { getGitFileDiff } from '@/lib/githubApi';
import { useToast } from './Toast';
import { useTranslation } from 'react-i18next';

const GIT_STATUS_LABELS = {
  'M ': 'M', ' M': 'M', 'MM': 'M',
  'A ': 'A', 'AM': 'A',
  'D ': 'D',
  '??': 'U',
  'R ': 'R',
};

const GIT_STATUS_COLORS = {
  'M ': 'text-[#C06C5D]', ' M': 'text-[#C06C5D]', 'MM': 'text-[#C06C5D]',
  'A ': 'text-[#4A7C59]', 'AM': 'text-[#4A7C59]',
  'D ': 'text-[#C06C5D]',
  '??': 'text-[#4A7C59]',
  'R ': 'text-[#5B8DB8]',
};

function getGitStatusDesc(status, t) {
  switch (status) {
    case 'M ':
    case ' M':
    case 'MM':
      return t('git:status.modified', { defaultValue: 'Modified' });
    case 'A ':
    case 'AM':
      return t('git:status.added', { defaultValue: 'Added' });
    case 'D ':
      return t('git:status.deleted', { defaultValue: 'Deleted' });
    case '??':
      return t('git:status.untracked', { defaultValue: 'Untracked' });
    case 'R ':
      return t('git:status.renamed', { defaultValue: 'Renamed' });
    default:
      return '';
  }
}

export default function SourceControlPanel({ projectId, gitChanges, onJumpToFile, onCollapse, provider, sessionLive }) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [showAuthorDialog, setShowAuthorDialog] = useState(false);
  const [createPROpen, setCreatePROpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [actionMenuRect, setActionMenuRect] = useState(null);
  const [authorName, setAuthorName] = useState(() => localStorage.getItem('xe_git_author_name') || '');
  const [authorEmail, setAuthorEmail] = useState(() => localStorage.getItem('xe_git_author_email') || '');
  const [expandedFiles, setExpandedFiles] = useState(new Set());
  const [fileDiffs, setFileDiffs] = useState({});
  const [loadingDiff, setLoadingDiff] = useState(null);
  const [showFileList, setShowFileList] = useState(false);
  const [resolvedPaths, setResolvedPaths] = useState(new Set());
  const authorNameRef = useRef(null);
  const actionMenuBtnRef = useRef(null);

  useEffect(() => {
    if (showAuthorDialog && authorNameRef.current) {
      authorNameRef.current.focus();
    }
  }, [showAuthorDialog]);

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
  const changeCount = gitStagedFiles.length + gitUnstagedFiles.length;
  const branch = gitChanges?.branch || '';
  const isLocalGit = !provider || provider === 'none' || provider === 'local_git';
  const conflictFiles = (gitChanges?.conflicts || []).filter((f) => !resolvedPaths.has(f.path));

  const handleConflictResolved = useCallback((resolvedPath) => {
    setResolvedPaths((prev) => new Set([...prev, resolvedPath]));
    gitChanges?.fetchStatus?.({ silent: true });
  }, [gitChanges]);

  const handleStageAll = useCallback(async () => {
    const paths = gitUnstagedFiles.map((f) => f.path);
    if (paths.length === 0) return;
    setFileDiffs({});
    await gitChanges?.stage(paths);
  }, [gitUnstagedFiles, gitChanges]);

  const handleUnstageAll = useCallback(async () => {
    const paths = gitStagedFiles.map((f) => f.path);
    if (paths.length === 0) return;
    setFileDiffs({});
    await gitChanges?.unstage(paths);
  }, [gitStagedFiles, gitChanges]);

  const handleStageFile = useCallback(async (path) => {
    setFileDiffs((prev) => { const next = { ...prev }; delete next[path]; return next; });
    await gitChanges?.stage([path]);
    if (expandedFiles.has(path)) {
      try {
        const data = await getGitFileDiff(projectId, path);
        const diff = data && typeof data === 'object' && !Array.isArray(data)
          ? (typeof data.diff === 'string' ? data.diff : '') : (typeof data === 'string' ? data : '');
        setFileDiffs((prev) => ({ ...prev, [path]: { diff, binary: false, truncated: false } }));
      } catch (_) {}
    }
  }, [gitChanges, expandedFiles, projectId]);

  const handleUnstageFile = useCallback(async (path) => {
    setFileDiffs((prev) => { const next = { ...prev }; delete next[path]; return next; });
    await gitChanges?.unstage([path]);
    if (expandedFiles.has(path)) {
      try {
        const data = await getGitFileDiff(projectId, path);
        const diff = data && typeof data === 'object' && !Array.isArray(data)
          ? (typeof data.diff === 'string' ? data.diff : '') : (typeof data === 'string' ? data : '');
        setFileDiffs((prev) => ({ ...prev, [path]: { diff, binary: false, truncated: false } }));
      } catch (_) {}
    }
  }, [gitChanges, expandedFiles, projectId]);

  const [discarding, setDiscarding] = useState(false);

  const handleDiscardFile = useCallback(async (path) => {
    if (!window.confirm(t('git:dialog.discard_confirm', { path, defaultValue: 'Discard changes to {{path}}? This cannot be undone.' }))) return;
    setFileDiffs((prev) => { const next = { ...prev }; delete next[path]; return next; });
    await gitChanges?.discard([path]);
  }, [gitChanges, t]);

  const handleDiscardAll = useCallback(async () => {
    const allPaths = [...gitStagedFiles, ...gitUnstagedFiles].map((f) => f.path).filter(Boolean);
    if (allPaths.length === 0) return;
    if (!window.confirm(t('git:dialog.discard_all_confirm', { count: allPaths.length, defaultValue: 'Discard all {{count}} change(s)? This cannot be undone.' }))) return;
    setDiscarding(true);
    try {
      setFileDiffs({});
      await gitChanges?.discard(allPaths);
      showToast('success', t('git:toast.discarded', { defaultValue: 'All changes discarded.' }));
    } catch (err) {
      showToast('error', err.message || t('git:toast.discard_failed', { defaultValue: 'Discard failed' }));
    } finally {
      setDiscarding(false);
    }
  }, [gitStagedFiles, gitUnstagedFiles, gitChanges, showToast, t]);

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    try {
      // Auto-stage all unstaged files when nothing is staged yet (VS Code-like UX)
      if (gitStagedFiles.length === 0 && gitUnstagedFiles.length > 0) {
        const paths = gitUnstagedFiles.map((f) => f.path).filter(Boolean);
        if (paths.length > 0) {
          await gitChanges?.stage(paths);
        }
      }
      const author = authorName && authorEmail ? { name: authorName, email: authorEmail } : undefined;
      await gitChanges?.commit(commitMessage.trim(), author);
      setCommitMessage('');
    } catch (err) {
      if (err.code === 'AUTHOR_REQUIRED' || (err.message && err.message.includes('author'))) {
        setShowAuthorDialog(true);
        return;
      }
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, gitChanges, authorName, authorEmail, gitStagedFiles, gitUnstagedFiles]);

  const handlePull = useCallback(async () => {
    setActionMenuOpen(false);
    setPulling(true);
    try {
      await gitChanges?.pull();
      showToast('success', t('git:toast.pulled', { defaultValue: 'Pulled latest changes.' }));
    } catch (err) {
      showToast('error', err.message || t('git:toast.pull_failed', { defaultValue: 'Pull failed' }));
    } finally {
      setPulling(false);
    }
  }, [gitChanges, showToast, t]);

  const handleAuthorConfirm = useCallback(async () => {
    if (!authorName.trim() || !authorEmail.trim()) return;
    localStorage.setItem('xe_git_author_name', authorName.trim());
    localStorage.setItem('xe_git_author_email', authorEmail.trim());
    setShowAuthorDialog(false);
    setCommitting(true);
    try {
      const author = { name: authorName.trim(), email: authorEmail.trim() };
      await gitChanges?.commit(commitMessage.trim(), author);
      setCommitMessage('');
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
      showToast('success', t('git:toast.pushed', { defaultValue: 'Pushed' }));
    } catch (err) {
      showToast('error', err.message || t('git:toast.push_failed', { defaultValue: 'Push failed' }));
    } finally {
      setPushing(false);
    }
  }, [gitChanges, showToast, t]);

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

  const renderDiffLines = useCallback((raw) => {
    if (!raw) return <span className="text-zinc-400">{t('git:empty.no_changes')}</span>;
    const lines = raw.split('\n');
    return lines.map((line, i) => {
      if (line.startsWith('---') || line.startsWith('+++')) {
        return null;
      }
      if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted ')) {
        return null;
      }
      if (line.startsWith('\\ No newline')) {
        return null;
      }
      const first = line[0];
      if (first === '@') {
        return null;
      }
      if (first === '+') {
        return <div key={i} className="bg-[#DFF7E4] text-[#1A7F37] pl-2">{line.slice(1)}</div>;
      }
      if (first === '-') {
        return <div key={i} className="bg-[#FFEBE9] text-[#CF222E] pl-2">{line.slice(1)}</div>;
      }
      return <div key={i} className="bg-white text-[#1F2328] pl-2">{line || ' '}</div>;
    });
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
            [filePath]: normalizeDiffEntry({ diff: t('git:empty.load_diff_failed', { defaultValue: 'Failed to load diff' }) }),
          }));
        } finally {
          setLoadingDiff(null);
        }
      }
    }
  }, [expandedFiles, fileDiffs, projectId, normalizeDiffEntry, t]);

  const allFiles = [...gitStagedFiles, ...gitUnstagedFiles];
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
          .catch(() => [p, normalizeDiffEntry({ diff: t('git:empty.load_diff_failed', { defaultValue: 'Failed to load diff' }) })])),
      );
      setFileDiffs((prev) => {
        const next = { ...prev };
        for (const [p, d] of results) next[p] = d;
        return next;
      });
    } finally {
      setLoadingDiff(null);
    }
  }, [allExpanded, allFiles, fileDiffs, projectId, normalizeDiffEntry, t]);

  const renderGitFile = (f, stageAction) => {
    const label = GIT_STATUS_LABELS[f.status] || f.status;
    const colorCls = GIT_STATUS_COLORS[f.status] || 'text-zinc-400';
    const desc = getGitStatusDesc(f.status, t);
    const fileName = f.path.split('/').pop();
    const dirPath = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const isExpanded = expandedFiles.has(f.path);
    const diffEntry = fileDiffs[f.path];
    const diffText = typeof diffEntry === 'string' ? diffEntry : diffEntry?.diff;
    const diffBinary = Boolean(diffEntry && typeof diffEntry === 'object' && diffEntry.binary);
    const diffTruncated = Boolean(diffEntry && typeof diffEntry === 'object' && diffEntry.truncated);
    const isLoading = loadingDiff === f.path;

    return (
      <div key={f.path}>
        <div className="flex items-center group hover:bg-[#E8EAED]">
          <button
            onClick={() => toggleFileExpand(f.path)}
            className="shrink-0 p-0.5 text-zinc-400 hover:text-zinc-600"
          >
            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          <button
            onClick={() => toggleFileExpand(f.path)}
            className={`flex items-center gap-2 flex-1 min-w-0 px-2 py-1.5 text-left transition-colors ${consoleButtonFocusClass}`}
          >
            <span className={`w-4 text-center font-mono text-[11px] font-semibold ${colorCls} shrink-0`}>
              {label}
            </span>
            <span className="truncate text-[#202124] text-xs">{fileName}</span>
            {dirPath && (
              <span className="truncate text-[#9AA0A6] text-[10px]">{dirPath}</span>
            )}
            <span className="ml-auto text-[#9AA0A6] text-[10px] shrink-0">{desc}</span>
          </button>
          {stageAction && (
            <button
              onClick={() => stageAction(f.path)}
              title={stageAction === handleStageFile ? t('git:action.stage', { defaultValue: 'Stage' }) : t('git:action.unstage', { defaultValue: 'Unstage' })}
              className={`shrink-0 p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-[#DADCE0] transition-opacity ${consoleButtonFocusClass}`}
            >
              {stageAction === handleStageFile ? (
                <Plus className="h-3 w-3" />
              ) : (
                <Minus className="h-3 w-3" />
              )}
            </button>
          )}
          <button
            onClick={() => handleDiscardFile(f.path)}
            title={t('git:action.discard_changes', { defaultValue: 'Discard changes' })}
            className={`shrink-0 p-1 rounded text-zinc-400 hover:text-[#C06C5D] hover:bg-[#DADCE0] transition-opacity ${consoleButtonFocusClass}`}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
        {isExpanded && (
          <div className="border-t border-[#E8EAED] bg-[#FAFAFA]">
            {isLoading ? (
              <div className="flex items-center justify-center py-4 text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : diffEntry != null ? (
              diffBinary ? (
                <div className="px-3 py-3 text-[11px] text-zinc-500" data-testid="inline-diff-binary">
                  {t('git:empty.binary_file', { defaultValue: 'Binary file, cannot display text diff' })}
                </div>
              ) : (
                <div className="text-[11px] leading-relaxed overflow-x-auto font-mono select-text"
                     style={{ tabSize: 4, MozTabSize: 4 }}>
                  {renderDiffLines(diffText)}
                  {diffTruncated && (
                    <div className="px-2 py-1 text-amber-700 bg-amber-50 border-t border-amber-200" data-testid="inline-diff-truncated">
                      {t('git:empty.content_truncated', { defaultValue: 'Content too large, truncated' })}
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

  return (
    <div className="flex flex-col h-full min-h-0 w-full">
      <div className="flex items-center justify-between gap-2 border-b border-[#E8EAED] px-3 py-1.5 shrink-0">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-500">
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="font-mono truncate">{branch || '—'}</span>
          {gitChanges?.ahead > 0 && (
            <span className="flex items-center gap-0.5 text-[#4A7C59] shrink-0">
              <ArrowUp className="h-2.5 w-2.5" />{gitChanges.ahead}
            </span>
          )}
          {gitChanges?.behind > 0 && (
            <span className="flex items-center gap-0.5 text-[#C06C5D] shrink-0">
              <ArrowDown className="h-2.5 w-2.5" />{gitChanges.behind}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {gitHasChanges && (
            <button
              title={allExpanded ? t('git:action.collapse_all', { defaultValue: 'Collapse all' }) : t('git:action.expand_all', { defaultValue: 'Expand all' })}
              onClick={toggleExpandAll}
              className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-[#E8EAED] ${consoleButtonFocusClass}`}
            >
              {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
            </button>
          )}
          {gitHasChanges && (
            <button
              title={t('git:action.file_list', { defaultValue: 'File list' })}
              onClick={() => setShowFileList((v) => !v)}
              className={`p-1 rounded ${showFileList ? 'text-[#202124] bg-[#E8EAED]' : 'text-zinc-400 hover:text-zinc-600 hover:bg-[#E8EAED]'} ${consoleButtonFocusClass}`}
            >
              <FileText className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            title={t('common:action.refresh')}
            onClick={() => gitChanges?.fetchStatus()}
            className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-[#E8EAED] ${consoleButtonFocusClass}`}
          >
            <RefreshCw className="h-3 w-3" />
          </button>
          {onCollapse && (
            <button
              title={t('git:action.collapse_sidebar', { defaultValue: 'Collapse sidebar' })}
              onClick={onCollapse}
              className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-[#E8EAED] ${consoleButtonFocusClass}`}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <div className="flex flex-col h-full min-h-0 relative">
          {showFileList && (
            <div className="absolute right-2 top-1 z-20 w-56 max-h-64 overflow-y-auto console-scroll-hidden bg-white border border-[#E8EAED] rounded-lg shadow-lg">
              <div className="px-3 py-2 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider border-b border-[#E8EAED] sticky top-0 bg-white">
                Files ({gitStagedFiles.length + gitUnstagedFiles.length})
              </div>
              <div className="py-1">
                {gitStagedFiles.length > 0 && (
                  <div className="text-[9px] text-zinc-400 px-3 py-0.5">{t('git:staged')}</div>
                )}
                {gitStagedFiles.map((f) => {
                  const name = f.path.split('/').pop();
                  const label = GIT_STATUS_LABELS[f.status] || f.status;
                  return (
                    <button
                      key={'list-' + f.path}
                      onClick={() => { toggleFileExpand(f.path); setShowFileList(false); onJumpToFile?.(f.path); }}
                      className={`w-full text-left px-3 py-1 text-xs truncate hover:bg-[#F4F5F6] ${consoleButtonFocusClass}`}
                    >
                      <span className={`font-mono text-[9px] mr-1.5 ${GIT_STATUS_COLORS[f.status] || 'text-zinc-400'}`}>
                        {label}
                      </span>
                      {name}
                    </button>
                  );
                })}
                {gitUnstagedFiles.length > 0 && (
                  <div className="text-[9px] text-zinc-400 px-3 py-0.5 mt-0.5">{t('git:changes')}</div>
                )}
                {gitUnstagedFiles.map((f) => {
                  const name = f.path.split('/').pop();
                  const label = GIT_STATUS_LABELS[f.status] || f.status;
                  return (
                    <button
                      key={'list-' + f.path}
                      onClick={() => { toggleFileExpand(f.path); setShowFileList(false); onJumpToFile?.(f.path); }}
                      className={`w-full text-left px-3 py-1 text-xs truncate hover:bg-[#F4F5F6] ${consoleButtonFocusClass}`}
                    >
                      <span className={`font-mono text-[9px] mr-1.5 ${GIT_STATUS_COLORS[f.status] || 'text-zinc-400'}`}>
                        {label}
                      </span>
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-y-auto console-scroll-hidden">
            {conflictFiles.length > 0 && (
              <div className="border-b border-[#E8EAED]">
                <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[#E8EAED] bg-amber-50">
                  <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
                  <span className="text-[10px] font-semibold text-amber-700 uppercase tracking-wider">
                    {t('git:conflicts', { count: conflictFiles.length, defaultValue: 'Conflicts ({{count}})' })}
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
                <p className="text-[10px]">{t('git:empty.no_saved_changes', { defaultValue: 'No saved changes' })}</p>
              </div>
            ) : (
              <div className="flex flex-col">
                {gitStagedFiles.length > 0 && (
                  <>
                    <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#E8EAED]">
                      <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                        {t('git:staged', { count: gitStagedFiles.length, defaultValue: 'Staged ({{count}})' })}
                      </span>
                      <button
                        onClick={handleUnstageAll}
                        title="Unstage all"
                        className={`text-[10px] text-zinc-400 hover:text-zinc-600 ${consoleButtonFocusClass}`}
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                    </div>
                    {gitStagedFiles.map((f) => renderGitFile(f, handleUnstageFile))}
                  </>
                )}
                {gitUnstagedFiles.length > 0 && (
                  <>
                    <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#E8EAED]">
                      <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                        Changes ({gitUnstagedFiles.length})
                      </span>
                      <button
                        onClick={handleStageAll}
                        title="Stage all"
                        className={`text-[10px] text-zinc-400 hover:text-zinc-600 ${consoleButtonFocusClass}`}
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                    {gitUnstagedFiles.map((f) => renderGitFile(f, handleStageFile))}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5 px-3 py-2 border-t border-[#E8EAED] shrink-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[#5F6368]">
                {changeCount > 0 ? `${changeCount} change${changeCount === 1 ? '' : 's'}` : 'No changes'}
                {gitChanges?.ahead > 0 ? ` · ↑${gitChanges.ahead}` : ''}
              </span>
              <div className="flex items-stretch shrink-0">
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={!commitMessage.trim() || (gitStagedFiles.length === 0 && gitUnstagedFiles.length === 0) || committing || gitChanges?.operation === 'commit'}
                  className={`${buttonClass('primary', 'sm')} h-7 rounded-r-none px-3 text-xs ${consoleButtonFocusClass}`}
                >
                  {committing || gitChanges?.operation === 'commit' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : gitStagedFiles.length === 0 && gitUnstagedFiles.length > 0 ? 'Stage All & Commit' : 'Commit'}
                </button>
                <button
                  ref={actionMenuBtnRef}
                  type="button"
                  title="More actions"
                  onClick={() => setActionMenuOpen((v) => !v)}
                  className={`${buttonClass('primary', 'sm')} h-7 rounded-l-none border-l border-white/20 px-1.5 ${consoleButtonFocusClass}`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            {gitStagedFiles.length + gitUnstagedFiles.length > 0 && (
              <textarea
                placeholder="Commit message"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    handleCommit();
                  }
                }}
                rows={2}
                className="w-full text-xs px-2 py-1 rounded border border-[#DADCE0] bg-white resize-none focus:outline-none focus:border-[#5B8DB8]"
              />
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
            disabled={!commitMessage.trim() || gitStagedFiles.length === 0 || committing}
            onClick={() => { setActionMenuOpen(false); handleCommit(); }}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 ${consoleButtonFocusClass}`}
          >
            <GitCommit className="h-3.5 w-3.5" />
            Commit
          </button>
          {gitChanges?.behind > 0 && (
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
              Pull ({gitChanges.behind})
            </button>
          )}
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
              Push{gitChanges?.ahead > 0 ? ` (${gitChanges.ahead})` : ''}
            </button>
          )}
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
              onClick={() => { setActionMenuOpen(false); handleDiscardAll(); }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-[#C06C5D] hover:bg-red-50 disabled:opacity-40 ${consoleButtonFocusClass}`}
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
      />

      {/* Author dialog */}
      {showAuthorDialog && (
        <ConsoleDialogShell onClose={() => setShowAuthorDialog(false)} panelClassName="w-80">
          <div className="px-5 pt-5 pb-2">
            <h3 className="text-sm font-semibold text-[#202124]">Set Git author info</h3>
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
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-[#E8EAED]">
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
    </div>
  );
}