import { useState, useCallback, useEffect, useRef, useMemo, memo, lazy, Suspense, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText, Files, FolderPlus, Plus, PanelLeftClose, PanelLeft, Loader2,
  Terminal, Globe, GitBranch, GitPullRequest, X, ArrowLeft,
  Trash2, Pencil, ClipboardCopy, FilePlus, Rocket,
} from 'lucide-react';
import WorkspaceFileTree from './WorkspaceFileTree';
import CodeEditor from './CodeEditorLazy';
import { ConsoleDialogShell } from './ConsoleDialog';
import { confirm } from './ConfirmDialog';
import { WorkspacePanelPanelContext } from './workspacePanelContext';
import SourceControlPanel from './SourceControlPanel';
import WorkspaceBrowserPane from './WorkspaceBrowserPane';
import MergeRequestListPanel from './git/MergeRequestListPanel';
import CodeReviewPanel from './git/CodeReviewPanel';
import CreatePRDialog from './git/CreatePRDialog';
import { consoleButtonFocusClass, consoleInputClass } from '@/lib/consoleTokens';
import { consoleDropdownPanelClass, consoleMenuDropdownZClass } from '@/lib/consoleTokens';
import { buttonClass } from '@/lib/buttonStyles';
import { pathBasename, pathJoin } from '@/lib/workspaceFileTree';
import { useTranslation } from 'react-i18next';

const DiffViewer = lazy(() => import('./DiffViewer'));

function DiffViewerFallback() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
    </div>
  );
}

const PINNED_TAB_DEFS = [
  { key: 'files', labelKey: 'workspace:files', icon: Files },
  { key: 'changes', labelKey: 'workspace:tabs.changes', icon: GitBranch },
];

const ADDABLE_TAB_DEFS = [
  { key: 'pullrequests', labelKey: 'git:pull_requests', icon: GitPullRequest },
  { key: 'terminal', labelKey: 'workspace:tabs.terminal', icon: Terminal },
  { key: 'browser', labelKey: 'workspace:tabs.browser', icon: Globe },
  { key: 'deploy', labelKey: 'workspace:tabs.deploy', icon: Rocket },
];

const ADDABLE_KEYS = new Set(ADDABLE_TAB_DEFS.map((t) => t.key));

function migrateTabKey(key) {
  if (key === 'git') return 'changes';
  if (key === 'shell') return 'terminal';
  return key;
}

function readExtraTabs(sessionId) {
  try {
    const raw = sessionId
      ? sessionStorage.getItem(`xe_extra_tabs_${sessionId}`)
      : sessionStorage.getItem('xe_extra_tabs');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // deploy 面板也恢复：部署进行中时切走/刷新后能找回进度（DeployPanel 挂载会查状态，
        // 有进行中则恢复、无则才部署，不会因恢复 tab 而重复部署）。
        // preview 已并入 deploy 面板，不再恢复独立的 preview tab。
        return parsed.map(migrateTabKey).filter((k) => ADDABLE_KEYS.has(k) && k !== 'preview');
      }
    }
  } catch {
    // ignore
  }
  return [];
}

function readMainTab(sessionId, extraTabs) {
  const stored = migrateTabKey(
    (sessionId
      ? sessionStorage.getItem(`xe_main_tab_${sessionId}`)
      : sessionStorage.getItem('xe_main_tab')) || 'files'
  );
  if (stored === 'files' || stored === 'changes') return stored;
  if (extraTabs.includes(stored)) return stored;
  return 'files';
}

