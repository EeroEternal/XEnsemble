import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../App';
import PageHeader from '../PageHeader';
import { consoleAdminPageClass } from '../../lib/consoleTokens';
import GeneralSettingsPanel from './GeneralSettingsPanel';
import GitHubSettingsPanel from './GitHubSettingsPanel';
import GitProvidersSettingsPanel from './GitProvidersSettingsPanel';
import QuotaSettingsPanel from './QuotaSettingsPanel';
import LanguageSettingsPanel from './LanguageSettingsPanel';

const SECTION_TITLES = {
  general: 'General',
  git: 'Git',
  'git-providers': 'Git',
  github: 'Git',
  quota: 'Quota',
  language: 'Language',
};

export default function SettingsShell({ section = 'general' }) {
  const { t } = useTranslation();
  const { user } = useContext(AuthContext);
  const isAdmin = user?.role === 'admin';
  const title = SECTION_TITLES[section] ? t(`settings:tabs.${SECTION_TITLES[section].toLowerCase()}`, { defaultValue: SECTION_TITLES[section] }) : t('settings:title');

  let panel = null;
  if (section === 'general') panel = <GeneralSettingsPanel />;
  else if (section === 'git') panel = isAdmin ? <GitProvidersSettingsPanel /> : <GitHubSettingsPanel />;
  else if (section === 'git-providers' && isAdmin) panel = <GitProvidersSettingsPanel />;
  else if (section === 'github' && !isAdmin) panel = <GitHubSettingsPanel />;
  else if (section === 'quota') panel = <QuotaSettingsPanel />;
  else if (section === 'language') panel = <LanguageSettingsPanel />;

  return (
    <div className={consoleAdminPageClass}>
      <PageHeader title={title} />
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto console-scroll-hidden">
        {panel}
      </div>
    </div>
  );
}
