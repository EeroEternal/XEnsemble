import React, { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';
import {
  FolderOpen,
  Pin,
  Plus,
  Trash2,
  Archive,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CircleUser,
  LogOut,
  Settings2,
  Github,
  PenSquare,
  Loader2,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';
import {
  loadSidebarPrefs,
  togglePinnedSession,
  togglePinnedWorkspace,
  archiveSession,
  isPinnedSession,
  isPinnedWorkspace,
  isArchivedSession,
  selectActiveSession,
  getRecentSessions,
} from '../lib/sidebarPrefs';
import {
  textPrimary,
  textSecondary,
  textPlaceholder,
  textTertiary,
  bgActive,
  hoverBgTertiary,
  hoverTextPrimary,
  accentGreen,
  accentRed,
  accentRedBg,
  transitionBase,
  consoleMenuDropdownZClass,
  consoleDropdownPanelClass,
} from '../lib/consoleTheme.js';
import { useTranslation } from 'react-i18next';

const SESSION_PREVIEW_LIMIT = 5;
const RECENT_DISPLAY_LIMIT = 2;

function sortSessions(list, prefs) {
  return [...list].sort((a, b) => {
    const aPin = isPinnedSession(prefs, a.id) ? 1 : 0;
    const bPin = isPinnedSession(prefs, b.id) ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    const aLive = a.alive === true ? 1 : 0;
    const bLive = b.alive === true ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function buildWorkspaces(projects, sessions, prefs) {
  const visible = sessions.filter((s) => !isArchivedSession(prefs, s.id));
  const byProject = {};
  for (const s of visible) {
    const pid = s.projectId || '_orphan';
    if (!byProject[pid]) byProject[pid] = [];
    byProject[pid].push(s);
  }
  const list = projects.map((p) => {
    const sess = sortSessions(byProject[p.id] || [], prefs);
    const lastActivity = Math.max(
      p.createdAt || 0,
      ...sess.map((s) => s.createdAt || 0),
    );
    return { id: p.id, name: p.name, sessions: sess, lastActivity };
  });
  if (byProject._orphan?.length) {
    const sess = sortSessions(byProject._orphan, prefs);
    list.push({
      id: '_orphan',
      name: 'Unassigned',
      sessions: sess,
      lastActivity: Math.max(...sess.map((s) => s.createdAt || 0)),
    });
  }
  return list.sort((a, b) => {
    const aPin = isPinnedWorkspace(prefs, a.id) ? 1 : 0;
    const bPin = isPinnedWorkspace(prefs, b.id) ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    return b.lastActivity - a.lastActivity;
  });
}

function UserProfile({ user, onOpenSettings, onLogout }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const MENU_WIDTH = 160;

  const updateMenuRect = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuRect({
      left: Math.max(8, rect.right - MENU_WIDTH),
      bottom: window.innerHeight - rect.top + 6,
      width: MENU_WIDTH,
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

  const runAndClose = (action) => {
    setOpen(false);
    action?.();
  };

  const menu = open && menuRect ? (
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: 'fixed',
        left: menuRect.left,
        bottom: menuRect.bottom,
        width: menuRect.width,
      }}
      className={`${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} py-1 shadow-md`}
    >
      {onOpenSettings && (
        <button
          type="button"
          role="menuitem"
          onClick={() => runAndClose(onOpenSettings)}
          className={`flex w-full items-center gap-2 px-3 py-2 text-xs text-[#5F6368] hover:bg-[#F4F5F6] hover:text-[#202124] ${transitionBase}`}
        >
          <Settings2 className="w-3.5 h-3.5 shrink-0" />
          {t('settings:title')}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => runAndClose(onLogout)}
        className={`flex w-full items-center gap-2 px-3 py-2 text-xs text-[#5F6368] hover:bg-[#F4F5F6] hover:text-[#202124] ${transitionBase}`}
      >
        <LogOut className="w-3.5 h-3.5 shrink-0" />
        {t('common:action.logout', { defaultValue: 'Log out' })}
      </button>
    </div>
  ) : null;

  return (
    <div className="flex items-center justify-between gap-2 pt-2">
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#E8EAED] text-[#5F6368]">
          <CircleUser className="w-4 h-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-[#202124]">{user?.username || t('users:role.user', { defaultValue: 'User' })}</p>
          <p className="truncate text-[10px] text-[#5F6368]">{user?.email || ''}</p>
        </div>
      </div>
      <div ref={rootRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t('common:action.account_menu', { defaultValue: 'Account menu' })}
          title="Account"
          className={`flex items-center justify-center rounded-md p-1.5 ${textPlaceholder} hover:text-[#202124] hover:bg-[#E8EAED] ${transitionBase} ${
            open ? 'bg-[#E8EAED] text-[#202124]' : ''
          }`}
        >
          <ChevronUp
            className={`h-4 w-4 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
            strokeWidth={2}
          />
        </button>
        {menu && createPortal(menu, document.body)}
      </div>
    </div>
  );
}

export default function AppSidebar({
  agents,
  projects,
  sessions,
  activeSession,
  onSelectSession,
  onCreateWorkspace,
  onCreateSessionInWorkspace,
  onRequestDeleteSession,
  onRequestDeleteWorkspace,
  onArchiveSession,
  onImportFromGitHub,
  fetchWorkspaces,
  user,
  onOpenSettings,
  onLogout,
}) {
  const { t } = useTranslation();
  const [sidebarPrefs, setSidebarPrefs] = useState(() => loadSidebarPrefs());
  const [expandedWorkspaces, setExpandedWorkspaces] = useState(() => {
    const ids = new Set();
    if (activeSession?.projectId) ids.add(activeSession.projectId);
    return ids;
  });
  const [expandedSessionLists, setExpandedSessionLists] = useState(() => new Set());
  const [renameId, setRenameId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameLoading, setRenameLoading] = useState(false);
  const { showToast } = useToast();

  const refreshSidebarPrefs = useCallback(() => setSidebarPrefs(loadSidebarPrefs()), []);

  useEffect(() => {
    refreshSidebarPrefs();
  }, [sessions, projects, refreshSidebarPrefs]);

  const validProjectIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);

  useEffect(() => {
    if (!activeSession?.projectId) return;
    setExpandedWorkspaces((prev) => {
      if (prev.has(activeSession.projectId)) return prev;
      const next = new Set(prev);
      next.add(activeSession.projectId);
      return next;
    });
  }, [activeSession?.projectId]);

  useEffect(() => {
    const runningIds = [...new Set(sessions.filter((s) => s.alive && s.projectId).map((s) => s.projectId))];
    if (runningIds.length === 0) return;
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of runningIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  const getAgentLabel = useCallback(
    (agentId) => agents.find((a) => a.id === agentId)?.name || agentId,
    [agents],
  );

  const selectSession = useCallback((s, ws) => {
    const projectName = s.projectName || ws?.name;
    selectActiveSession(s.id, {
      agentId: s.agentId ?? null,
      projectId: s.projectId ?? null,
      projectName: projectName ?? null,
      createdAt: s.createdAt ?? Date.now(),
    });
    refreshSidebarPrefs();
    onSelectSession({ ...s, projectName });
    if (s.projectId) {
      setExpandedWorkspaces((prev) => {
        if (prev.has(s.projectId)) return prev;
        const next = new Set(prev);
        next.add(s.projectId);
        return next;
      });
    }
  }, [onSelectSession, refreshSidebarPrefs]);

  const toggleWorkspaceExpanded = (workspaceId) => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };

  const toggleSessionListExpanded = (key) => {
    setExpandedSessionLists((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handlePinSession = (e, sessionId) => {
    e.stopPropagation();
    togglePinnedSession(sessionId);
    refreshSidebarPrefs();
  };

  const handleArchiveSession = (e, sessionId) => {
    e.stopPropagation();
    archiveSession(sessionId);
    refreshSidebarPrefs();
    onArchiveSession?.(sessionId);
  };

  const handlePinWorkspace = (e, workspaceId) => {
    e.stopPropagation();
    togglePinnedWorkspace(workspaceId);
    refreshSidebarPrefs();
  };

  const handleRequestDeleteWorkspace = (e, ws) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    onRequestDeleteWorkspace?.(ws, {
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    });
  };

  const handleStartRename = (e, ws) => {
    e.stopPropagation();
    setRenameId(ws.id);
    setRenameValue(ws.name);
  };

  const handleConfirmRename = async (wsId) => {
    if (renameLoading) return;
    const trimmed = renameValue.trim();
    const ws = workspaces.find((w) => w.id === wsId);
    if (!trimmed || !ws || trimmed === ws.name) {
      setRenameId(null);
      setRenameValue('');
      return;
    }
    setRenameLoading(true);
    try {
      const res = await apiFetch(`/api/v1/projects/${encodeURIComponent(wsId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('sessions:error.rename_failed', { defaultValue: 'Rename failed' }));
      fetchWorkspaces?.();
      showToast('success', 'Workspace renamed');
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setRenameLoading(false);
      setRenameId(null);
      setRenameValue('');
    }
  };

  const handleCancelRename = () => {
    setRenameId(null);
    setRenameValue('');
  };

  const renderSessionRow = (s, ws, { compact = false, showWorkspace = false } = {}) => {
    const isActive = activeSession?.sessionId === s.id;
    const isLive = s.alive === true;
    const pinned = isPinnedSession(sidebarPrefs, s.id);
    const agentLabel = getAgentLabel(s.agentId);
    const label = s.title?.trim() || agentLabel;

    return (
      <div
        key={s.id}
        className={`group/session relative flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm transition-colors ${
          isActive ? bgActive : hoverBgTertiary
        } ${!isLive ? 'opacity-70' : ''}`}
      >
        <span className={`shrink-0 w-1 h-1 rounded-full ${isLive ? 'bg-[#4A7C59]' : 'bg-[#DADCE0]'}`} />
        <button
          type="button"
          onClick={() => selectSession(s, ws)}
          className={`flex-1 min-w-0 text-left text-xs ${textTertiary} disabled:opacity-50`}
          title={showWorkspace ? `${label} · ${ws?.name || ''}` : label}
        >
          {showWorkspace ? (
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{label}</span>
              <span className={`truncate text-[10px] ${textPlaceholder}`}>{ws?.name}</span>
            </span>
          ) : (
            <span className="truncate">{label}</span>
          )}
        </button>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            title={pinned ? 'Unpin' : 'Pin'}
            onClick={(e) => handlePinSession(e, s.id)}
            className={`p-1 rounded-md ${textPlaceholder} ${hoverTextPrimary} ${hoverBgTertiary} transition-opacity ${
              pinned ? `opacity-100 ${textSecondary}` : 'opacity-0 group-hover/session:opacity-100 focus:opacity-100'
            }`}
          >
            <Pin className={`w-3 h-3 ${pinned ? 'fill-current' : ''}`} />
          </button>
          <button
            type="button"
            title="Archive"
            onClick={(e) => handleArchiveSession(e, s.id)}
            className={`p-1 rounded-md ${textPlaceholder} ${hoverTextPrimary} ${hoverBgTertiary} opacity-0 group-hover/session:opacity-100 focus:opacity-100 transition-opacity`}
          >
            <Archive className="w-3 h-3" />
          </button>
          {!compact && (
            <button
              type="button"
              title={isLive ? t('sessions:action.stop_and_remove') : t('sessions:action.remove')}
              onClick={(e) => {
                e.stopPropagation();
                onRequestDeleteSession?.(s, ws);
              }}
              className={`p-1 rounded-md ${textPlaceholder} ${accentRed} ${accentRedBg} opacity-0 group-hover/session:opacity-100 focus:opacity-100 transition-opacity`}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderSessionList = (sessionList, ws, listKey) => {
    if (sessionList.length === 0) {
      return <p className={`text-xs ${textPlaceholder} py-1 px-1.5`}>No sessions. Use + to add one.</p>;
    }
    const expanded = expandedSessionLists.has(listKey);
    const visible = expanded ? sessionList : sessionList.slice(0, SESSION_PREVIEW_LIMIT);
    const hasMore = sessionList.length > SESSION_PREVIEW_LIMIT;

    return (
      <>
        {visible.map((s) => renderSessionRow(s, ws))}
        {hasMore && !expanded && (
          <button
            type="button"
            onClick={() => toggleSessionListExpanded(listKey)}
            className={`text-xs ${textPlaceholder} ${hoverTextPrimary} py-1 px-1.5 text-left ${transitionBase}`}
          >
            See more
          </button>
        )}
      </>
    );
  };

  const workspaces = buildWorkspaces(projects, sessions, sidebarPrefs);
  const pinnedSessions = sortSessions(
    sessions.filter((s) => {
      if (!isPinnedSession(sidebarPrefs, s.id) || isArchivedSession(sidebarPrefs, s.id)) return false;
      if (s.projectId && !validProjectIds.has(s.projectId)) return false;
      return true;
    }),
    sidebarPrefs,
  );
  const recentSessions = getRecentSessions(sessions, sidebarPrefs, { validProjectIds })
    .slice(0, RECENT_DISPLAY_LIMIT);
  const runningCount = sessions.filter((s) => s.alive === true).length;
  const hasSidebarSectionsAboveWorkspaces = true; // Recently is always rendered above

  const adminLinkClass = ({ isActive }) =>
    `flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
      isActive
        ? `${bgActive} ${textPrimary}`
        : `${textSecondary} hover:text-[#202124] hover:bg-[#E8EAED]`
    }`;

  return (
    <aside className="h-full w-[260px] bg-[#F4F5F6] flex flex-col flex-shrink-0 select-none">
      {/* Middle: workspaces tree */}
      <div className="flex-1 min-h-0 overflow-auto px-3 pt-3 pb-3">
        <div className="flex items-center justify-between mb-2 px-1.5">
          <div className="flex items-center gap-2">
            <h2 className={`text-[10px] font-semibold uppercase tracking-wider ${textSecondary}`}>Workspaces</h2>
            {runningCount > 0 && (
              <span className={`text-[10px] uppercase tracking-wider font-semibold ${accentGreen}`}>
                {runningCount} running
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="Import from GitHub"
              disabled={!onImportFromGitHub}
              onClick={onImportFromGitHub}
              className={`p-1 rounded-md ${textPlaceholder} hover:text-[#202124] hover:bg-[#E8EAED] ${transitionBase} disabled:opacity-40`}
            >
              <Github className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              title="New workspace"
              disabled={!onCreateWorkspace}
              onClick={onCreateWorkspace}
              className={`p-1 rounded-md ${textPlaceholder} hover:text-[#202124] hover:bg-[#E8EAED] ${transitionBase} disabled:opacity-40`}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="mb-3">
          <h3 className={`px-1.5 py-1 text-xs font-medium ${textPlaceholder}`}>Recently</h3>
          <div className="flex flex-col">
            {recentSessions.length > 0 ? (
              recentSessions.map((s) => {
                const ws = workspaces.find((w) => w.id === (s.projectId || '_orphan'))
                  || { name: s.projectName || 'Unassigned' };
                return renderSessionRow(s, ws, { compact: true, showWorkspace: true });
              })
            ) : (
              <p className={`text-xs ${textPlaceholder} px-1.5 py-1`}>No recent sessions</p>
            )}
          </div>
        </div>
        {pinnedSessions.length > 0 && (
          <div className="mb-3">
            <h3 className={`px-1.5 py-1 text-xs font-medium ${textPlaceholder}`}>Pinned</h3>
            <div className="flex flex-col">
              {pinnedSessions.map((s) => {
                const ws = workspaces.find((w) => w.id === (s.projectId || '_orphan')) || { name: s.projectName || 'Unassigned' };
                return renderSessionRow(s, ws, { compact: true });
              })}
            </div>
          </div>
        )}
        {workspaces.length === 0 ? (
          <p className={`text-xs ${textSecondary} px-2 py-1`}>
            No workspaces yet. Create one to start parallel sessions.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {hasSidebarSectionsAboveWorkspaces && (
              <h3 className={`px-1.5 py-1 text-xs font-medium ${textPlaceholder}`}>Workspaces</h3>
            )}
            {workspaces.map((ws) => {
              const expanded = expandedWorkspaces.has(ws.id);
              const liveInWs = ws.sessions.filter((s) => s.alive === true).length;
              const isOrphan = ws.id === '_orphan';
              const wsPinned = isPinnedWorkspace(sidebarPrefs, ws.id);
              return (
                <div key={ws.id} className="rounded-md">
                  <div className={`group flex items-center gap-0.5 rounded-md ${hoverBgTertiary}`}>
                    <button
                      type="button"
                      onClick={() => toggleWorkspaceExpanded(ws.id)}
                      className={`p-1.5 ${textPlaceholder} ${hoverTextPrimary} shrink-0 ${transitionBase}`}
                      aria-expanded={expanded}
                    >
                      {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                    <FolderOpen className={`w-3.5 h-3.5 ${textPlaceholder} shrink-0`} />
                    {renameId === ws.id ? (
                      <>
                        <input
                          type="text"
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); handleConfirmRename(ws.id); }
                            if (e.key === 'Escape') { e.preventDefault(); handleCancelRename(); }
                          }}
                          onBlur={() => handleConfirmRename(ws.id)}
                          disabled={renameLoading}
                          className={`flex-1 min-w-0 bg-transparent text-sm ${textPrimary} outline-none border-b border-[#9AA0A6] py-1 mr-1`}
                        />
                        {renameLoading && (
                          <Loader2 className={`w-3.5 h-3.5 shrink-0 animate-spin ${textPlaceholder}`} />
                        )}
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => toggleWorkspaceExpanded(ws.id)}
                          className={`flex-1 min-w-0 text-left py-1.5 pr-1 truncate text-sm ${textPrimary}`}
                          title={ws.name}
                        >
                          {ws.name}
                          {liveInWs > 0 && (
                            <span className={`ml-1.5 text-[10px] font-semibold ${accentGreen}`}>{liveInWs}</span>
                          )}
                        </button>
                        {!isOrphan && (
                          <button
                            type="button"
                            title="Rename workspace"
                            onClick={(e) => handleStartRename(e, ws)}
                            className={`p-1.5 rounded-md ${textPlaceholder} ${hoverTextPrimary} ${hoverBgTertiary} opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity ${transitionBase}`}
                          >
                            <PenSquare className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {!isOrphan && (
                          <>
                            <button
                              type="button"
                              title={wsPinned ? 'Unpin workspace' : 'Pin workspace'}
                              onClick={(e) => handlePinWorkspace(e, ws.id)}
                              className={`p-1.5 rounded-md ${textPlaceholder} ${hoverTextPrimary} ${hoverBgTertiary} transition-opacity ${
                                wsPinned ? `opacity-100 ${textSecondary}` : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                              }`}
                            >
                              <Pin className={`w-3.5 h-3.5 ${wsPinned ? 'fill-current' : ''}`} />
                            </button>
                            <button
                              type="button"
                              title="New session in this workspace"
                              disabled={!onCreateSessionInWorkspace}
                              onClick={() => onCreateSessionInWorkspace?.(ws)}
                              className={`p-1.5 ${textPlaceholder} ${hoverTextPrimary} ${hoverBgTertiary} rounded-md opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-40 ${transitionBase}`}
                            >
                              <Plus className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          title={isOrphan ? 'Clear unassigned sessions' : 'Delete workspace'}
                          onClick={(e) => handleRequestDeleteWorkspace(e, ws)}
                          className={`p-1.5 mr-0.5 ${textPlaceholder} ${accentRed} ${accentRedBg} rounded-md opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity ${transitionBase}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                  {expanded && (
                    <div className={`ml-4 pl-2 border-l border-[#E8EAED] flex flex-col pb-1`}>
                      {renderSessionList(ws.sessions, ws, ws.id)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom: admin links + user profile */}
      <div className="border-t border-[#E8EAED] px-3 py-3 space-y-1">
        {user?.role === 'admin' && (
          <>
            <NavLink to="/admin/users" className={adminLinkClass}>
              Users
            </NavLink>
            <NavLink to="/admin/agents" className={adminLinkClass}>
              Agents
            </NavLink>
            <NavLink to="/admin/gateway" className={adminLinkClass}>
              Gateway
            </NavLink>
          </>
        )}
        <UserProfile user={user} onOpenSettings={onOpenSettings} onLogout={onLogout} />
      </div>
    </aside>
  );
}
