/**
 * 顶栏铃铛 + 通知面板（docs/proposals/agent-attention-notification.md §7/§8）。
 *
 * - 角标：30s 轮询 GET /api/v1/notifications/unread-count（P1 轮询，P2 换推送）；
 * - 面板：游标分页列表（nextCursor 加载更多）、未读红点、全部已读、单条已读；
 * - 点击跳转：session_* → /sessions?focus=<sessionId>（App 桥接选中会话），
 *   skill_created → /skills；
 * - 挂载于 SidebarAccountMenu 行内（App/Settings/Observability 三种侧栏共用）。
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell, CheckCheck, Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import {
  consoleButtonFocusClass,
  transitionBase,
  consoleMenuDropdownZClass,
  consoleDropdownPanelClass,
} from '../lib/consoleTokens';

const POLL_MS = 30000;
const PAGE_SIZE = 20;

/** 面板条目主文案（i18n 插值 + payload 快照兜底）。 */
function itemTitle(n, t) {
  const p = n.payload || {};
  if (n.type === 'skill_created') {
    return t('notifications:item.skill_created', { name: p.skillTitle || p.skillName || '' });
  }
  const agent = p.agentName || t('notifications:item.fallback_agent');
  const project = p.projectName || t('notifications:item.fallback_workspace');
  const session = p.sessionTitle || p.sessionId || '';
  const key = n.type === 'session_completed' ? 'session_completed' : 'session_waiting';
  return t(`notifications:item.${key}`, { agent, project, session });
}

/** 外点 / Escape 关闭（与 SidebarAccountMenu 同款交互）。 */
function useOutsideClose(active, rootRef, panelRef, onClose) {
  useEffect(() => {
    if (!active) return undefined;
    const onPointerDown = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      onClose();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [active, rootRef, panelRef, onClose]);
}

export default function NotificationBell({ collapsed = false }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [anchor, setAnchor] = useState(null); // 面板定位锚点（fixed）
  const rootRef = useRef(null);
  const panelRef = useRef(null);

  const refreshUnread = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/notifications/unread-count');
      if (!res.ok) return;
      const data = await res.json();
      setUnread(Number(data?.count) || 0);
    } catch { /* 轮询失败静默，下一轮再试 */ }
  }, []);

  useEffect(() => {
    refreshUnread();
    const timer = setInterval(refreshUnread, POLL_MS);
    return () => clearInterval(timer);
  }, [refreshUnread]);

  const loadList = useCallback(async ({ append = false, cursor = null } = {}) => {
    setLoadingList(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) params.set('before', cursor);
      const res = await apiFetch(`/api/v1/notifications?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setItems((prev) => (append ? [...prev, ...(data.items || [])] : (data.items || [])));
        setNextCursor(data.nextCursor || null);
        if (typeof data.unreadCount === 'number') setUnread(data.unreadCount);
      }
    } catch { /* 面板数据拉取失败静默 */ } finally {
      setLoadingList(false);
    }
  }, []);

  const updateAnchor = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setAnchor({
      left: Math.max(8, rect.left - 8),
      bottom: window.innerHeight - rect.top + 6,
      width: 320,
    });
  }, []);

  useOutsideClose(open, rootRef, panelRef, useCallback(() => setOpen(false), []));

  const toggle = () => {
    if (open) { setOpen(false); return; }
    updateAnchor();
    setOpen(true);
    refreshUnread();
    loadList({ append: false });
  };

  /** 单条已读（乐观更新，失败不打断跳转）。 */
  const markOne = (id) => {
    setItems((prev) => prev.map((it) => (it.id === id && it.readAt == null ? { ...it, readAt: Date.now() } : it)));
    setUnread((u) => Math.max(0, u - 1));
    apiFetch(`/api/v1/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }).catch(() => {});
  };

  const markAll = async () => {
    if (markingAll) return;
    setMarkingAll(true);
    try {
      const res = await apiFetch('/api/v1/notifications/read-all', { method: 'POST' });
      if (res.ok) {
        const now = Date.now();
        setItems((prev) => prev.map((it) => (it.readAt == null ? { ...it, readAt: now } : it)));
        setUnread(0);
      }
    } catch { /* 静默 */ } finally {
      setMarkingAll(false);
    }
  };

  /** 点击条目：单条已读 + 跳转（session → ?focus= 桥接；skill → /skills）。 */
  const openItem = (n) => {
    markOne(n.id);
    setOpen(false);
    const p = n.payload || {};
    if (n.type === 'skill_created') {
      navigate('/skills');
      return;
    }
    if (p.sessionId) {
      navigate(`/sessions?focus=${encodeURIComponent(p.sessionId)}`);
    }
  };

  const badge = unread > 99 ? '99+' : String(unread);

  const panel = open && anchor ? (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('notifications:panel.title')}
      style={{ position: 'fixed', left: anchor.left, bottom: anchor.bottom, width: anchor.width }}
      className={`${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} py-1 shadow-md`}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200">
        <span className="text-xs font-semibold text-zinc-900">{t('notifications:panel.title')}</span>
        <button
          type="button"
          onClick={markAll}
          disabled={markingAll || unread === 0}
          title={t('notifications:panel.mark_all_read')}
          className={`flex items-center gap-1 px-1.5 py-1 rounded text-[11px] text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 disabled:opacity-40 ${transitionBase} ${consoleButtonFocusClass}`}
        >
          {markingAll
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <CheckCheck className="w-3 h-3" strokeWidth={1.75} />}
          {markingAll ? t('notifications:panel.marking_all') : t('notifications:panel.mark_all_read')}
        </button>
      </div>
      <div className="max-h-80 overflow-y-auto console-scroll-hidden">
        {items.length === 0 && !loadingList && (
          <p className="px-3 py-6 text-xs text-zinc-400 text-center">{t('notifications:panel.empty')}</p>
        )}
        {items.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => openItem(n)}
            title={t('notifications:item.read')}
            className={`flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-zinc-100 ${transitionBase} ${consoleButtonFocusClass}`}
          >
            <span
              aria-hidden
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${n.readAt == null ? 'bg-red-500' : 'bg-transparent'}`}
            />
            <span className="min-w-0 flex-1">
              <span className={`block text-xs leading-snug truncate ${n.readAt == null ? 'text-zinc-900 font-medium' : 'text-zinc-500'}`}>
                {itemTitle(n, t)}
              </span>
              <span className="block text-[10px] text-zinc-400 mt-0.5">
                {formatRelativeTime(n.createdAt, i18n.language)}
              </span>
            </span>
          </button>
        ))}
        {nextCursor && (
          <button
            type="button"
            onClick={() => loadList({ append: true, cursor: nextCursor })}
            disabled={loadingList}
            className={`flex w-full items-center justify-center gap-1 px-3 py-2 text-[11px] text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 ${transitionBase} ${consoleButtonFocusClass}`}
          >
            {loadingList && <Loader2 className="w-3 h-3 animate-spin" />}
            {t('notifications:panel.load_more')}
          </button>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={unread > 0 ? t('notifications:bell.unread_aria', { count: unread }) : t('notifications:bell.label')}
        title={t('notifications:bell.label')}
        className={`relative flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 ${transitionBase} ${
          open ? 'bg-zinc-100 text-zinc-900' : ''
        } ${collapsed ? 'p-2' : 'p-1.5'} ${consoleButtonFocusClass}`}
      >
        <Bell className="w-4 h-4" strokeWidth={1.75} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold leading-4 text-center">
            {badge}
          </span>
        )}
      </button>
      {panel && createPortal(panel, document.body)}
    </div>
  );
}
