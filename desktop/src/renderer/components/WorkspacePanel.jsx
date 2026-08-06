import { useState, useCallback, useEffect, useRef, useMemo, memo, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText, Files, FolderPlus, Plus, PanelLeftClose, PanelLeft, Loader2,
  Terminal, Globe, Monitor, GitBranch, GitPullRequest, X, ArrowLeft,
} from 'lucide-react';
import WorkspaceFileTree from './WorkspaceFileTree';
import CodeEditor from './CodeEditorLazy';
import { ConsoleDialogShell } from './ConsoleDialog';
import SourceControlPanel from './SourceControlPanel';
import WorkspacePreviewPane from './WorkspacePreviewPane';
import WorkspaceBrowserPane from './WorkspaceBrowserPane';
import MergeRequestListPanel from './git/MergeRequestListPanel';
import CodeReviewPanel from './git/CodeReviewPanel';
import CreatePRDialog from './github/CreatePRDialog';
import {
  consoleButtonFocusClass,
  consoleInputClass,
  consoleDropdownPanelClass,
  consoleMenuDropdownZClass,
} from '@/lib/consoleTheme';
import { buttonClass } from '@/lib/buttonStyles';

const DiffViewer = lazy(() => import('./DiffViewer'));

function DiffViewerFallback() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
    </div>
  );
}

const PINNED_TABS = [
  { key: 'files', label: 'Files', icon: Files },
  { key: 'changes', label: 'Changes', icon: GitBranch },
];

const ADDABLE_TABS = [
  { key: 'pullrequests', label: 'Pull Requests', icon: GitPullRequest },
  { key: 'terminal', label: 'Terminal', icon: Terminal },
  { key: 'preview', label: 'Preview', icon: Monitor },
  { key: 'browser', label: 'Browser', icon: Globe },
];

const ADDABLE_KEYS = new Set(ADDABLE_TABS.map((t) => t.key));

function migrateTabKey(key) {
  if (key === 'git') return 'changes';
  if (key === 'shell') return 'terminal';
  return key;
}

function readExtraTabs() {
  try {
    const raw = sessionStorage.getItem('xe_extra_tabs');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(migrateTabKey).filter((k) => ADDABLE_KEYS.has(k));
      }
    }
  } catch {
    // ignore
  }
  const legacy = migrateTabKey(sessionStorage.getItem('xe_main_tab') || '');
  return legacy && ADDABLE_KEYS.has(legacy) ? [legacy] : [];
}

function readMainTab(extraTabs) {
  const stored = migrateTabKey(sessionStorage.getItem('xe_main_tab') || 'files');
  if (stored === 'files' || stored === 'changes') return stored;
  if (extraTabs.includes(stored)) return stored;
  return 'files';
}

