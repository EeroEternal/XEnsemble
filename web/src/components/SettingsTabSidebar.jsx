import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Settings2,
  Container,
  Users,
  Bot,
  Globe,
  GitBranch,
  Gauge,
  Palette,
} from 'lucide-react';
import { cn } from '../lib/utils';
import {
  consoleSettingsTabActiveClass,
  consoleSettingsTabIdleClass,
} from '../lib/consoleTokens';
import { SidebarAccountMenu } from './AppSidebar';

const ALL_TABS = [
  { id: 'preferences', labelKey: 'settings:tabs.preferences', icon: Palette, route: '/settings', adminOnly: false },
  { id: 'general', labelKey: 'settings:tabs.general', icon: Settings2, route: '/settings', adminOnly: true },
  { id: 'git', labelKey: 'settings:tabs.git_providers', icon: GitBranch, route: '/settings', adminOnly: false },
  { id: 'quota', labelKey: 'settings:tabs.quota', icon: Gauge, route: '/settings', adminOnly: false },
  { id: 'images', labelKey: 'images:agent_images', icon: Container, route: '/custom-images', adminOnly: true },
  { id: 'agents', labelKey: 'agents:title', icon: Bot, route: '/admin/agents', adminOnly: true },
  { id: 'users', labelKey: 'users:title', icon: Users, route: '/admin/users', adminOnly: true },
  { id: 'gateway', labelKey: 'gateway:title', icon: Globe, route: '/admin/gateway', adminOnly: true },
];

// 默认 section：按角色取侧边栏第一个可见 tab。
export function defaultSettingsSection(isAdmin = false) {
  return ALL_TABS.find((tab) => !tab.adminOnly || isAdmin)?.id;
}

export default function SettingsTabSidebar({ activeTab, onSectionChange, user, onOpenSettings, onLogout }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isAdmin = user?.role === 'admin';

  const visibleTabs = ALL_TABS.filter((tab) => !tab.adminOnly || isAdmin);

  return (
    <aside className="h-full w-48 shrink-0 flex flex-col border-r border-zinc-200 bg-zinc-50 select-none">
      <nav className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-0.5">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === activeTab;
          const handleClick = () => {
            if (tab.id === 'general' || tab.id === 'git' || tab.id === 'quota' || tab.id === 'preferences') {
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
            </button>
          );
        })}
      </nav>
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
