import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import {
  ChevronsUpDown,
  Check,
  Search,
  Plus,
  Trash2,
  FolderOpen,
  GitBranch,
  Loader2,
} from 'lucide-react';
import {
  getProviderLabel,
  getWorkspaceRepoLabel,
  isGitLinkedProject,
  isWorkspaceClonePending,
} from '../lib/gitLabels';
import {
  textPrimary,
  textSecondary,
  textPlaceholder,
  accentGreen,
  accentRed,
  accentRedBg,
  transitionBase,
  hoverTextPrimary,
  hoverBgTertiary,
  bgCanvas,
  bgSecondary,
  consoleButtonFocusClass,
  consoleMenuDropdownZClass,
  consoleDropdownPanelClass,
  borderHairline,
} from '../lib/consoleTokens';

export default function WorkspaceSwitcher({
  projects,
  activeWorkspaceId,
  sessions,
  onSelect,
  onCreate,
  onDelete,
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuRect, setMenuRect] = useState(null);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const searchInputRef = useRef(null);

  const currentProject = projects.find((p) => p.id === activeWorkspaceId) || null;
  const currentName = currentProject?.name || t('sessions:label.select_workspace');

  const updateMenuRect = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuRect({
      left: rect.left,
      top: rect.bottom + 6,
      width: Math.max(rect.width, 288),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setMenuRect(null);
      return;
    }
    updateMenuRect();
    window.addEventListener('resize', updateMenuRect);
    window.addEventListener('scroll', updateMenuRect, true);
    return () => {
      window.removeEventListener('resize', updateMenuRect);
      window.removeEventListener('scroll', updateMenuRect, true);
    };
  }, [open, updateMenuRect]);

  useEffect(() => {
    if (!open) return;
    if (searchInputRef.current) searchInputRef.current.focus();
    const onPointerDown = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  const liveCountByProject = (() => {
    const map = {};
    for (const s of sessions || []) {
      if (s.alive === true) {
        const pid = s.projectId || '_orphan';
        map[pid] = (map[pid] || 0) + 1;
      }
    }
    return map;
  })();

  const q = query.trim().toLowerCase();
  const filtered = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q))
    : projects;

  const triggerTitle = currentProject
    ? (isGitLinkedProject(currentProject)
      ? [getProviderLabel(currentProject.repoProvider), getWorkspaceRepoLabel(currentProject), currentProject.currentBranch ? `branch: ${currentProject.currentBranch}` : null].filter(Boolean).join(' · ')
      : currentProject.name)
    : t('sessions:label.select_workspace');

  const menu = open && menuRect ? (
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: 'fixed',
        left: menuRect.left,
        top: menuRect.top,
        width: menuRect.width,
      }}
      className={`${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} py-1 shadow-md max-h-[60vh] flex flex-col`}
    >
      <div className="px-2 py-1.5">
        <label className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${bgSecondary}`}>
          <Search className="w-3 h-3 text-zinc-400 shrink-0" strokeWidth={1.75} />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sessions:search')}
            className="min-w-0 flex-1 bg-transparent text-xs text-zinc-700 placeholder:text-zinc-400 outline-none"
          />
        </label>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-1 pb-1">
        {filtered.length === 0 ? (
          <p className={`px-2.5 py-2 text-xs ${textPlaceholder}`}>
            {projects.length === 0 ? t('sessions:label.no_workspaces') : t('sessions:label.no_matching_workspaces')}
          </p>
        ) : (
          filtered.map((p) => {
            const isActive = p.id === activeWorkspaceId;
            const live = liveCountByProject[p.id] || 0;
            const gitLinked = isGitLinkedProject(p);
            const repoLabel = getWorkspaceRepoLabel(p);
            const providerLabel = getProviderLabel(p.repoProvider);
            const isCloning = isWorkspaceClonePending(p);
            const title = gitLinked
              ? [providerLabel, repoLabel, p.currentBranch ? `branch: ${p.currentBranch}` : null].filter(Boolean).join(' · ')
              : p.name;
            return (
              <div
                key={p.id}
                className={`group relative flex items-center rounded-md ${transitionBase} ${
                  isActive ? `${bgSecondary}` : hoverBgTertiary
                }`}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { onSelect?.(p.id); close(); }}
                  title={title}
                  className={`flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-[13px] ${isActive ? textPrimary : 'text-zinc-700'}`}
                >
                  {gitLinked ? (
                    <GitBranch className={`w-3.5 h-3.5 shrink-0 ${textPlaceholder}`} strokeWidth={1.75} />
                  ) : (
                    <FolderOpen className={`w-3.5 h-3.5 shrink-0 ${textPlaceholder}`} strokeWidth={1.75} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {isCloning && (
                    <Loader2 className={`w-3.5 h-3.5 shrink-0 animate-spin ${textPlaceholder}`} />
                  )}
                  {isActive && (
                    <Check className="w-3.5 h-3.5 shrink-0 text-zinc-900" strokeWidth={2} />
                  )}
                </button>
                <button
                  type="button"
                  title={t('sessions:label.delete_workspace')}
                  aria-label={t('sessions:label.delete_workspace')}
                  onClick={(e) => {
                    e.stopPropagation();
                    const ws = {
                      id: p.id,
                      name: p.name,
                      sessions: (sessions || []).filter((s) => s.projectId === p.id && s.status !== 'exited'),
                    };
                    onDelete?.(ws);
                  }}
                  className={`shrink-0 p-1 mr-0.5 rounded-md opacity-0 group-hover:opacity-100 focus:opacity-100 ${transitionBase} ${textPlaceholder} ${accentRed} ${accentRedBg}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
      <div className={`px-2 pt-1.5 pb-1 border-t ${borderHairline}`}>
        <button
          type="button"
          role="menuitem"
          onClick={() => { onCreate?.(); close(); }}
          className={`flex w-full items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium text-zinc-700 ${hoverBgTertiary} ${transitionBase} ${consoleButtonFocusClass}`}
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
          {t('sessions:label.new_workspace')}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={triggerTitle}
        className={`flex items-center gap-1.5 max-w-[280px] rounded-md px-2 py-1 text-[13px] font-medium ${transitionBase} ${consoleButtonFocusClass} ${
          open ? `${bgSecondary} ${textPrimary}` : `text-zinc-700 ${hoverBgTertiary}`
        }`}
      >
        <FolderOpen className={`w-3.5 h-3.5 shrink-0 ${textPlaceholder}`} strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate">{currentName}</span>
        <ChevronsUpDown className={`w-3.5 h-3.5 shrink-0 ${textPlaceholder}`} strokeWidth={1.75} />
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
