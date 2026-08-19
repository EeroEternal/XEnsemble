import { useState, useContext } from 'react';
import { AuthContext } from '../../App';
import { cn } from '../../lib/utils';
import {
  consoleSettingsPanelScrollClass,
  consoleSettingsTabActiveClass,
  consoleSettingsTabIdleClass,
} from '../../lib/consoleTokens';
import GeneralSettingsPanel from './GeneralSettingsPanel';
import ApiKeysSettingsPanel from './ApiKeysSettingsPanel';
import GitHubSettingsPanel from './GitHubSettingsPanel';
import GitProvidersSettingsPanel from './GitProvidersSettingsPanel';
import QuotaSettingsPanel from './QuotaSettingsPanel';

const GENERAL_SECTION = { id: 'general', label: 'General' };
const API_KEYS_SECTION = { id: 'api-keys', label: 'API Keys' };
const GITHUB_SECTION = { id: 'github', label: 'Git' };
const GIT_PROVIDERS_SECTION = { id: 'git-providers', label: 'Git' };
const IMAGES_SECTION = { id: 'images', label: 'Images' };
const AGENTS_SECTION = { id: 'agents', label: 'Agents' };
const USERS_SECTION = { id: 'users', label: 'Users' };
const GATEWAY_SECTION = { id: 'gateway', label: 'Gateway' };
const QUOTA_SECTION = { id: 'quota', label: 'Quota' };

// Sections rendered as full-height admin pages (own internal layout/scroll),
// not the padded scroll panel used by regular settings panels.
const FULL_PAGE_SECTIONS = new Set(['images', 'agents', 'users', 'gateway']);

export default function SettingsShell({ initialSection }) {
  const { user } = useContext(AuthContext);
  const [section, setSection] = useState(initialSection || 'general');
  const isAdmin = user?.role === 'admin';

  const sections = [
    GENERAL_SECTION,
    API_KEYS_SECTION,
    ...(isAdmin ? [GIT_PROVIDERS_SECTION, AGENTS_SECTION, USERS_SECTION, GATEWAY_SECTION] : [GITHUB_SECTION]),
    IMAGES_SECTION,
    QUOTA_SECTION,
  ];

  const isFullPage = FULL_PAGE_SECTIONS.has(section);

  return (
    <div className="flex h-full overflow-hidden rounded-lg border border-zinc-200">
      <nav className="w-32 shrink-0 flex flex-col gap-1 border-r border-zinc-200 bg-zinc-50 p-3">
        {sections.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id)}
            className={cn(
              'w-full px-3 py-2 rounded-md text-sm font-bold text-left transition-colors',
              section === id ? consoleSettingsTabActiveClass : consoleSettingsTabIdleClass,
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className={isFullPage ? 'flex-1 min-h-0 min-w-0' : consoleSettingsPanelScrollClass}>
        {section === 'general' && <GeneralSettingsPanel />}
        {section === 'api-keys' && <ApiKeysSettingsPanel />}
        {section === 'git-providers' && <GitProvidersSettingsPanel />}
        {section === 'github' && <GitHubSettingsPanel />}
        {section === 'quota' && <QuotaSettingsPanel />}
        {section === 'images' && <ImagesSection />}
        {section === 'agents' && isAdmin && <AgentsSection />}
        {section === 'users' && isAdmin && <UsersSection />}
        {section === 'gateway' && isAdmin && <GatewaySection />}
      </div>
    </div>
  );
}

// Lazy-load the heavy admin pages so the settings bundle stays light and the
// admin code only loads when opened.
import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';

const ImagesManager = lazy(() => import('../../pages/ImagesManager'));
const AgentsAdmin = lazy(() => import('../../pages/AgentsAdmin'));
const UsersAdmin = lazy(() => import('../../pages/UsersAdmin'));
const GatewayAdmin = lazy(() => import('../../pages/GatewayAdmin'));

function FullPageFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
    </div>
  );
}

function ImagesSection() {
  return (
    <Suspense fallback={<FullPageFallback />}>
      <ImagesManager />
    </Suspense>
  );
}
function AgentsSection() {
  return (
    <Suspense fallback={<FullPageFallback />}>
      <AgentsAdmin />
    </Suspense>
  );
}
function UsersSection() {
  return (
    <Suspense fallback={<FullPageFallback />}>
      <UsersAdmin />
    </Suspense>
  );
}
function GatewaySection() {
  return (
    <Suspense fallback={<FullPageFallback />}>
      <GatewayAdmin />
    </Suspense>
  );
}
