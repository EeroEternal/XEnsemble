import { useContext } from 'react';
import { AuthContext } from '../../App';
import PageHeader from '../PageHeader';
import {
  consoleSettingsPanelScrollClass,
} from '../../lib/consoleTokens';
import GeneralSettingsPanel from './GeneralSettingsPanel';
import ApiKeysSettingsPanel from './ApiKeysSettingsPanel';
import GitHubSettingsPanel from './GitHubSettingsPanel';
import GitProvidersSettingsPanel from './GitProvidersSettingsPanel';
import QuotaSettingsPanel from './QuotaSettingsPanel';

const SECTION_TITLES = {
  general: 'General',
  'api-keys': 'API Keys',
  git: 'Git',
  'git-providers': 'Git',
  github: 'Git',
  quota: 'Quota',
};

export default function SettingsShell({ section = 'general' }) {
  const { user } = useContext(AuthContext);
  const isAdmin = user?.role === 'admin';
  const title = SECTION_TITLES[section] || 'Settings';

  let panel = null;
  if (section === 'general') panel = <GeneralSettingsPanel />;
  else if (section === 'api-keys') panel = <ApiKeysSettingsPanel />;
  else if (section === 'git') panel = isAdmin ? <GitProvidersSettingsPanel /> : <GitHubSettingsPanel />;
  else if (section === 'git-providers' && isAdmin) panel = <GitProvidersSettingsPanel />;
  else if (section === 'github' && !isAdmin) panel = <GitHubSettingsPanel />;
  else if (section === 'quota') panel = <QuotaSettingsPanel />;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="px-5 pt-5 shrink-0">
        <PageHeader title={title} />
      </div>
      <div className={consoleSettingsPanelScrollClass}>
        {panel}
      </div>
    </div>
  );
}
