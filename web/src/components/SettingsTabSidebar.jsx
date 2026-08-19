import { useContext } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Settings2,
  Container,
  Users,
  Bot,
  Globe,
  Key,
  GitBranch,
  Gauge,
} from 'lucide-react';
import { AuthContext } from '../App';
import { cn } from '../lib/utils';
import {
  consoleSettingsTabActiveClass,
  consoleSettingsTabIdleClass,
} from '../lib/consoleTokens';

const ALL_TABS = [
  { id: 'general', label: 'General', icon: Settings2, route: null, adminOnly: false },
  { id: 'api-keys', label: 'API Keys', icon: Key, route: null, adminOnly: false },
  { id: 'git', label: 'Git', icon: GitBranch, route: null, adminOnly: false },
  { id: 'quota', label: 'Quota', icon: Gauge, route: null, adminOnly: false },
  { id: 'images', label: 'Images', icon: Container, route: '/custom-images', adminOnly: false },
  { id: 'agents', label: 'Agents', icon: Bot, route: '/admin/agents', adminOnly: true },
  { id: 'users', label: 'Users', icon: Users, route: '/admin/users', adminOnly: true },
  { id: 'gateway', label: 'Gateway', icon: Globe, route: '/admin/gateway', adminOnly: true },
];

export default function SettingsTabSidebar({ activeTab }) {
  const { user } = useContext(AuthContext);
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';

  const visibleTabs = ALL_TABS.filter((t) => !t.adminOnly || isAdmin);

  return (
    <nav className="w-48 shrink-0 flex flex-col gap-0.5 border-r border-zinc-200 bg-zinc-50 p-3 overflow-y-auto">
      {visibleTabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => tab.route && navigate(tab.route)}
            className={cn(
              'flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm font-medium text-left transition-colors',
              isActive
                ? consoleSettingsTabActiveClass
                : cn(consoleSettingsTabIdleClass, 'hover:bg-zinc-100'),
            )}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
