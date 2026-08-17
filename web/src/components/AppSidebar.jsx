import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';
import {
  FolderOpen,
  FolderPlus,
  Pin,
  Trash2,
  Archive,
  Play,
  ChevronRight,
  ChevronDown,
  LogOut,
  Settings2,
  Search,
  ListFilter,
  PenSquare,
  Users,
  Bot,
  Globe,
  Container,
  GitBranch,
  Loader2,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { getProviderLabel, getWorkspaceRepoLabel, isGitLinkedProject, isWorkspaceClonePending } from '../lib/gitLabels';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import {
  loadSidebarPrefs,
  togglePinnedWorkspace,
  archiveSession,
  isPinnedSession,
  isPinnedWorkspace,
  isArchivedSession,
  selectActiveSession,
} from '../lib/sidebarPrefs';
import { useToast } from '../components/Toast';
import BrandMark from './BrandMark';
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
  bgSecondary,
  bgCanvas,
  consoleButtonFocusClass,
  consoleMenuDropdownZClass,
  consoleDropdownPanelClass,
} from '../lib/consoleTokens';

const SIDEBAR_COLLAPSED_KEY = 'xensemble.sidebar.collapsed';

const SESSION_PREVIEW_LIMIT = 8;

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
  const visible = sessions.filter(
    (s) => !isArchivedSession(prefs, s.id) && s.status !== 'exited',
  );
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
    return {
      id: p.id,
      name: p.name,
      sessions: sess,
      lastActivity,
      repoProvider: p.repoProvider ?? p.repo_provider ?? 'none',
      githubFullName: p.githubFullName ?? p.github_full_name ?? null,
      repoUrl: p.repoUrl ?? p.repo_url ?? null,
      currentBranch: p.currentBranch ?? p.current_branch ?? null,
      cloneStatus: p.cloneStatus ?? p.clone_status ?? null,
    };
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

function SidebarAccountMenu({ user, onOpenSettings, onLogout, adminLinkClass, collapsed = false }) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const isAdmin = user?.role === 'admin';

  const updateMenuRect = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuRect({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 6,
      width: Math.max(rect.width, 200),
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

  const close = () => setOpen(false);

  const menuItemClass =
    `flex w-full items-center gap-2 px-3 py-2 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 ${transitionBase}`;

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
      {user?.email && (
        <p className="px-3 py-2 text-[11px] text-zinc-400 truncate border-b border-zinc-200">
          {user.email}
        </p>
      )}
      <NavLink to="/custom-images" className={adminLinkClass} onClick={close}>
        <Container className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
        Images
      </NavLink>
      {isAdmin && (
        <>
          <NavLink to="/admin/users" className={adminLinkClass} onClick={close}>
            <Users className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
            Users
          </NavLink>
          <NavLink to="/admin/agents" className={adminLinkClass} onClick={close}>
            <Bot className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
            Agents
          </NavLink>
          <NavLink to="/admin/gateway" className={adminLinkClass} onClick={close}>
            <Globe className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
            Gateway
          </NavLink>
          <div className="my-1 border-t border-zinc-200" />
        </>
      )}
      {onOpenSettings && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            onOpenSettings?.();
          }}
          className={menuItemClass}
        >
          <Settings2 className="w-3.5 h-3.5 shrink-0" />
          Settings
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          close();
          onLogout?.();
        }}
        className={menuItemClass}
      >
        <LogOut className="w-3.5 h-3.5 shrink-0" />
        Log out
      </button>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={isAdmin ? 'Admin menu' : 'Account menu'}
        title={isAdmin ? 'Admin' : (user?.username || 'User')}
        className={`flex w-full items-center rounded-lg text-left ${transitionBase} hover:bg-zinc-50 ${
          open ? 'bg-zinc-50' : ''
        } ${collapsed ? `justify-center p-2 ${consoleButtonFocusClass}` : 'gap-2 px-2 py-2'}`}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600 text-xs font-semibold">
          {(user?.username || 'U').charAt(0).toUpperCase()}
        </div>
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-zinc-900">
                {isAdmin ? 'Admin' : (user?.username || 'User')}
              </p>
              {isAdmin && (
                <p className="truncate text-[10px] text-zinc-400">{user?.username || 'User'}</p>
              )}
            </div>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
              strokeWidth={2}
            />
          </>
        )}
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}

