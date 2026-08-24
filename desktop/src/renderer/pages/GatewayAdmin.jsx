import React from 'react';
import { useTranslation } from 'react-i18next';
import PageHeader from '../components/PageHeader';
import GatewaySettingsPanel from '../components/settings/GatewaySettingsPanel';

export default function GatewayAdmin() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden p-6">
      <PageHeader
        title={t('gateway:title')}
        description={t('gateway:description', { defaultValue: 'Manage the LLM proxy process and configure providers for agents.' })}
      />
      <div className="mt-5 min-h-0 flex-1">
        <GatewaySettingsPanel />
      </div>
    </div>
  );
}
