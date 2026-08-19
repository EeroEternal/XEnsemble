import { useContext } from 'react';
import { AuthContext } from '../../App';
import { consoleSettingsPanelScrollClass } from '../../lib/consoleTokens';
import GeneralSettingsPanel from './GeneralSettingsPanel';
import ApiKeysSettingsPanel from './ApiKeysSettingsPanel';
import GitHubSettingsPanel from './GitHubSettingsPanel';
import GitProvidersSettingsPanel from './GitProvidersSettingsPanel';
import QuotaSettingsPanel from './QuotaSettingsPanel';

export default function SettingsShell({ section = 'general' }) {
  const { user } = useContext(AuthContext);
  const isAdmin = user?.role === 'admin';

  return (
    <div className={consoleSettingsPanelScrollClass}>
      {section === 'general' && <GeneralSettingsPanel />}
      {section === 'api-keys' && <ApiKeysSettingsPanel />}
      {section === 'git' && isAdmin && <GitProvidersSettingsPanel />}
      {section === 'git' && !isAdmin && <GitHubSettingsPanel />}
      {section === 'git-providers' && isAdmin && <GitProvidersSettingsPanel />}
      {section === 'github' && !isAdmin && <GitHubSettingsPanel />}
      {section === 'quota' && <QuotaSettingsPanel />}
    </div>
  );
}
