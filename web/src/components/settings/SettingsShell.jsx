import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../App';
import PageHeader from '../PageHeader';
import { consoleAdminPageClass } from '../../lib/consoleTokens';
import GeneralSettingsPanel from './GeneralSettingsPanel';
import GitHubSettingsPanel from './GitHubSettingsPanel';
import GitProvidersSettingsPanel from './GitProvidersSettingsPanel';
import QuotaSettingsPanel from './QuotaSettingsPanel';
import PreferencesPanel from './PreferencesPanel';

const SECTION_TITLES = {
  general: 'General',
  preferences: 'Preferences',
  git: 'Git',
  'git-providers': 'Git',
  github: 'Git',
  quota: 'Quota',
};

export default function SettingsShell({ section = 'general' }) {
  const { t } = useTranslation();
  const { user } = useContext(AuthContext);
  const isAdmin = user?.role === 'admin';
  const title = SECTION_TITLES[section] ? t(`settings:tabs.${SECTION_TITLES[section].toLowerCase()}`, { defaultValue: SECTION_TITLES[section] }) : t('settings:title');

  let panel = null;
  if (section === 'preferences') panel = <PreferencesPanel />;
  else if (section === 'general') panel = <GeneralSettingsPanel />;
  else if (section === 'git') panel = <GitProvidersSettingsPanel />;
  else if (section === 'git-providers' && isAdmin) panel = <GitProvidersSettingsPanel />;
  else if (section === 'github' && !isAdmin) panel = <GitHubSettingsPanel />;
  else if (section === 'quota') panel = <QuotaSettingsPanel />;

  return (
    <div className={consoleAdminPageClass}>
      <PageHeader title={title} />
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto console-scroll-hidden">
        {panel}
      </div>
    </div>
  );
}