export default function AppSidebar({
  agents,
  projects,
  sessions,
  activeSession,
  onSelectSession,
  fetchWorkspaces,
  onCreateWorkspace,
  onImportFromGit,
  onNewAgent,
  onRequestDeleteSession,
  onRequestDeleteWorkspace,
  onArchiveSession,
  user,
  onOpenSettings,
  onLogout,
}) {
  const [sidebarPrefs, setSidebarPrefs] = useState(() => loadSidebarPrefs());
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [expandedWorkspaces, setExpandedWorkspaces] = useState(() => {
    const ids = new Set();
    if (activeSession?.projectId) ids.add(activeSession.projectId);
    return ids;
  });
  const [expandedSessionLists, setExpandedSessionLists] = useState(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');

  const setSidebarCollapsed = useCallback((next) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  const [activeOnlyFilter, setActiveOnlyFilter] = useState(false);
  const [resumingSessionId, setResumingSessionId] = useState(null);
  const [customImageMap, setCustomImageMap] = useState({});
  const [renameId, setRenameId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameLoading, setRenameLoading] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    apiFetch('/api/v1/custom-images').then((res) => res.json()).then((data) => {
      const list = data.images || (Array.isArray(data) ? data : []);
      const map = {};
      for (const img of list) { map[img.id] = img.name; }
      setCustomImageMap(map);
    }).catch(() => {});
  }, [sessions.length]);

  const refreshSidebarPrefs = useCallback(() => setSidebarPrefs(loadSidebarPrefs()), []);

  useEffect(() => {
    refreshSidebarPrefs();
  }, [sessions, projects, refreshSidebarPrefs]);


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

  const handleArchiveSession = (e, sessionId) => {
    e.stopPropagation();
    archiveSession(sessionId);
    refreshSidebarPrefs();
    onArchiveSession?.(sessionId);
  };

  const handleResumeSession = useCallback(async (session, ws) => {
    if (!session?.id || resumingSessionId) return;
    setResumingSessionId(session.id);
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(session.id)}/resume`, {
        method: 'POST',
      });
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (!res.ok) {
        const errorMessage = data.error || 'Failed to resume session';
        if (res.status === 409) {
          showToast('error', errorMessage);
          return;
        }
        throw new Error(errorMessage);
      }

      await fetchWorkspaces?.();
      onSelectSession?.({
        ...session,
        projectName: session.projectName || ws?.name || null,
      });
    } catch (err) {
      showToast('error', err.message || 'Failed to resume session');
    } finally {
      setResumingSessionId(null);
    }
  }, [fetchWorkspaces, onSelectSession, resumingSessionId, showToast]);

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
      if (!res.ok) throw new Error(data.error || 'Rename failed');
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

  const sessionMatchesQuery = useCallback((s, ws) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const label = (s.title?.trim() || getAgentLabel(s.agentId)).toLowerCase();
    const wsName = (ws?.name || '').toLowerCase();
    return label.includes(q) || wsName.includes(q);
  }, [searchQuery, getAgentLabel]);

  const renderNestedSessionRow = (s, ws) => {
    const isActive = activeSession?.sessionId === s.id;
    const isLive = s.alive === true;
    const isPending = s.status === 'pending';
    const isFailed = s.status === 'failed';
    const canResume = !isLive && !isPending && !isFailed && s.recoverable === true;
    const isResuming = resumingSessionId === s.id;
    const label = s.title?.trim() || getAgentLabel(s.agentId);
    const timestamp = s.createdAt ? formatRelativeTime(s.createdAt) : '';
    const imageName = s.customImageId ? customImageMap[s.customImageId] : null;

    return (
      <div
        key={s.id}
        className={`group/session relative flex items-center gap-1 rounded-md pl-6 pr-1.5 py-1.5 ${transitionBase} ${
          isActive ? bgCanvas : hoverBgTertiary
        } ${!isLive ? 'opacity-70' : ''}`}
      >
        <button
          type="button"
          onClick={() => selectSession(s, ws)}
          className="flex flex-1 min-w-0 items-center gap-2 text-left"
          title={imageName ? `${label} · ${imageName}` : label}
        >
          <span className={`flex-1 truncate text-[13px] ${isActive ? 'font-medium text-zinc-900' : 'text-zinc-700'}`}>
            {label}
          </span>
          {imageName && (
            <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] bg-zinc-100 text-zinc-500 max-w-[80px] truncate">
              <Container className="w-2.5 h-2.5 shrink-0" />
              {imageName}
            </span>
          )}
          {isPending && (
            <Loader2 className="w-3 h-3 shrink-0 animate-spin text-amber-500" />
          )}
          {isFailed && (
            <span className="w-1.5 h-1.5 rounded-full bg-red-600 shrink-0" />
          )}
          {timestamp && (
            <span className={`shrink-0 text-[11px] ${textPlaceholder}`}>{timestamp}</span>
          )}
        </button>
        <div className="flex items-center shrink-0 opacity-0 group-hover/session:opacity-100 focus-within:opacity-100">
          {canResume && (
            <button
              type="button"
              title={isResuming ? 'Resuming…' : 'Resume'}
              aria-label={isResuming ? 'Resuming session' : 'Resume session'}
              onClick={(e) => {
                e.stopPropagation();
                handleResumeSession(s, ws);
              }}
              disabled={Boolean(resumingSessionId)}
              className={`p-1 rounded-md ${textPlaceholder} ${hoverTextPrimary} hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isResuming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            </button>
          )}
          <button
            type="button"
            title="Archive"
            onClick={(e) => handleArchiveSession(e, s.id)}
            className={`p-1 rounded-md ${textPlaceholder} ${hoverTextPrimary} hover:bg-zinc-200`}
          >
            <Archive className="w-3 h-3" />
          </button>
          <button
            type="button"
            title={isLive ? 'Stop and remove' : 'Remove'}
            onClick={(e) => {
              e.stopPropagation();
              onRequestDeleteSession?.(s, ws);
            }}
            className={`p-1 rounded-md ${textPlaceholder} ${accentRed} ${accentRedBg}`}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  };

  const renderSessionList = (sessionList, ws, listKey) => {
    const filtered = sessionList.filter((s) => sessionMatchesQuery(s, ws));
    if (filtered.length === 0) {
      return (
        <p className={`py-1.5 pl-6 pr-2 text-xs ${textPlaceholder}`}>
          {searchQuery.trim() ? 'No matching sessions' : 'No sessions yet'}
        </p>
      );
    }
    const expanded = expandedSessionLists.has(listKey);
    const visible = expanded ? filtered : filtered.slice(0, SESSION_PREVIEW_LIMIT);
    const hasMore = filtered.length > SESSION_PREVIEW_LIMIT;

    return (
      <>
        {visible.map((s) => renderNestedSessionRow(s, ws))}
        {hasMore && !expanded && (
          <button
            type="button"
            onClick={() => toggleSessionListExpanded(listKey)}
            className={`pl-6 pr-2 py-1 text-xs ${textPlaceholder} ${hoverTextPrimary} text-left ${transitionBase}`}
          >
            More
          </button>
        )}
      </>
    );
  };

  const workspaces = useMemo(() => buildWorkspaces(projects, sessions, sidebarPrefs), [projects, sessions, sidebarPrefs]);

  const filteredWorkspaces = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return workspaces.filter((ws) => {
      if (activeOnlyFilter && ws.id !== '_orphan' && !ws.sessions.some((s) => s.alive)) {
        return false;
      }
      if (!q) return true;
      if (ws.name.toLowerCase().includes(q)) return true;
      return ws.sessions.some((s) => sessionMatchesQuery(s, ws));
    });
  }, [workspaces, searchQuery, activeOnlyFilter, sessionMatchesQuery]);

  const adminLinkClass = ({ isActive }) =>
    `flex w-full items-center gap-2 px-3 py-2 text-xs font-medium transition-colors ${
      isActive
        ? 'bg-zinc-100 text-zinc-900'
        : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
    }`;

  const sidebarNavItemClass =
    `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-zinc-700 ${hoverBgTertiary} ${transitionBase}`;

  if (collapsed) {
    return (
      <aside
        className={`h-full w-14 ${bgSecondary} border-r border-zinc-200 flex flex-col flex-shrink-0 select-none`}
        data-testid="app-sidebar-collapsed"
      >
        <div className="shrink-0 flex flex-col items-center gap-1 px-1.5 pt-3 pb-2 border-b border-zinc-200">
          <BrandMark className="h-8 w-8" iconClassName="h-4 w-4" />
          <button
            type="button"
            title="Expand sidebar"
            aria-label="Expand sidebar"
            onClick={() => setSidebarCollapsed(false)}
            className={`mt-1 p-2 rounded-lg ${textPlaceholder} hover:text-zinc-900 ${hoverBgTertiary} ${transitionBase} ${consoleButtonFocusClass}`}
          >
            <PanelLeft className="w-4 h-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            disabled={!onNewAgent}
            onClick={onNewAgent}
            title="New Agent"
            aria-label="New Agent"
            className={`p-2 rounded-lg text-zinc-700 hover:text-zinc-900 ${hoverBgTertiary} ${transitionBase} disabled:opacity-40 ${consoleButtonFocusClass}`}
          >
            <PenSquare className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex-1 min-h-0" />
        <div className="shrink-0 border-t border-zinc-200 px-1.5 py-2">
          <SidebarAccountMenu
            user={user}
            onOpenSettings={onOpenSettings}
            onLogout={onLogout}
            adminLinkClass={adminLinkClass}
            collapsed
          />
        </div>
      </aside>
    );
  }

  return (
    <aside className={`h-full w-[272px] ${bgSecondary} border-r border-zinc-200 flex flex-col flex-shrink-0 select-none`}>
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-zinc-200">
        <div className="flex items-center gap-2 px-0.5 mb-2">
          <BrandMark className="h-7 w-7" iconClassName="h-3.5 w-3.5" />
          <span className="min-w-0 flex-1 truncate text-sm font-bold text-zinc-900">XEnsemble</span>
          <button
            type="button"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            onClick={() => setSidebarCollapsed(true)}
            className={`p-1.5 rounded-md ${textPlaceholder} hover:text-zinc-900 ${hoverBgTertiary} ${transitionBase} ${consoleButtonFocusClass}`}
          >
            <PanelLeftClose className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
        <div className="space-y-0.5">
          <button
            type="button"
            disabled={!onNewAgent}
            onClick={onNewAgent}
            className={`${sidebarNavItemClass} disabled:opacity-40`}
          >
            <PenSquare className="w-4 h-4 shrink-0" strokeWidth={1.75} />
            New Agent
          </button>
          <label className={`${sidebarNavItemClass} cursor-text`}>
            <Search className="w-4 h-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-700 placeholder:text-zinc-400 outline-none"
            />
          </label>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-2 py-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between px-1.5 mb-1">
            <h3 className="text-xs font-medium text-zinc-400">Workspaces</h3>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                title="Import from Git"
                disabled={!onImportFromGit}
                onClick={onImportFromGit}
                className={`p-1 rounded-md ${textPlaceholder} hover:text-zinc-900 ${hoverBgTertiary} ${transitionBase} disabled:opacity-40`}
              >
                <GitBranch className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                title={activeOnlyFilter ? 'Show all workspaces' : 'Show active workspaces'}
                onClick={() => setActiveOnlyFilter((v) => !v)}
                className={`p-1 rounded-md ${transitionBase} ${
                  activeOnlyFilter
                    ? `text-zinc-900 ${bgCanvas}`
                    : `${textPlaceholder} hover:text-zinc-900 ${hoverBgTertiary}`
                }`}
              >
                <ListFilter className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                title="New workspace"
                disabled={!onCreateWorkspace}
                onClick={onCreateWorkspace}
                className={`p-1 rounded-md ${textPlaceholder} hover:text-zinc-900 ${hoverBgTertiary} ${transitionBase} disabled:opacity-40`}
              >
                <FolderPlus className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
            </div>
          </div>
          {filteredWorkspaces.length === 0 ? (
            <p className={`text-xs ${textSecondary} px-2.5 py-2`}>
              {projects.length === 0
                ? 'No workspaces yet. Create one, then start a New Agent.'
                : 'No matching workspaces.'}
            </p>
          ) : (
            filteredWorkspaces.map((ws) => {
              const expanded = expandedWorkspaces.has(ws.id) || !!searchQuery.trim();
              const liveInWs = ws.sessions.filter((s) => s.alive === true).length;
              const isOrphan = ws.id === '_orphan';
              const wsPinned = isPinnedWorkspace(sidebarPrefs, ws.id);
              const visibleSessions = ws.sessions.filter((s) => sessionMatchesQuery(s, ws));
              const gitLinked = isGitLinkedProject(ws);
              const repoLabel = getWorkspaceRepoLabel(ws);
              const providerLabel = getProviderLabel(ws.repoProvider);
              const gitTitle = gitLinked
                ? [providerLabel, repoLabel, ws.currentBranch ? `branch: ${ws.currentBranch}` : null]
                  .filter(Boolean)
                  .join(' · ')
                : ws.name;
              const isCloning = isWorkspaceClonePending(ws);
              return (
                <div key={ws.id} className="rounded-lg">
                  <div className={`group flex items-center gap-0.5 rounded-lg hover:bg-zinc-50 ${expanded ? 'bg-zinc-50' : ''}`}>
                    <button
                      type="button"
                      onClick={() => toggleWorkspaceExpanded(ws.id)}
                      className={`p-1.5 ${textPlaceholder} ${hoverTextPrimary} shrink-0 ${transitionBase}`}
                      aria-expanded={expanded}
                    >
                      {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                    {gitLinked ? (
                      <GitBranch className={`w-3.5 h-3.5 ${textPlaceholder} shrink-0`} strokeWidth={1.75} />
                    ) : (
                      <FolderOpen className={`w-3.5 h-3.5 ${textPlaceholder} shrink-0`} strokeWidth={1.75} />
                    )}
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
                          className={`flex-1 min-w-0 bg-transparent text-[13px] ${textPrimary} outline-none border-b border-zinc-400 py-1 mr-1`}
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
                          className={`flex-1 min-w-0 text-left py-2 pr-1 text-[13px] ${textPrimary}`}
                          title={gitTitle}
                        >
                          <span className="flex items-center gap-1.5 min-w-0">
                            <span className="truncate">{ws.name}</span>
                            {liveInWs > 0 && (
                              <span className={`shrink-0 text-[10px] font-medium ${accentGreen}`}>{liveInWs}</span>
                            )}
                          </span>
                          {gitLinked && repoLabel && (
                            <span className={`block truncate text-[10px] ${textPlaceholder}`}>
                              {providerLabel}: {repoLabel}
                            </span>
                          )}
                        </button>
                        {isCloning && (
                          <Loader2 className={`w-3.5 h-3.5 shrink-0 animate-spin ${textPlaceholder}`} />
                        )}
                        {!isOrphan && (
                          <button
                            type="button"
                            title="Rename workspace"
                            onClick={(e) => handleStartRename(e, ws)}
                            className={`p-1.5 rounded-lg ${textPlaceholder} ${hoverTextPrimary} hover:bg-zinc-200 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity ${transitionBase}`}
                          >
                            <PenSquare className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {!isOrphan && (
                          <button
                            type="button"
                            title={wsPinned ? 'Unpin workspace' : 'Pin workspace'}
                            onClick={(e) => handlePinWorkspace(e, ws.id)}
                            className={`p-1.5 rounded-lg ${textPlaceholder} ${hoverTextPrimary} hover:bg-zinc-200 transition-opacity ${
                              wsPinned ? `opacity-100 ${textSecondary}` : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                            }`}
                          >
                            <Pin className={`w-3.5 h-3.5 ${wsPinned ? 'fill-current' : ''}`} />
                          </button>
                        )}
                        <button
                          type="button"
                          title={isOrphan ? 'Clear unassigned sessions' : 'Delete workspace'}
                          onClick={(e) => handleRequestDeleteWorkspace(e, ws)}
                          className={`p-1.5 mr-0.5 ${textPlaceholder} ${accentRed} ${accentRedBg} rounded-lg opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity ${transitionBase}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                  {expanded && (
                    <div className="flex flex-col pb-0.5">
                      {renderSessionList(visibleSessions, ws, ws.id)}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-zinc-200 px-2 py-2">
        <SidebarAccountMenu
          user={user}
          onOpenSettings={onOpenSettings}
          onLogout={onLogout}
          adminLinkClass={adminLinkClass}
        />
      </div>
    </aside>
  );
}
