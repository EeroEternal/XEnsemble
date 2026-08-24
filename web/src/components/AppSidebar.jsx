import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Trash2,
  LogOut,
  Settings2,
  Search,
  PenSquare,
  Container,
  Loader2,
  ChevronDown,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import {
  loadSidebarPrefs,
  isPinnedSession,
  isArchivedSession,
  selectActiveSession,
} from '../lib/sidebarPrefs';
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

const SESSION_PREVIEW_LIMIT = 12;

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

export function SidebarAccountMenu({ user, onOpenSettings, onLogout, collapsed = false }) {
  const { t } = useTranslation();
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
          {t('settings:title')}
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
        {t('common:action.logout', { defaultValue: 'Log out' })}
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
        aria-label={isAdmin ? t('users:role.admin') : t('common:action.account_menu', { defaultValue: 'Account menu' })}
        title={isAdmin ? t('users:role.admin') : (user?.username || t('users:role.user', { defaultValue: 'User' }))}
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
                {isAdmin ? t('users:role.admin') : (user?.username || t('users:role.user', { defaultValue: 'User' }))}
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
  sessions,
  activeSession,
  activeWorkspaceId,
  activeWorkspaceName,
  onSelectSession,
  onNewSession,
  onRequestDeleteSession,
  user,
  onOpenSettings,
  onLogout,
  minimal = false,
}) {
  const { t } = useTranslation();
  const [sidebarPrefs, setSidebarPrefs] = useState(() => loadSidebarPrefs());
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [sessionListExpanded, setSessionListExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const setSidebarCollapsed = useCallback((next) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  const [customImageMap, setCustomImageMap] = useState({});

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
  }, [sessions, refreshSidebarPrefs]);

  const getAgentLabel = useCallback(
    (agentId) => agents.find((a) => a.id === agentId)?.name || agentId,
    [agents],
  );

  const selectSession = useCallback((s) => {
    const projectName = s.projectName || activeWorkspaceName;
    selectActiveSession(s.id, {
      agentId: s.agentId ?? null,
      projectId: s.projectId ?? null,
      projectName: projectName ?? null,
      createdAt: s.createdAt ?? Date.now(),
    });
    refreshSidebarPrefs();
    onSelectSession({ ...s, projectName });
  }, [onSelectSession, refreshSidebarPrefs, activeWorkspaceName]);

  const sessionMatchesQuery = useCallback((s) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const label = (s.title?.trim() || getAgentLabel(s.agentId)).toLowerCase();
    return label.includes(q);
  }, [searchQuery, getAgentLabel]);

  const renderSessionRow = (s) => {
    const isActive = activeSession?.sessionId === s.id;
    const isLive = s.alive === true;
    const isPending = s.status === 'pending';
    const isFailed = s.status === 'failed';
    const label = s.title?.trim() || getAgentLabel(s.agentId);
    const timestamp = s.createdAt ? formatRelativeTime(s.createdAt) : '';
    const imageName = s.customImageId ? customImageMap[s.customImageId] : null;

    return (
      <div
        key={s.id}
        className={`group/session relative flex items-center gap-1 rounded-md pl-2.5 pr-1.5 py-1.5 ${transitionBase} ${
          isActive ? `${bgCanvas} shadow-sm ring-1 ring-zinc-200` : hoverBgTertiary
        } ${!isLive && !isActive ? 'opacity-70' : ''}`}
      >
        {isActive && (
          <span className="absolute left-1 top-1.5 bottom-1.5 w-1 rounded-full bg-zinc-900" />
        )}
        <button
          type="button"
          onClick={() => selectSession(s)}
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
          <button
            type="button"
            title={isLive ? t('sessions:action.stop_and_remove') : t('sessions:action.remove')}
            onClick={(e) => {
              e.stopPropagation();
              onRequestDeleteSession?.(s, { name: s.projectName || activeWorkspaceName });
            }}
            className={`p-1 rounded-md ${textPlaceholder} ${accentRed} ${accentRedBg}`}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  };

  const visibleSessions = useMemo(() => {
    const filtered = sessions.filter(
      (s) =>
        !isArchivedSession(sidebarPrefs, s.id) &&
        s.status !== 'exited' &&
        (activeWorkspaceId ? s.projectId === activeWorkspaceId : true),
    );
    return sortSessions(filtered, sidebarPrefs);
  }, [sessions, sidebarPrefs, activeWorkspaceId]);

  const filteredSessions = useMemo(
    () => visibleSessions.filter((s) => sessionMatchesQuery(s)),
    [visibleSessions, sessionMatchesQuery],
  );

  const sidebarNavItemClass =
    `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-zinc-700 ${hoverBgTertiary} ${transitionBase}`;

  if (minimal) {
    return (
      <aside className={`h-full w-[272px] ${bgSecondary} border-r border-zinc-200 flex flex-col flex-shrink-0 select-none`}>
        <div className="flex-1 min-h-0" />
        <div className="shrink-0 border-t border-zinc-200 px-2 py-2">
          <SidebarAccountMenu
            user={user}
            onOpenSettings={onOpenSettings}
            onLogout={onLogout}
          />
        </div>
      </aside>
    );
  }

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
            title={t('common:action.expand_sidebar', { defaultValue: 'Expand sidebar' })}
            aria-label={t('common:action.expand_sidebar', { defaultValue: 'Expand sidebar' })}
            onClick={() => setSidebarCollapsed(false)}
            className={`mt-1 p-2 rounded-lg ${textPlaceholder} hover:text-zinc-900 ${hoverBgTertiary} ${transitionBase} ${consoleButtonFocusClass}`}
          >
            <PanelLeft className="w-4 h-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            disabled={!onNewSession}
            onClick={onNewSession}
            title={t('sessions:new_session')}
            aria-label={t('sessions:new_session')}
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
            collapsed
          />
        </div>
      </aside>
    );
  }

  return (
    <aside className={`h-full w-[272px] ${bgSecondary} border-r border-zinc-200 flex flex-col flex-shrink-0 select-none`}>
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-zinc-200">
        <div className="flex items-center justify-between px-0.5 mb-2">
          <h3 className="text-xs font-medium text-zinc-400">{t('sessions:title')}</h3>
          <button
            type="button"
            title={t('common:action.collapse_sidebar', { defaultValue: 'Collapse sidebar' })}
            aria-label={t('common:action.collapse_sidebar', { defaultValue: 'Collapse sidebar' })}
            onClick={() => setSidebarCollapsed(true)}
            className={`p-1.5 rounded-md ${textPlaceholder} hover:text-zinc-900 ${hoverBgTertiary} ${transitionBase} ${consoleButtonFocusClass}`}
          >
            <PanelLeftClose className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
        <div className="space-y-0.5">
          <button
            type="button"
            disabled={!onNewSession}
            onClick={onNewSession}
            className={`${sidebarNavItemClass} disabled:opacity-40`}
          >
            <PenSquare className="w-4 h-4 shrink-0" strokeWidth={1.75} />
            {t('sessions:new_session')}
          </button>
          <label className={`${sidebarNavItemClass} cursor-text`}>
            <Search className="w-4 h-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('sessions:search')}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-700 placeholder:text-zinc-400 outline-none"
            />
          </label>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-2 py-3">
        <div className="flex flex-col gap-0.5">
          {filteredSessions.length === 0 ? (
            <p className={`text-xs ${textSecondary} px-2.5 py-2`}>
              {searchQuery.trim()
                ? t('sessions:empty.no_matching')
                : (activeWorkspaceId
                  ? t('sessions:empty.no_sessions')
                  : t('sessions:empty.select_workspace'))}
            </p>
          ) : (
            <>
              {(sessionListExpanded || filteredSessions.length <= SESSION_PREVIEW_LIMIT
                ? filteredSessions
                : filteredSessions.slice(0, SESSION_PREVIEW_LIMIT)
              ).map((s) => renderSessionRow(s))}
              {filteredSessions.length > SESSION_PREVIEW_LIMIT && !sessionListExpanded && (
                <button
                  type="button"
                  onClick={() => setSessionListExpanded(true)}
                  className={`px-2.5 py-1 text-xs ${textPlaceholder} ${hoverTextPrimary} text-left ${transitionBase}`}
                >
                  {t('common:pagination.more')} ({filteredSessions.length - SESSION_PREVIEW_LIMIT})
                </button>
              )}
              {filteredSessions.length > SESSION_PREVIEW_LIMIT && sessionListExpanded && (
                <button
                  type="button"
                  onClick={() => setSessionListExpanded(false)}
                  className={`px-2.5 py-1 text-xs ${textPlaceholder} ${hoverTextPrimary} text-left ${transitionBase}`}
                >
                  {t('common:pagination.show_fewer')}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-zinc-200 px-2 py-2">
        <SidebarAccountMenu
          user={user}
          onOpenSettings={onOpenSettings}
          onLogout={onLogout}
        />
      </div>
    </aside>
  );
}