const WorkspacePanel = memo(forwardRef(function WorkspacePanel({
  projectId,
  sessionId,
  tabs,
  activePath,
  onSelectTab,
  onCloseTab,
  onSaveTab,
  onOpenFile,
  onFetchDir,
  onCreateFile,
  onCreateDir,
  onShowDiff,
  diffView,
  onCloseDiff,
  gitChanges,
  changesTabActiveRef,
  onGitFileClick,
  gitDiffView,
  onCloseGitDiff,
  provider,
  sessionLive,
  shellContent,
  onShellMount,
  refreshTrigger,
  onDeleteFile,
  onDeleteDir,
  onRenameFile,
  onCopyPath,
  deployContent,
}, ref) {
  const { t } = useTranslation();
  const [showNewFile, setShowNewFile] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createPROpen, setCreatePROpen] = useState(false);
  const [selectedMR, setSelectedMR] = useState(null);
  const [prRefreshTrigger, setPrRefreshTrigger] = useState(0);
  const [contextMenu, setContextMenu] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [renamingLoading, setRenamingLoading] = useState(false);
  const [newHereBasePath, setNewHereBasePath] = useState(null);
  const renameInputRef = useRef(null);
  const panelRootRef = useRef(null);

  useEffect(() => {
    setSelectedMR(null);
  }, [projectId, sessionId]);

  // 切换 session 时恢复该 session 上次的 tab 状态（而非强制切回 files）
  useEffect(() => {
    if (!sessionId) return;
    const savedExtra = readExtraTabs(sessionId);
    const savedMain = readMainTab(sessionId, savedExtra);
    setExtraTabs(savedExtra);
    setMainTab(savedMain);
  }, [sessionId]);

  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const stored = sessionStorage.getItem('xe_sidebar_open');
    return stored !== null ? stored === 'true' : true;
  });
  const [extraTabs, setExtraTabs] = useState(() => readExtraTabs(sessionId));
  const [mainTab, setMainTab] = useState(() => readMainTab(sessionId, readExtraTabs(sessionId)));
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuRect, setAddMenuRect] = useState(null);
  const addBtnRef = useRef(null);
  const newFileInputRef = useRef(null);
  const newFolderInputRef = useRef(null);

  useEffect(() => {
    sessionStorage.setItem('xe_sidebar_open', String(sidebarOpen));
  }, [sidebarOpen]);

  useEffect(() => {
    if (sessionId) {
      sessionStorage.setItem(`xe_main_tab_${sessionId}`, mainTab);
    }
    if (changesTabActiveRef) changesTabActiveRef.current = (mainTab === 'changes');
  }, [mainTab, sessionId, changesTabActiveRef]);

  useEffect(() => {
    if (sessionId) {
      sessionStorage.setItem(`xe_extra_tabs_${sessionId}`, JSON.stringify(extraTabs));
    }
  }, [extraTabs, sessionId]);

  useEffect(() => {
    if (showNewFile && newFileInputRef.current) {
      newFileInputRef.current.focus();
    }
  }, [showNewFile]);

  useEffect(() => {
    if (showNewFolder && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [showNewFolder]);

  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming ? 'open' : 'closed']);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const onDoc = (e) => {
      const menu = document.getElementById('workspace-context-menu');
      if (menu?.contains(e.target)) return;
      setContextMenu(null);
    };
    const onEsc = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setContextMenu(null);
      }
    };
    const onResize = () => setContextMenu(null);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('resize', onResize);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (mainTab === 'terminal') {
      onShellMount?.();
    }
  }, [mainTab, onShellMount]);

  const fetchGitStatus = gitChanges?.fetchStatus;

  useEffect(() => {
    if (!addMenuOpen) {
      setAddMenuRect(null);
      return undefined;
    }
    const update = () => {
      const el = addBtnRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setAddMenuRect({ top: rect.bottom + 4, left: rect.left, width: 200 });
    };
    update();
    const onDoc = (e) => {
      if (addBtnRef.current?.contains(e.target)) return;
      const menu = document.getElementById('workspace-add-menu');
      if (menu?.contains(e.target)) return;
      setAddMenuOpen(false);
    };
    window.addEventListener('resize', update);
    document.addEventListener('mousedown', onDoc);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [addMenuOpen]);

  const handleCreateFile = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const fullPath = newHereBasePath ? pathJoin(newHereBasePath, newName.trim()) : newName.trim();
      await onCreateFile?.(projectId, fullPath);
      setShowNewFile(false);
      setNewName('');
      setNewHereBasePath(null);
    } finally {
      setCreating(false);
    }
  }, [newName, projectId, onCreateFile, newHereBasePath]);

  const handleCreateDir = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const fullPath = newHereBasePath ? pathJoin(newHereBasePath, newName.trim()) : newName.trim();
      await onCreateDir?.(projectId, fullPath);
      setShowNewFolder(false);
      setNewName('');
      setNewHereBasePath(null);
    } finally {
      setCreating(false);
    }
  }, [newName, projectId, onCreateDir, newHereBasePath]);

  const handleContextMenu = useCallback((node, e) => {
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const handleDeleteNode = useCallback(async (node) => {
    setContextMenu(null);
    const label = node.name || node.path;
    const ok = await confirm({
      title: node.type === 'directory' ? t('workspace:dialog.delete_folder', { defaultValue: 'Delete Folder' }) : t('workspace:dialog.delete_file', { defaultValue: 'Delete File' }),
      message: t('workspace:dialog.confirm_delete', { name: label }),
      confirmLabel: t('workspace:action.delete'),
      variant: 'danger',
      container: panelRootRef.current,
    });
    if (!ok) return;
    if (node.type === 'directory') {
      await onDeleteDir?.(projectId, node.path);
    } else {
      await onDeleteFile?.(projectId, node.path);
    }
  }, [projectId, onDeleteFile, onDeleteDir]);

  const handleStartRename = useCallback((node) => {
    setContextMenu(null);
    setRenaming({ node, newName: pathBasename(node.path) });
  }, []);

  const handleConfirmRename = useCallback(async () => {
    if (!renaming || !renaming.newName.trim()) return;
    setRenamingLoading(true);
    try {
      await onRenameFile?.(projectId, renaming.node.path, renaming.newName.trim());
      setRenaming(null);
    } finally {
      setRenamingLoading(false);
    }
  }, [renaming, projectId, onRenameFile]);

  const handleCopyPath = useCallback((node) => {
    setContextMenu(null);
    onCopyPath?.(node.path);
  }, [onCopyPath]);

  const handleNewHere = useCallback((node, type) => {
    setContextMenu(null);
    setNewHereBasePath(node.path);
    setNewName('');
    if (type === 'file') setShowNewFile(true);
    else setShowNewFolder(true);
  }, []);

  const autosaveTimerRef = useRef(null);
  const pendingAutosavePathRef = useRef(null);

  const handleSave = useCallback(async (path) => {
    if (!path) return;
    setSaving(true);
    try {
      await onSaveTab?.(path);
    } finally {
      setSaving(false);
    }
  }, [onSaveTab]);

  const flushAutosave = useCallback(async () => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const path = pendingAutosavePathRef.current;
    pendingAutosavePathRef.current = null;
    if (path) await handleSave(path);
  }, [handleSave]);

  const scheduleAutosave = useCallback((path) => {
    if (!path) return;
    pendingAutosavePathRef.current = path;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      const pendingPath = pendingAutosavePathRef.current;
      pendingAutosavePathRef.current = null;
      if (pendingPath) handleSave(pendingPath).catch(() => {});
    }, 500);
  }, [handleSave]);

  useEffect(() => () => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
  }, []);

  const handleOpenFile = useCallback(async (file) => {
    await flushAutosave();
    return onOpenFile?.(file);
  }, [flushAutosave, onOpenFile]);

  const handleImmediateSave = useCallback(async (path) => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    pendingAutosavePathRef.current = null;
    await handleSave(path);
  }, [handleSave]);

  const selectMainTab = useCallback(async (key) => {
    if (key === 'changes') {
      await flushAutosave().catch(() => {});
      await fetchGitStatus?.({ silent: true });
    }
    if (key === 'files') {
      setSidebarOpen(true);
    }
    setMainTab(key);
  }, [flushAutosave, fetchGitStatus]);

  const addTab = useCallback((key) => {
    setExtraTabs((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setMainTab(key);
    setAddMenuOpen(false);
  }, []);

  const closeExtraTab = useCallback((key) => {
    setExtraTabs((prev) => prev.filter((k) => k !== key));
    setMainTab((current) => (current === key ? 'files' : current));
  }, []);

  // 新创建 workspace / session 时调用：只保留 Files + Changes 两个 tab，回到文件界面
  const resetTabs = useCallback(() => {
    setExtraTabs([]);
    setMainTab('files');
    try {
      if (sessionId) {
        sessionStorage.removeItem(`xe_main_tab_${sessionId}`);
        sessionStorage.removeItem(`xe_extra_tabs_${sessionId}`);
      }
    } catch { /* ignore */ }
  }, []);

  // 暴露给父组件：程序化创建/切换/关闭 tab（一键部署用于创建 Terminal/Preview/Deploy tab）
  useImperativeHandle(ref, () => ({ addTab, selectMainTab, setMainTab, closeExtraTab, resetTabs }), [addTab, selectMainTab, closeExtraTab, resetTabs]);

  const activeTab = tabs.find((t) => t.path === activePath);
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  const gitStagedFiles = gitChanges?.stagedFiles || [];
  const gitUnstagedFiles = gitChanges?.unstagedFiles || [];
  const changeCount = gitStagedFiles.length + gitUnstagedFiles.length;

  const isExternalGit = provider && provider !== 'none' && provider !== 'local_git';

  const visibleTabs = useMemo(() => {
    const pinned = PINNED_TAB_DEFS.map((tab) => ({
      ...tab,
      label: t(tab.labelKey),
      badge: tab.key === 'changes' ? changeCount : undefined,
    }));
    const extras = extraTabs
      .map((key) => ADDABLE_TAB_DEFS.find((tab) => tab.key === key))
      .filter((tab) => {
        if (!tab) return false;
        if (tab.key === 'pullrequests') return isExternalGit;
        return true;
      })
      .map((tab) => ({ ...tab, label: t(tab.labelKey) }));
    return [
      ...pinned,
      ...extras,
    ];
  }, [extraTabs, changeCount, isExternalGit, t]);

  const addableRemaining = ADDABLE_TAB_DEFS.filter((tab) => {
    if (extraTabs.includes(tab.key)) return false;
    // deploy 通过页面右上角的 Deploy 按钮打开，不放进"添加新窗口"菜单
    if (tab.key === 'deploy') return false;
    if (tab.key === 'pullrequests') return isExternalGit;
    return true;
  }).map((tab) => ({ ...tab, label: t(tab.labelKey) }));

  return (
    <div ref={panelRootRef} className="relative flex h-full min-h-0 flex-col" data-testid="workspace-panel">
      <WorkspacePanelPanelContext.Provider value={panelRootRef}>
      <div className="flex items-center border-b border-zinc-200 px-1 shrink-0 bg-surface">
        <div className="flex min-w-0 items-center overflow-x-auto console-scroll-hidden">
          {visibleTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = mainTab === tab.key;
            const closable = ADDABLE_KEYS.has(tab.key);
            return (
              <div key={tab.key} className="relative flex items-center group">
                <button
                  type="button"
                  onClick={() => { void selectMainTab(tab.key); }}
                  className={`relative flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                    isActive
                      ? 'border-zinc-900 text-zinc-900'
                      : 'border-transparent text-zinc-500 hover:text-zinc-900'
                  } ${consoleButtonFocusClass}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                  {tab.badge > 0 && (
                    <span className="ml-0.5 inline-flex items-center justify-center h-3.5 min-w-[14px] rounded-full bg-red-600 text-white text-[9px] font-medium px-1">
                      {tab.badge > 9 ? '9+' : tab.badge}
                    </span>
                  )}
                </button>
                {closable && (
                  <button
                    type="button"
                    title={`Close ${tab.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeExtraTab(tab.key);
                    }}
                    className={`absolute right-0.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200 opacity-0 group-hover:opacity-100 ${consoleButtonFocusClass}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
          <button
            ref={addBtnRef}
            type="button"
            title={t('workspace:action.add_panel', { defaultValue: 'Add panel' })}
            onClick={() => setAddMenuOpen((v) => !v)}
            className={`ml-0.5 p-1.5 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {mainTab === 'files' && (
        <div className="flex items-center justify-end gap-0.5 px-1 py-0.5 border-b border-zinc-200 shrink-0 bg-surface">
          <button title={t('workspace:action.new_file')} onClick={() => { setNewName(''); setShowNewFile(true); }}
            className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}>
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button title={t('workspace:action.new_folder')} onClick={() => { setNewName(''); setShowNewFolder(true); }}
            className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}>
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button
            title={sidebarOpen ? t('workspace:action.collapse_all') : t('workspace:action.expand_all')}
            onClick={() => setSidebarOpen((open) => !open)}
            className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}>
            {sidebarOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeft className="h-3.5 w-3.5" />}
          </button>
          {activeTab && (
            <>
              <span className="mx-1 h-4 w-px bg-zinc-200" />
              <button
                type="button"
                onClick={() => onCloseTab?.(activeTab.path)}
                title={t('workspace:action.close')}
                aria-label={t('workspace:action.close')}
                className={`p-1 rounded text-zinc-400 hover:text-red-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      {addMenuOpen && addMenuRect && createPortal(
        <div
          id="workspace-add-menu"
          className={`fixed ${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} py-1 shadow-lg`}
          style={{ top: addMenuRect.top, left: addMenuRect.left, width: addMenuRect.width }}
          role="menu"
        >
          {addableRemaining.map((tab) => {
            const Icon = tab.icon;
            const alreadyOpen = extraTabs.includes(tab.key);
            return (
              <button
                key={tab.key}
                type="button"
                role="menuitem"
                disabled={alreadyOpen}
                onClick={() => addTab(tab.key)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                  alreadyOpen
                    ? 'text-zinc-400 cursor-default'
                    : 'text-zinc-700 hover:bg-zinc-50'
                } ${consoleButtonFocusClass}`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{tab.label}</span>
                {alreadyOpen && <span className="ml-auto text-[10px] text-zinc-400">Already open</span>}
              </button>
            );
          })}
          {addableRemaining.length === 0 && (
            <div className="px-3 py-2 text-xs text-zinc-400">All panels already open</div>
          )}
        </div>,
        document.body,
      )}

      <div className="flex-1 min-h-0 flex">
        {mainTab === 'files' && (
          <>
            {sidebarOpen && (
              <div className="w-44 shrink-0 border-r border-zinc-200 bg-zinc-100 flex flex-col min-h-0">
                <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1">
                  <WorkspaceFileTree lazy projectId={projectId} sessionId={sessionId} onFetchDir={onFetchDir}
                    selectedPath={activePath} onOpenFile={handleOpenFile}
                    refreshTrigger={refreshTrigger} onContextMenu={handleContextMenu} />
                </div>
              </div>
            )}
            <div className="flex-1 min-w-0 flex flex-col min-h-0">
              {gitDiffView ? (
                <Suspense fallback={<DiffViewerFallback />}>
                  <DiffViewer
                    original={gitDiffView.original}
                    modified={gitDiffView.modified}
                    path={gitDiffView.path}
                    loading={gitDiffView.loading}
                    binary={gitDiffView.binary}
                    truncated={gitDiffView.truncated}
                    onClose={onCloseGitDiff}
                  />
                </Suspense>
              ) : activeTab ? (
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <CodeEditor
                      content={activeTab.content}
                      path={activeTab.path}
                      isBinary={activeTab.isBinary}
                      readOnly={activeTab.isBinary}
                      saving={saving}
                      onSave={() => handleImmediateSave(activeTab.path)}
                      onChange={(value) => {
                        const currentPath = activePathRef.current;
                        onSelectTab?.(currentPath, value);
                        scheduleAutosave(currentPath);
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-400">
                  <FileText className="h-12 w-12" />
                  <p className="text-sm">{t('workspace:empty.no_files')}</p>
                </div>
              )}
            </div>
          </>
        )}

        {mainTab === 'changes' && (
          <SourceControlPanel
            projectId={projectId}
            gitChanges={gitChanges}
            onGitFileClick={onGitFileClick}
            onJumpToFile={(filePath) => {
              setMainTab('files');
              handleOpenFile?.({ path: filePath, type: 'file' });
            }}
            provider={provider}
            sessionLive={sessionLive}
          />
        )}

        {mainTab === 'pullrequests' && (
          <div className="flex-1 min-h-0 flex flex-col">
            {selectedMR ? (
              <div className="flex-1 min-h-0">
                <CodeReviewPanel
                  projectId={projectId}
                  mergeRequestId={selectedMR.id}
                  mergeRequest={selectedMR}
                  onBack={() => setSelectedMR(null)}
                  onChanged={() => setPrRefreshTrigger((n) => n + 1)}
                />
              </div>
            ) : (
              <MergeRequestListPanel
                projectId={projectId}
                provider={provider}
                onSelectMR={setSelectedMR}
                refreshTrigger={prRefreshTrigger}
                onCreatePR={() => setCreatePROpen(true)}
              />
            )}
            <CreatePRDialog
              open={createPROpen}
              projectId={projectId}
              sourceBranch={gitChanges?.branch || ''}
              defaultTargetBranch="main"
              onClose={() => setCreatePROpen(false)}
              onCreated={() => setPrRefreshTrigger((n) => n + 1)}
            />
          </div>
        )}

        <div className={mainTab === 'terminal' ? 'flex-1 min-h-0 overflow-hidden flex flex-col' : 'hidden'}>
          <div className="flex-1 min-h-0 overflow-hidden">
            {shellContent || (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-400 h-full">
                <Terminal className="h-12 w-12" />
                <p className="text-sm">{t('workspace:tabs.terminal')}</p>
                <p className="text-[11px]">Run commands like <code className="font-mono">npm test</code> or <code className="font-mono">npm run dev</code></p>
              </div>
            )}
          </div>
        </div>

        <div className={mainTab === 'deploy' ? 'flex-1 min-h-0 overflow-hidden' : 'hidden'}>
          {deployContent || null}
        </div>

        {mainTab === 'browser' && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <WorkspaceBrowserPane />
          </div>
        )}
      </div>

      {showNewFile && (
        <ConsoleDialogShell onClose={() => { setShowNewFile(false); setNewHereBasePath(null); }}>
          <div className="p-4 w-80">
            <h3 className="font-bold text-lg text-zinc-900 mb-1">{t('workspace:action.new_file')}</h3>
            {newHereBasePath && newHereBasePath !== '.' && (
              <p className="text-xs text-zinc-400 mb-2 font-mono">{newHereBasePath}/</p>
            )}
            <input ref={newFileInputRef} type="text" placeholder="filename.js"
              value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFile(); }}
              className={consoleInputClass} />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setShowNewFile(false); setNewHereBasePath(null); }} className={buttonClass('secondary', 'sm')}>{t('workspace:action.cancel')}</button>
              <button onClick={handleCreateFile} disabled={creating || !newName.trim()} className={buttonClass('primary', 'sm')}>
                {creating ? t('workspace:action.creating') : t('workspace:action.create')}
              </button>
            </div>
          </div>
        </ConsoleDialogShell>
      )}

      {showNewFolder && (
        <ConsoleDialogShell onClose={() => { setShowNewFolder(false); setNewHereBasePath(null); }}>
          <div className="p-4 w-80">
            <h3 className="font-bold text-lg text-zinc-900 mb-1">{t('workspace:action.new_folder')}</h3>
            {newHereBasePath && newHereBasePath !== '.' && (
              <p className="text-xs text-zinc-400 mb-2 font-mono">{newHereBasePath}/</p>
            )}
            <input ref={newFolderInputRef} type="text" placeholder="folder name"
              value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateDir(); }}
              className={consoleInputClass} />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setShowNewFolder(false); setNewHereBasePath(null); }} className={buttonClass('secondary', 'sm')}>{t('workspace:action.cancel')}</button>
              <button onClick={handleCreateDir} disabled={creating || !newName.trim()} className={buttonClass('primary', 'sm')}>
                {creating ? t('workspace:action.creating') : t('workspace:action.create')}
              </button>
            </div>
          </div>
        </ConsoleDialogShell>
      )}

      {contextMenu && createPortal(
        (() => {
          const MENU_W = 180;
          const MENU_H_EST = 200;
          const left = Math.min(contextMenu.x, window.innerWidth - MENU_W - 8);
          const top = Math.min(contextMenu.y, window.innerHeight - MENU_H_EST - 8);
          const node = contextMenu.node;
          const isDir = node.type === 'directory';
          const menuItems = [];
          if (isDir) {
            menuItems.push({ icon: FilePlus, label: t('workspace:action.new_file'), onClick: () => handleNewHere(node, 'file') });
            menuItems.push({ icon: FolderPlus, label: t('workspace:action.new_folder'), onClick: () => handleNewHere(node, 'folder') });
            menuItems.push({ divider: true });
          }
          menuItems.push({ icon: Pencil, label: t('workspace:action.rename'), onClick: () => handleStartRename(node) });
          menuItems.push({ icon: ClipboardCopy, label: t('workspace:action.copy_path'), onClick: () => handleCopyPath(node) });
          menuItems.push({ divider: true });
          menuItems.push({ icon: Trash2, label: t('workspace:action.delete'), onClick: () => handleDeleteNode(node), danger: true });
          return (
            <div
              id="workspace-context-menu"
              className={`fixed ${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} py-1 shadow-lg`}
              style={{ top, left, width: MENU_W }}
              role="menu"
            >
              {menuItems.map((item, i) => (
                item.divider ? (
                  <div key={`d${i}`} className="my-1 border-t border-zinc-200" />
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    onClick={item.onClick}
                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors ${
                      item.danger
                        ? 'text-red-600 hover:bg-red-50'
                        : 'text-zinc-700 hover:bg-zinc-50'
                    } ${consoleButtonFocusClass}`}
                  >
                    <item.icon className="h-3.5 w-3.5 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                )
              ))}
            </div>
          );
        })(),
        document.body,
      )}

      {renaming && (
        <ConsoleDialogShell onClose={() => setRenaming(null)} container={panelRootRef.current}>
          <div className="p-4 w-80 bg-surface border border-zinc-200 shadow-sm rounded-lg">
            <h3 className="font-bold text-lg text-zinc-900 mb-3">{t('workspace:action.rename')}</h3>
            <input ref={renameInputRef} type="text" placeholder="new name"
              value={renaming.newName} onChange={(e) => setRenaming((prev) => prev ? { ...prev, newName: e.target.value } : prev)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmRename(); }}
              className={consoleInputClass} />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setRenaming(null)} className={buttonClass('secondary', 'sm')}>{t('workspace:action.cancel')}</button>
              <button onClick={handleConfirmRename} disabled={renamingLoading || !renaming.newName.trim()} className={buttonClass('primary', 'sm')}>
                {renamingLoading ? t('workspace:action.renaming') : t('workspace:action.rename')}
              </button>
            </div>
          </div>
        </ConsoleDialogShell>
      )}
      </WorkspacePanelPanelContext.Provider>
    </div>
  );
}));

export default WorkspacePanel;
