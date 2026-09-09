import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
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
import * as githubApi from '../lib/githubApi';
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
  'R ': 'text-zinc-900',
};

function getGitStatusDesc(status, t) {
  switch (status) {
    case 'M ':
    case ' M':
    case 'MM':
      return t('git:status.modified');
    case 'A ':
    case 'AM':
      return t('git:status.added');
    case 'D ':
      return t('git:status.deleted');
    case '??':
      return t('git:status.untracked');
    case 'R ':
      return t('git:status.renamed');
    default:
      return '';
  }
}

function isDirEntry(f) {
  return f?.type === 'untracked-dir' || (typeof f?.path === 'string' && f.path.endsWith('/'));
}

/**
 * 把变更文件构建为目录树。多仓库场景传入 stripPrefix（如 `frontend`），
 * 该仓库的路径在树结构上剥掉仓库前缀（仅影响展示层级），
 * 文件条目本身保留完整 `<subPath>/...` 路径，diff/discard/跳转不受影响。
 */
function buildTree(files, stripPrefix) {
  const root = { dirs: {}, files: [] };
  for (const f of files) {
    let p = isDirEntry(f) ? f.path.replace(/\/$/, '') : f.path;
    if (stripPrefix) {
      const pre = `${stripPrefix}/`;
      if (p.startsWith(pre)) p = p.slice(pre.length);
    }
    if (!p) continue;
    const parts = p.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      node.dirs[part] = node.dirs[part] || { dirs: {}, files: [] };
      node = node.dirs[part];
    }
    node.files.push(f);
  }
  return root;
}

