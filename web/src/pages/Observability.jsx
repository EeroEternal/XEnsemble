import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ObservabilityTabSidebar, { resolveObservabilitySection } from '../components/ObservabilityTabSidebar';
import QuotaSettingsPanel from '../components/settings/QuotaSettingsPanel';
import PageHeader from '../components/PageHeader';
import UsageAdmin from './UsageAdmin';
import RoutingAnalytics from './RoutingAnalytics';
import { cn } from '../lib/utils';
import { APP_SHELL_PAD_CLASS, APP_SHELL_MAIN_PY_CLASS } from '../lib/appShellLayout';

/** section → 内容；usage 自带 PageHeader 且自管滚动，其余由本页提供表头。 */
function ObservabilityContent({ section }) {
  const { t } = useTranslation();
  if (section === 'usage') return <UsageAdmin />;
  if (section === 'routing-analytics') return <RoutingAnalytics />;
  return (
    <>
      <PageHeader title={t('observability:tabs.quota')} />
      <QuotaSettingsPanel />
    </>
  );
}

export default function ObservabilityPage({ user, onLogout }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = user?.role === 'admin';
  const section = resolveObservabilitySection(searchParams.get('section'), isAdmin);

  const handleSectionChange = (next) => {
    if (next === resolveObservabilitySection(null, isAdmin)) {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ section: next });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
      <ObservabilityTabSidebar
        activeTab={section}
        onSectionChange={handleSectionChange}
        user={user}
        onLogout={onLogout}
      />
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden',
          APP_SHELL_PAD_CLASS,
          APP_SHELL_MAIN_PY_CLASS,
        )}
      >
        <ObservabilityContent section={section} />
      </div>
    </div>
  );
}