const WorkspacePanel = memo(function WorkspacePanel({
  projectId,
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
}) {
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

  useEffect(() => {
    setSelectedMR(null);
  }, [projectId]);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const stored = sessionStorage.getItem('xe_sidebar_open');
    return stored !== null ? stored === 'true' : true;
  });
  const [extraTabs, setExtraTabs] = useState(readExtraTabs);
  const [mainTab, setMainTab] = useState(() => readMainTab(readExtraTabs()));
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuRect, setAddMenuRect] = useState(null);
  const addBtnRef = useRef(null);
  const newFileInputRef = useRef(null);
  const newFolderInputRef = useRef(null);

  useEffect(() => {
    sessionStorage.setItem('xe_sidebar_open', String(sidebarOpen));
  }, [sidebarOpen]);

  useEffect(() => {
    sessionStorage.setItem('xe_main_tab', mainTab);
    if (changesTabActiveRef) changesTabActiveRef.current = (mainTab === 'changes');
  }, [mainTab, changesTabActiveRef]);

  useEffect(() => {
    sessionStorage.setItem('xe_extra_tabs', JSON.stringify(extraTabs));
  }, [extraTabs]);

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
  }, [renaming]);

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
      title: node.type === 'directory' ? 'Delete Folder' : 'Delete File',
      message: `Delete "${label}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
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

  const activeTab = tabs.find((t) => t.path === activePath);
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  const gitStagedFiles = gitChanges?.stagedFiles || [];
  const gitUnstagedFiles = gitChanges?.unstagedFiles || [];
  const changeCount = gitStagedFiles.length + gitUnstagedFiles.length;

  const isExternalGit = provider && provider !== 'none' && provider !== 'local_git';

  const visibleTabs = useMemo(() => {
    const pinned = PINNED_TABS.map((t) => (
      t.key === 'changes' ? { ...t, badge: changeCount } : t
    ));
    const extras = extraTabs
      .map((key) => ADDABLE_TABS.find((t) => t.key === key))
      .filter((t) => {
        if (!t) return false;
        if (t.key === 'pullrequests') return isExternalGit;
        return true;
      });
    return [
      ...pinned,
      ...extras,
    ];
  }, [extraTabs, changeCount, isExternalGit]);

  const addableRemaining = ADDABLE_TABS.filter((t) => {
    if (extraTabs.includes(t.key)) return false;
    if (t.key === 'pullrequests') return isExternalGit;
    return true;
  });

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-panel">
      <div className="flex items-center border-b border-[#E8EAED] px-1 shrink-0 bg-white">
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
                      ? 'border-[#202124] text-[#202124]'
                      : 'border-transparent text-[#5F6368] hover:text-[#202124]'
                  } ${consoleButtonFocusClass}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                  {tab.badge > 0 && (
                    <span className="ml-0.5 inline-flex items-center justify-center h-3.5 min-w-[14px] rounded-full bg-[#C06C5D] text-white text-[9px] font-medium px-1">
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
                    className={`absolute right-0.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-[#E8EAED] opacity-0 group-hover:opacity-100 ${consoleButtonFocusClass}`}
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
            title="Add panel"
            onClick={() => setAddMenuOpen((v) => !v)}
            className={`ml-0.5 p-1.5 rounded text-zinc-400 hover:text-zinc-600 hover:bg-[#E8EAED] ${consoleButtonFocusClass}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {mainTab === 'files' && (
          <div className="flex items-center gap-0.5 ml-auto pr-1">
            <button title="New file" onClick={() => { setNewName(''); setShowNewFile(true); }}
              className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-[#E8EAED] ${consoleButtonFocusClass}`}>
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button title="New folder" onClick={() => { setNewName(''); setShowNewFolder(true); }}
              className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-[#E8EAED] ${consoleButtonFocusClass}`}>
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
            <button
              title={sidebarOpen ? 'Collapse file tree' : 'Expand file tree'}
              onClick={() => setSidebarOpen((open) => !open)}
              className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-[#E8EAED] ${consoleButtonFocusClass}`}
            >
              {sidebarOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeft className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}
      </div>

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
              <div className="w-44 shrink-0 border-r border-[#E8EAED] bg-[#F4F5F6] flex flex-col min-h-0">
                <div className="shrink-0 flex items-center justify-between px-2 py-0.5 border-b border-[#E8EAED]">
                  <span className="text-[10px] font-medium text-zinc-400 tracking-wide uppercase">Files</span>
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(false)}
                    className={`p-0.5 rounded text-zinc-400 hover:text-zinc-600 ${consoleButtonFocusClass}`}
                    title="Hide file tree"
                  >
                    <PanelLeftClose className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1">
                  <WorkspaceFileTree lazy projectId={projectId} onFetchDir={onFetchDir}
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
                  {!sidebarOpen && (
                    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[#E8EAED] bg-[#FAFBFC]">
                      <button
                        type="button"
                        onClick={() => setSidebarOpen(true)}
                        className={`flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 ${consoleButtonFocusClass}`}
                      >
                        <PanelLeft className="h-3 w-3" />
                        <span>Show file tree</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onCloseTab?.(activeTab.path)}
                        className={`ml-auto flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 ${consoleButtonFocusClass}`}
                        title="Close file"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}
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
                  <p className="text-sm">Select a file from the tree to open</p>
                  {!sidebarOpen && (
                    <button
                      type="button"
                      onClick={() => setSidebarOpen(true)}
                      className={`flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 ${consoleButtonFocusClass}`}
                    >
                      <PanelLeft className="h-3 w-3" />
                      <span>Show file tree</span>
                    </button>
                  )}
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
              <>
                <MergeRequestListPanel
                  projectId={projectId}
                  provider={provider}
                  onSelectMR={setSelectedMR}
                  refreshTrigger={prRefreshTrigger}
                />
                <div className="flex items-center justify-end gap-2 border-t border-[#E8EAED] px-3 py-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setCreatePROpen(true)}
                    className={`${buttonClass('primary', 'sm')}`}
                  >
                    <GitPullRequest className="h-3.5 w-3.5 mr-1 inline" />
                    New Pull Request
                  </button>
                </div>
              </>
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

        {mainTab === 'terminal' && (
          <div className="flex-1 min-h-0 overflow-hidden">
            {shellContent || (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-400 h-full">
                <Terminal className="h-12 w-12" />
                <p className="text-sm">Terminal</p>
              </div>
            )}
          </div>
        )}

        {mainTab === 'preview' && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <WorkspacePreviewPane projectId={projectId} />
          </div>
        )}

        {mainTab === 'browser' && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <WorkspaceBrowserPane />
          </div>
        )}
      </div>

      {showNewFile && (
        <ConsoleDialogShell onClose={() => { setShowNewFile(false); setNewHereBasePath(null); }}>
          <div className="p-4 w-80">
            <h3 className="font-bold text-lg text-zinc-900 mb-1">New File</h3>
            {newHereBasePath && newHereBasePath !== '.' && (
              <p className="text-xs text-zinc-400 mb-2 font-mono">{newHereBasePath}/</p>
            )}
            <input ref={newFileInputRef} type="text" placeholder="filename.js"
              value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFile(); }}
              className={consoleInputClass} />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setShowNewFile(false); setNewHereBasePath(null); }} className={buttonClass('secondary', 'sm')}>Cancel</button>
              <button onClick={handleCreateFile} disabled={creating || !newName.trim()} className={buttonClass('primary', 'sm')}>
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </ConsoleDialogShell>
      )}

      {showNewFolder && (
        <ConsoleDialogShell onClose={() => { setShowNewFolder(false); setNewHereBasePath(null); }}>
          <div className="p-4 w-80">
            <h3 className="font-bold text-lg text-zinc-900 mb-1">New Folder</h3>
            {newHereBasePath && newHereBasePath !== '.' && (
              <p className="text-xs text-zinc-400 mb-2 font-mono">{newHereBasePath}/</p>
            )}
            <input ref={newFolderInputRef} type="text" placeholder="folder name"
              value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateDir(); }}
              className={consoleInputClass} />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setShowNewFolder(false); setNewHereBasePath(null); }} className={buttonClass('secondary', 'sm')}>Cancel</button>
              <button onClick={handleCreateDir} disabled={creating || !newName.trim()} className={buttonClass('primary', 'sm')}>
                {creating ? 'Creating…' : 'Create'}
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
            menuItems.push({ icon: FilePlus, label: 'New File', onClick: () => handleNewHere(node, 'file') });
            menuItems.push({ icon: FolderPlus, label: 'New Folder', onClick: () => handleNewHere(node, 'folder') });
            menuItems.push({ divider: true });
          }
          menuItems.push({ icon: Pencil, label: 'Rename', onClick: () => handleStartRename(node) });
          menuItems.push({ icon: ClipboardCopy, label: 'Copy Path', onClick: () => handleCopyPath(node) });
          menuItems.push({ divider: true });
          menuItems.push({ icon: Trash2, label: 'Delete', onClick: () => handleDeleteNode(node), danger: true });
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
        <ConsoleDialogShell onClose={() => setRenaming(null)}>
          <div className="p-4 w-80">
            <h3 className="font-bold text-lg text-zinc-900 mb-3">Rename</h3>
            <input ref={renameInputRef} type="text" placeholder="new name"
              value={renaming.newName} onChange={(e) => setRenaming((prev) => prev ? { ...prev, newName: e.target.value } : prev)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmRename(); }}
              className={consoleInputClass} />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setRenaming(null)} className={buttonClass('secondary', 'sm')}>Cancel</button>
              <button onClick={handleConfirmRename} disabled={renamingLoading || !renaming.newName.trim()} className={buttonClass('primary', 'sm')}>
                {renamingLoading ? 'Renaming…' : 'Rename'}
              </button>
            </div>
          </div>
        </ConsoleDialogShell>
      )}
    </div>
  );
});

export default WorkspacePanel;