export default function SourceControlPanel({ projectId, gitChanges, onJumpToFile, onCollapse, provider, sessionLive }) {
  const { t } = useTranslation();
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
  // per-repo commit：commitTarget 非 null 时，提交弹窗只作用于该 repo（null = 提交全部仓库）。
  // 必须在 handleCommit/handleGenerateMessage/handleAuthorConfirm 之前声明——它们的依赖数组在
  // const 声明前求值会触发 TDZ（ReferenceError: can't access lexical declaration 'commitTarget'），
  // 生产构建压缩后表现为 "can't access lexical declaration 'at' before initialization"。
  const [commitTarget, setCommitTarget] = useState(null);
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

  // ─── 多仓库（VSCode multi-root worktree 风格）───
  // 服务端聚合 status 附带 repos[] 每仓库明细（含前缀路径 + 各自 branch/ahead），
  // 前端据此把 Changes 面板按仓库分组展示，并可对单个仓库 push。
  // 必须在 handleCommit/handleAuthorConfirm 之前声明：它们的依赖数组引用 repoGroups，
  // 后置声明会让依赖数组在 const 初始化前求值 → TDZ（生产压缩后 "can't access
  // lexical declaration 'at' before initialization"，xensemble 实测白屏）。
  const multiRepos = gitChanges?.multiRepo && Array.isArray(gitChanges?.repos) ? gitChanges.repos : [];
  const repoGroups = useMemo(() => {
    if (multiRepos.length === 0) return [];
    return multiRepos.map((repo) => {
      const seen = new Set();
      const files = [];
      for (const f of [...(repo.stagedFiles || []), ...(repo.unstagedFiles || [])]) {
        if (f?.path && !seen.has(f.path)) { seen.add(f.path); files.push(f); }
      }
      return { ...repo, files, count: files.length };
    });
  }, [multiRepos]);

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
      title: t('workspace:action.discard_dialog_title', { defaultValue: 'Discard Changes' }),
      message: t('workspace:action.discard_dialog_message', { path, defaultValue: `Discard changes to ${path}? This cannot be undone.` }),
      confirmLabel: t('workspace:action.discard_confirm_label', { defaultValue: 'Discard' }),
    });
  }, [t]);

  const requestDiscardAll = useCallback(() => {
    const allPaths = [...gitStagedFiles, ...gitUnstagedFiles].map((f) => f.path).filter(Boolean);
    if (allPaths.length === 0) return;
    setDiscardConfirm({
      kind: 'all',
      paths: allPaths,
      title: t('workspace:action.discard_all_dialog_title', { defaultValue: 'Discard All Changes' }),
      message: t('workspace:action.discard_all_dialog_message', { count: allPaths.length, defaultValue: `Discard all ${allPaths.length} change(s)? This cannot be undone.` }),
      confirmLabel: t('workspace:action.discard_all'),
    });
  }, [gitStagedFiles, gitUnstagedFiles, t]);

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
      const author = authorName && authorEmail ? { name: authorName, email: authorEmail } : undefined;
      if (commitTarget) {
        // per-repo：只暂存该 repo 的未暂存文件，并按 repo_id 提交
        const targetRepo = repoGroups.find((r) => r.id === commitTarget.repoId);
        const unstagedPaths = (targetRepo?.unstagedFiles || []).map((f) => f.path).filter(Boolean);
        if (unstagedPaths.length > 0) {
          await githubApi.stageFiles(projectId, unstagedPaths);
        }
        await githubApi.commitStaged(projectId, commitMessage.trim(), author, commitTarget.repoId);
      } else {
        // 全部：暂存所有未暂存文件后提交（现有逻辑）
        const unstagedPaths = gitUnstagedFiles.map((f) => f.path).filter(Boolean);
        if (unstagedPaths.length > 0) {
          await gitChanges?.stage(unstagedPaths);
        }
        await gitChanges?.commit(commitMessage.trim(), author);
      }
      setCommitMessage('');
      setShowCommitDialog(false);
      setCommitTarget(null);
      showToast('success', 'Committed.');
      gitChanges?.fetchStatus?.({ silent: true });
    } catch (err) {
      if (err.code === 'AUTHOR_REQUIRED' || (err.message && err.message.includes('author'))) {
        setShowAuthorDialog(true);
        return;
      }
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, gitChanges, authorName, authorEmail, gitUnstagedFiles, commitTarget, repoGroups, projectId]);

  const handleGenerateMessage = useCallback(async () => {
    setGeneratingMsg(true);
    try {
      // per-repo 提交时按 repo_id 生成对应仓库的 commit message
      const body = commitTarget ? JSON.stringify({ repo_id: commitTarget.repoId }) : '{}';
      const res = await apiFetch(withSessionId(`/api/v1/projects/${encodeURIComponent(projectId)}/git/commit-message`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('git:error.generate_message_failed'));
      if (data.message) setCommitMessage(data.message);
      else showToast('error', data.error || 'No changes to describe');
    } catch (err) {
      showToast('error', err.message || t('git:error.generate_message_failed'));
    } finally {
      setGeneratingMsg(false);
    }
  }, [projectId, showToast, commitTarget]);

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
      if (commitTarget) {
        const targetRepo = repoGroups.find((r) => r.id === commitTarget.repoId);
        const unstagedPaths = (targetRepo?.unstagedFiles || []).map((f) => f.path).filter(Boolean);
        if (unstagedPaths.length > 0) {
          await githubApi.stageFiles(projectId, unstagedPaths);
        }
        await githubApi.commitStaged(projectId, commitMessage.trim(), author, commitTarget.repoId);
      } else {
        await gitChanges?.commit(commitMessage.trim(), author);
      }
      setCommitMessage('');
      setShowCommitDialog(false);
      setCommitTarget(null);
      gitChanges?.fetchStatus?.({ silent: true });
    } catch (_) {
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, gitChanges, authorName, authorEmail, commitTarget, repoGroups, projectId]);

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
          const data = await githubApi.getGitFileDiff(projectId, filePath);
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
  // 目录条目（如折叠的 node_modules）没有 diff，不参与逐文件展开
  const expandableFiles = useMemo(() => allFiles.filter((f) => !isDirEntry(f)), [allFiles]);
  const allExpanded = expandableFiles.length > 0 && expandableFiles.every((f) => expandedFiles.has(f.path));

  const toggleExpandAll = useCallback(async () => {
    if (allExpanded) {
      setExpandedFiles(new Set());
      return;
    }
    const newExpanded = new Set(expandableFiles.map((f) => f.path));
    setExpandedFiles(newExpanded);
    const toFetch = expandableFiles.filter((f) => !fileDiffs[f.path]).map((f) => f.path);
    if (toFetch.length === 0) return;
    setLoadingDiff('batch');
    try {
      const results = await Promise.all(
        toFetch.map((p) => githubApi.getGitFileDiff(projectId, p)
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
  }, [allExpanded, expandableFiles, fileDiffs, projectId, normalizeDiffEntry]);

  // Build a directory tree from the deduped changed files.
  // 目录条目（node_modules/ 等）：尾斜杠剥离后整体作为一个"文件节点"
  // 渲染为目录行，不能再按 / 切分建目录树，否则会展开出上万子节点
  const changesTree = useMemo(() => buildTree(allFiles), [allFiles]);

  const [collapsedDirs, setCollapsedDirs] = useState(() => new Set());
  const toggleDir = useCallback((dirPath) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath); else next.add(dirPath);
      return next;
    });
  }, []);

  const [collapsedRepos, setCollapsedRepos] = useState(() => new Set());
  const toggleRepoCollapse = useCallback((id) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const [pushingRepo, setPushingRepo] = useState(null);
  const pushRepo = useCallback(async (repo) => {
    setActionMenuOpen(false);
    setPushingRepo(repo.id);
    try {
      await githubApi.pushBranch(projectId, repo.branch || undefined, repo.id);
      showToast('success', t('git:toast.repo_pushed', { repo: repo.subPath, defaultValue: `${repo.subPath} pushed.` }));
    } catch (err) {
      showToast('error', err.message || t('git:toast.push_failed_repo', { repo: repo.subPath, error: err.message, defaultValue: `Failed to push ${repo.subPath}` }));
    } finally {
      setPushingRepo(null);
      gitChanges?.fetchStatus?.({ silent: true });
    }
  }, [projectId, showToast, gitChanges, t]);

  const [pullingRepo, setPullingRepo] = useState(null);
  const pullRepo = useCallback(async (repo) => {
    setPullingRepo(repo.id);
    try {
      await githubApi.pullLatest(projectId, { repoId: repo.id });
      showToast('success', t('git:toast.pulled_latest', { defaultValue: 'Pulled latest changes.' }));
    } catch (err) {
      if (err.code === 'pull_conflict') {
        showToast('error', t('git:pull_conflict_message', { defaultValue: 'There are conflicts between your local changes and the remote.' }));
      } else {
        showToast('error', err.message || 'Pull failed');
      }
    } finally {
      setPullingRepo(null);
      gitChanges?.fetchStatus?.({ silent: true });
    }
  }, [projectId, showToast, gitChanges, t]);

  const openCommitForRepo = useCallback((repo) => {
    setCommitTarget({ repoId: repo.id, subPath: repo.subPath });
    setShowCommitDialog(true);
  }, []);
  const closeCommitDialog = useCallback(() => {
    setShowCommitDialog(false);
    setCommitTarget(null);
  }, []);

  const renderFileRow = (f, depth) => {
    // 折叠的 untracked 大目录（服务端下发 type=untracked-dir + count）：
    // 渲染为目录行 + 文件数徽标，无 diff/展开/丢弃操作
    if (isDirEntry(f)) {
      const dirName = f.path.replace(/\/$/, '');
      return (
        <div key={f.path}>
          <div className="flex items-center group hover:bg-zinc-50" style={{ paddingLeft: depth * 12 }}>
            <span className="shrink-0 p-0.5 w-4" aria-hidden="true" />
            <div className="flex items-center gap-2 flex-1 min-w-0 px-1.5 py-1.5" title={f.path}>
              <span className="w-3.5 text-center font-mono text-[11px] font-semibold text-emerald-600 shrink-0" title={t('git:status.untracked')}>U</span>
              <Folder className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              <span className="truncate text-zinc-900 text-xs">{dirName.split('/').pop()}/</span>
              <span className="truncate text-zinc-400 text-[10px]">{dirName.includes('/') ? dirName.slice(0, dirName.lastIndexOf('/')) : ''}</span>
              {f.count != null && (
                <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-zinc-100 border border-zinc-200 text-[10px] text-zinc-500" data-testid="untracked-dir-count">
                  {t('workspace:label.untracked_dir_files', { count: f.count })}
                </span>
              )}
            </div>
          </div>
        </div>
      );
    }
    const label = GIT_STATUS_LABELS[f.status] || f.status;
    const colorCls = GIT_STATUS_COLORS[f.status] || 'text-zinc-400';
    const desc = getGitStatusDesc(f.status, t);
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
            title={isExpanded ? t('workspace:action.collapse_diff') : t('workspace:action.expand_diff')}
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
            title={t('workspace:action.discard_changes')}
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
                  {t('workspace:label.binary_file')}
                </div>
              ) : (
                <div className="text-[11px] leading-relaxed overflow-x-auto font-mono select-text"
                     style={{ tabSize: 4, MozTabSize: 4 }}>
                  <DiffText diff={diffText} />
                  {diffTruncated && (
                    <div className="px-2 py-1 text-amber-700 bg-amber-50 border-t border-amber-200" data-testid="inline-diff-truncated">
                      {t('workspace:label.content_truncated')}
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
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-[11px] font-medium text-amber-700" title={t('workspace:label.unpushed_title', { count: gitChanges.ahead })}>
              <Upload className="h-3 w-3" />
              {gitChanges.ahead} {t('workspace:label.unpushed')}
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
                title={t('workspace:action.stage_all_and_commit')}
                className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
              >
                {committing || gitChanges?.operation === 'commit' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GitCommit className="h-3.5 w-3.5" />
                )}
                {t('git:commit')}
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
                {t('git:push')}{gitChanges?.ahead > 1 ? ` (${gitChanges.ahead})` : ''}
              </button>
            ) : (
              <button
                type="button"
                onClick={handlePull}
                disabled={pulling || gitChanges?.operation === 'pull'}
                title={t('workspace:action.pull_latest')}
                className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
              >
                {pulling || gitChanges?.operation === 'pull' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {t('git:pull')}
              </button>
            )}
            <button
              ref={actionMenuBtnRef}
              type="button"
              onClick={() => setActionMenuOpen((v) => !v)}
              title={t('workspace:action.more_git_actions')}
              aria-label={t('workspace:action.more_git_actions')}
              aria-haspopup="menu"
              aria-expanded={actionMenuOpen}
              className={`flex items-center px-1.5 text-zinc-500 hover:bg-zinc-100 border-l border-zinc-200 ${consoleButtonFocusClass} ${actionMenuOpen ? 'bg-zinc-100 text-zinc-900' : ''}`}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
          {gitHasChanges && (
            <button
              title={allExpanded ? t('workspace:action.collapse_all') : t('workspace:action.expand_all')}
              onClick={toggleExpandAll}
              className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
            >
              {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
            </button>
          )}
          <button
            title={t('workspace:action.refresh')}
            onClick={() => gitChanges?.fetchStatus()}
            className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
          >
            <RefreshCw className="h-3 w-3" />
          </button>
          {onCollapse && (
            <button
              title={t('workspace:action.collapse_sidebar')}
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
            {!gitHasChanges && conflictFiles.length === 0 && repoGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 gap-2 text-zinc-400">
                <GitCommit className="h-6 w-6" />
                <p className="text-[10px]">{t('git:empty.no_changes_yet', { defaultValue: 'No changes yet' })}</p>
                <p className="text-[10px] text-zinc-400">{t('git:empty.no_changes_yet_hint', { defaultValue: 'Let the agent edit some code first.' })}</p>
              </div>
            ) : (
              <div className="flex flex-col">
                {gitChanges?.truncated && (
                  <div className="px-2 py-1 text-[10px] text-amber-700 bg-amber-50 border-b border-amber-200" data-testid="git-changes-truncated">
                    {t('workspace:label.changes_truncated')}
                  </div>
                )}
                {repoGroups.length > 0 ? (
                  repoGroups.map((repo) => {
                    const collapsed = collapsedRepos.has(repo.id);
                    const tree = buildTree(repo.files, repo.subPath);
                    const hasFiles = repo.count > 0;
                    return (
                      <div key={repo.id} className="border-b border-zinc-200">
                        <div className="flex items-center gap-1.5 px-2 py-1.5 bg-zinc-100/80 sticky top-0 z-10 border-b border-zinc-200">
                          <button
                            type="button"
                            onClick={() => toggleRepoCollapse(repo.id)}
                            title={collapsed ? t('workspace:action.expand_all') : t('workspace:action.collapse_all')}
                            className={`shrink-0 p-0.5 text-zinc-500 hover:text-zinc-700 ${consoleButtonFocusClass}`}
                          >
                            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleRepoCollapse(repo.id)}
                            className={`flex items-center gap-1.5 min-w-0 text-left ${consoleButtonFocusClass}`}
                          >
                            <span className="truncate text-[11px] font-semibold text-zinc-800">{repo.subPath}</span>
                            {repo.branch && (
                              <span className="truncate font-mono text-[10px] text-zinc-400">{repo.branch}</span>
                            )}
                          </button>
                          <span className="ml-auto shrink-0 text-[10px] text-zinc-400">
                            {hasFiles
                              ? t('workspace:label.changed_count', { count: repo.count, defaultValue: `${repo.count} changed` })
                              : t('workspace:label.no_changes_repo', { defaultValue: 'No changes' })}
                          </span>
                          {/* 与单仓库顶部一致的按钮组：按仓库状态切换 Commit / Push / Pull */}
                          <div className="flex items-stretch shrink-0 rounded-md border border-zinc-200 overflow-hidden">
                            {hasFiles ? (
                              <button
                                type="button"
                                onClick={() => openCommitForRepo(repo)}
                                disabled={committing || gitChanges?.operation === 'commit'}
                                title={t('workspace:action.stage_all_and_commit')}
                                className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
                              >
                                {committing || gitChanges?.operation === 'commit' ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <GitCommit className="h-3.5 w-3.5" />
                                )}
                                {t('git:commit')}
                              </button>
                            ) : repo.ahead > 0 ? (
                              <button
                                type="button"
                                onClick={() => pushRepo(repo)}
                                disabled={pushingRepo === repo.id || gitChanges?.operation === 'push'}
                                title={t('workspace:label.unpushed_title', { count: repo.ahead, defaultValue: `${repo.ahead} committed but not pushed` })}
                                className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
                              >
                                {pushingRepo === repo.id || gitChanges?.operation === 'push' ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Upload className="h-3.5 w-3.5" />
                                )}
                                {t('git:push')}{repo.ahead > 1 ? ` (${repo.ahead})` : ''}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => pullRepo(repo)}
                                disabled={pullingRepo === repo.id || gitChanges?.operation === 'pull'}
                                title={t('workspace:action.pull_latest', { defaultValue: 'Pull latest changes' })}
                                className={`flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:pointer-events-none ${consoleButtonFocusClass}`}
                              >
                                {pullingRepo === repo.id || gitChanges?.operation === 'pull' ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Download className="h-3.5 w-3.5" />
                                )}
                                {t('git:pull')}{repo.behind > 0 ? ` (${repo.behind})` : ''}
                              </button>
                            )}
                          </div>
                        </div>
                        {!collapsed && (
                          <div className="flex flex-col">
                            {hasFiles ? renderNodes(tree, 0, '') : null}
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  renderNodes(changesTree, 0, '')
                )}
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
            {t('git:pull')}{gitChanges?.behind > 0 ? ` (${gitChanges.behind})` : ''}
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
              {t('git:push')}{gitChanges?.ahead > 0 ? ` (${gitChanges.ahead})` : ''}
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
            {t('git:commit')}
          </button>
          {!isLocalGit && (
            <button
              type="button"
              role="menuitem"
              disabled={!branch}
              onClick={handleOpenCreatePR}
              title={t('workspace:action.create_pr_hint')}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 ${consoleButtonFocusClass}`}
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              {t('git:create_pr')}
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
              {t('workspace:action.discard_all')}
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
        onCreated={() => { setCreatePROpen(false); gitChanges?.fetchStatus?.({ silent: true }); showToast('success', t('git:toast.pr_created')); }}
      />

      {/* Commit dialog */}
      {showCommitDialog && (
        <ConsoleDialogShell onClose={closeCommitDialog} panelClassName={consoleDialogSmClass}>
          <div className="px-5 pt-5 pb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-900">
              {commitTarget
                ? t('workspace:dialog.stage_commit_title_repo', { repo: commitTarget.subPath, defaultValue: `Commit changes in ${commitTarget.subPath}` })
                : t('workspace:dialog.stage_commit_title')}
            </h3>
          </div>
          <div className="px-5 pb-5 flex flex-col gap-3">
            <textarea
              ref={commitMsgRef}
              placeholder={generatingMsg ? t('git:commit_ai_generating', { defaultValue: 'AI is generating…' }) : t('workspace:dialog.commit_placeholder')}
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
                  : t('workspace:label.no_author')}
              </span>
              <button
                type="button"
                onClick={() => setShowAuthorDialog(true)}
                className={`text-xs text-zinc-900 hover:text-zinc-800 shrink-0 ${consoleButtonFocusClass}`}
              >
                {authorName ? t('workspace:action.edit') : t('workspace:action.set')}
              </button>
            </div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-200">
            <button
              type="button"
              onClick={closeCommitDialog}
              className={buttonClass('secondary', 'sm')}
            >
              {t('workspace:action.cancel')}
            </button>
            <button
              type="button"
              onClick={handleCommit}
              disabled={!commitMessage.trim() || committing}
              className={buttonClass('primary', 'sm')}
            >
              {committing ? t('workspace:action.committing') : t('workspace:action.stage_and_commit')}
            </button>
          </div>
        </ConsoleDialogShell>
      )}

      {/* Author dialog */}
      {showAuthorDialog && (
        <ConsoleDialogShell onClose={() => setShowAuthorDialog(false)} panelClassName={consoleDialogSmClass}>
          <div className="px-5 pt-5 pb-2">
            <h3 className="text-sm font-semibold text-zinc-900">{t('workspace:dialog.set_author_title')}</h3>
          </div>
          <div className="px-5 pb-5 flex flex-col gap-3">
            <input
              ref={authorNameRef}
              type="text"
              placeholder={t('workspace:dialog.name')}
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              className={`w-full ${consoleInputClass} text-xs`}
            />
            <input
              type="email"
              placeholder={t('workspace:dialog.email')}
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
              {t('workspace:action.cancel')}
            </button>
            <button
              onClick={handleAuthorConfirm}
              disabled={!authorName.trim() || !authorEmail.trim()}
              className={buttonClass('primary', 'sm')}
            >
              {t('workspace:dialog.confirm')}
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
            className="pointer-events-auto w-full max-w-sm rounded-lg border border-zinc-200 bg-surface shadow-lg"
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
                {t('workspace:action.cancel')}
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