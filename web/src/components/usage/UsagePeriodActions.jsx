import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import { consoleIconButtonClass } from '../../lib/consoleTokens';

/** 观测页共享的周期选择 + 刷新按钮（用户统计 / 智能体与模型两页表头 actions 一致）。 */
export default function UsagePeriodActions({ days, onDaysChange, refreshing, onRefresh }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <SelectMenu
        value={days}
        onChange={onDaysChange}
        options={[
          { value: '7', label: t('users:usage.period_7d') },
          { value: '30', label: t('users:usage.period_30d') },
          { value: '90', label: t('users:usage.period_90d') },
        ]}
      />
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className={consoleIconButtonClass}
        title={t('common:action.refresh')}
      >
        {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      </button>
    </div>
  );
}
