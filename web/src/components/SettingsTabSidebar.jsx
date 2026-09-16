import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Settings2,
  Container,
  Users,
  Bot,
  Globe,
  GitBranch,
  Palette,
  Sparkles,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { getAccessToken } from '../lib/api';
import { getDraftsUnreadCount, markDraftsSeen } from '../lib/skillsApi';
import {
  consoleSettingsTabActiveClass,
  consoleSettingsTabIdleClass,
} from '../lib/consoleTokens';
import { SidebarAccountMenu } from './AppSidebar';

const ALL_TABS = [
  { id: 'preferences', labelKey: 'settings:tabs.preferences', icon: Palette, route: '/settings', adminOnly: false },
  { id: 'general', labelKey: 'settings:tabs.general', icon: Settings2, route: '/settings', adminOnly: true },
  { id: 'git', labelKey: 'settings:tabs.git_providers', icon: GitBranch, route: '/settings', adminOnly: false },
  { id: 'skills', labelKey: 'settings:tabs.skills', icon: Sparkles, route: '/skills', adminOnly: false },
  { id: 'images', labelKey: 'images:agent_images', icon: Container, route: '/custom-images', adminOnly: true },
  { id: 'agents', labelKey: 'agents:title', icon: Bot, route: '/admin/agents', adminOnly: true },
  { id: 'users', labelKey: 'users:title', icon: Users, route: '/admin/users', adminOnly: true },
  { id: 'gateway', labelKey: 'gateway:title', icon: Globe, route: '/admin/gateway', adminOnly: true },
];

// 默认 section：按角色取侧边栏第一个可见 tab。
export function defaultSettingsSection(isAdmin = false) {
  return ALL_TABS.find((tab) => !tab.adminOnly || isAdmin)?.id;
}

export default function SettingsTabSidebar({ activeTab, onSectionChange, user, onLogout }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isAdmin = user?.role === 'admin';

  // P3: skills 草稿未读徽章（SSE skill_draft_created 实时 +1，进 Skills 页清零）。
  // 原挂最外层侧边栏 Skills 入口，入口迁入设置后随迁至此。
  const [skillsUnread, setSkillsUnread] = useState(0);
  const skillsUnreadRef = useRef(0);

  useEffect(() => {
    let active = true;
    getDraftsUnreadCount()
      .then((n) => {
        if (!active) return;
        skillsUnreadRef.current = n;
        setSkillsUnread(n);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es = null;
    let closed = false;
    let reconnectTimer = null;
    const base = import.meta.env.VITE_API_BASE_URL
      || (typeof window !== 'undefined' ? window.location.origin : '');
    const connect = () => {
      const token = getAccessToken();
      es = new EventSource(`${base}/api/v1/events?access_token=${encodeURIComponent(token || '')}`);
      es.addEventListener('message', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'skill_draft_created') {
            skillsUnreadRef.current += 1;
            setSkillsUnread(skillsUnreadRef.current);
          }
        } catch { /* ignore invalid data */ }
      });
      es.addEventListener('error', () => {
        es?.close();
        if (closed) return;
        reconnectTimer = setTimeout(connect, 3000);
      });
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      clearTimeout(reconnectTimer);
    };
  }, []);

  const visibleTabs = ALL_TABS.filter((tab) => !tab.adminOnly || isAdmin);

  return (
    <aside className="h-full w-48 shrink-0 flex flex-col border-r border-zinc-200 bg-zinc-50 select-none">
      <nav className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-0.5">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === activeTab;
          const handleClick = () => {
            if (tab.id === 'skills') {
              skillsUnreadRef.current = 0;
              setSkillsUnread(0);
              markDraftsSeen().catch(() => {});
            }
            if (tab.id === 'general' || tab.id === 'git' || tab.id === 'preferences') {
              onSectionChange?.(tab.id);
            } else if (tab.route) {
              navigate(tab.route);
            }
          };
          return (
            <button
              key={tab.id}
              type="button"
              onClick={handleClick}
              className={cn(
                'flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm font-medium text-left transition-colors',
                isActive
                  ? consoleSettingsTabActiveClass
                  : cn(consoleSettingsTabIdleClass, 'hover:bg-zinc-100'),
              )}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
              {t(tab.labelKey, { defaultValue: tab.id })}
              {tab.id === 'skills' && skillsUnread > 0 && (
                <span
                  className="ml-auto shrink-0 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-medium"
                  title={t('skills:unread_drafts', { count: skillsUnread })}
                >
                  {skillsUnread > 99 ? '99+' : skillsUnread}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="shrink-0 border-t border-zinc-200 px-2 py-2">
        <SidebarAccountMenu
          user={user}
          onOpenSettings={() => navigate('/settings')}
          onOpenObservability={() => navigate('/observability')}
          onLogout={onLogout}
        />
      </div>
    </aside>
  );
}
