import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { consoleSectionLabelClass, consoleCardClass } from '../../lib/consoleTokens';

import { apiFetch } from '../../lib/api';

export default function QuotaSettingsPanel() {
  const { t } = useTranslation();
  const [me, setMe] = useState(null);

  useEffect(() => {
    
    apiFetch('/api/v1/auth/me')
      .then((res) => res.json())
      .then((data) => setMe(data));
  }, []);

  if (!me?.quotas) {
    return <p className="text-sm text-zinc-400">{t('settings:quota.loading')}</p>;
  }

  const q = me.quotas;
  const u = q.usage || {};
  const isAdmin = me.role === 'admin';

  const rows = [
    { label: t('settings:quota.projects'), used: u.projects ?? 0, max: q.max_projects },
    { label: t('settings:quota.sessions'), used: u.sessions ?? 0, max: q.max_sessions },
    { label: t('settings:quota.previews'), used: u.previews ?? 0, max: q.max_previews },
  ];

  return (
    <div className="h-full overflow-y-auto console-scroll-hidden space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {rows.map(({ label, used, max }) => (
          <div key={label} className={`${consoleCardClass} p-4`}>
            <div className={`${consoleSectionLabelClass} mb-2`}>{label}</div>
            <div className="flex items-baseline gap-1 mb-3">
              <span className="text-2xl font-bold text-zinc-900">{used}</span>
              <span className="text-sm text-zinc-400">/ {isAdmin ? t('settings:quota.unlimited') : max}</span>
            </div>
            {!isAdmin && (
              <div className="h-1.5 rounded-full bg-zinc-100 overflow-hidden">
                <div
                  className="h-full bg-zinc-900 rounded-full transition-all"
                  style={{ width: `${max > 0 ? Math.min(100, (used / max) * 100) : 0}%` }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
