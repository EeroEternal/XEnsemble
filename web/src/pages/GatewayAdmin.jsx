import { useTranslation } from 'react-i18next';
import GatewaySettingsPanel from '../components/settings/GatewaySettingsPanel';
import PageHeader from '../components/PageHeader';
import { consoleAdminPageClass } from '../lib/consoleTokens';

export default function GatewayAdmin() {
  const { t } = useTranslation();
  return (
    <div className={consoleAdminPageClass}>
      <PageHeader title={t('gateway:title')} />
      <div className="min-h-0 flex-1 overflow-auto">
        <GatewaySettingsPanel />
      </div>
    </div>
  );
}
