import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Gauge, Route, TrendingUp, Users, Bot } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  consoleSettingsTabActiveClass,
  consoleSettingsTabIdleClass,
} from '../lib/consoleTokens';
import { SidebarAccountMenu } from './AppSidebar';

// 分组结构：admin 侧栏按「个人观测 / 全局观测」两级分组展示；
// 非管理员不显示分组标题，平铺可见的非 admin 项。
const OBSERVABILITY_GROUPS = [
  {
    id: 'personal',
    labelKey: 'observability:groups.personal',
    adminOnly: false,
    tabs: [
      { id: 'quota', labelKey: 'observability:tabs.quota', icon: Gauge, adminOnly: false },
      { id: 'my-usage', labelKey: 'observability:tabs.my_usage', icon: TrendingUp, adminOnly: false },
      { id: 'routing-analytics', labelKey: 'observability:tabs.routing_analytics', icon: Route, adminOnly: false },
    ],
  },
  {
    id: 'global',
    labelKey: 'observability:groups.global',
    adminOnly: true,
    tabs: [
      { id: 'user-stats', labelKey: 'observability:tabs.user_stats', icon: Users, adminOnly: true },
      { id: 'agents-models', labelKey: 'observability:tabs.agents_models', icon: Bot, adminOnly: true },
    ],
  },
];

const OBSERVABILITY_TABS = OBSERVABILITY_GROUPS.flatMap((group) => group.tabs);

// 旧 section id → 新 id：拆分前的 ?section=usage（原「用量统计」页）深链/书签
// 仍可用，统一落到拆出的「用户统计」。
const LEGACY_SECTION_ALIASES = {
  usage: 'user-stats',
};

export function defaultObservabilitySection() {
  return OBSERVABILITY_TABS[0].id;
}

/** 非法 / 越权 section 一律回退到第一个可见 tab；旧 id 先经别名映射（见 LEGACY_SECTION_ALIASES）。 */
export function resolveObservabilitySection(value, isAdmin = false) {
  const normalized = LEGACY_SECTION_ALIASES[value] || value;
  const tab = OBSERVABILITY_TABS.find((t) => t.id === normalized);
  if (tab && (!tab.adminOnly || isAdmin)) return tab.id;
  return defaultObservabilitySection();
}

export default function ObservabilityTabSidebar({ activeTab, onSectionChange, user, onLogout }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';

  const renderTab = (tab) => {
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
  };

  const groupHeaderClass = 'px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400';

  return (
    <aside className="h-full w-48 shrink-0 flex flex-col border-r border-zinc-200 bg-zinc-50 select-none">
      <nav className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-0.5">
        {isAdmin ? (
          OBSERVABILITY_GROUPS.map((group) => (
            <div key={group.id}>
              <div className={groupHeaderClass}>{t(group.labelKey)}</div>
              {group.tabs.map((tab) => renderTab(tab))}
            </div>
          ))
        ) : (
          OBSERVABILITY_GROUPS.flatMap((group) => group.tabs)
            .filter((tab) => !tab.adminOnly)
            .map((tab) => renderTab(tab))
        )}
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
