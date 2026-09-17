import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Gauge, BarChart3, Route, TrendingUp } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  consoleSettingsTabActiveClass,
  consoleSettingsTabIdleClass,
} from '../lib/consoleTokens';
import { SidebarAccountMenu } from './AppSidebar';

export const OBSERVABILITY_TABS = [
  { id: 'quota', labelKey: 'observability:tabs.quota', icon: Gauge, adminOnly: false },
  { id: 'my-usage', labelKey: 'observability:tabs.my_usage', icon: TrendingUp, adminOnly: false },
  { id: 'usage', labelKey: 'observability:tabs.usage', icon: BarChart3, adminOnly: true },
  { id: 'routing-analytics', labelKey: 'observability:tabs.routing_analytics', icon: Route, adminOnly: false },
];

export function defaultObservabilitySection() {
  return OBSERVABILITY_TABS[0].id;
}

/** 非法 / 越权 section 一律回退到第一个可见 tab。 */
export function resolveObservabilitySection(value, isAdmin = false) {
  const tab = OBSERVABILITY_TABS.find((t) => t.id === value);
  if (tab && (!tab.adminOnly || isAdmin)) return tab.id;
  return defaultObservabilitySection();
}

export default function ObservabilityTabSidebar({ activeTab, onSectionChange, user, onLogout }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';

  const visibleTabs = OBSERVABILITY_TABS.filter((tab) => !tab.adminOnly || isAdmin);

  return (
    <aside className="h-full w-48 shrink-0 flex flex-col border-r border-zinc-200 bg-zinc-50 select-none">
      <nav className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-0.5">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSectionChange?.(tab.id)}
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
          onOpenSettings={() => navigate('/settings')}
          onOpenObservability={() => navigate('/observability')}
          onLogout={onLogout}
        />
      </div>
    </aside>
  );
}
