import { useState, useEffect } from 'react';
import { consoleSectionLabelClass, consoleCardClass } from '../../lib/consoleTokens';

import { apiFetch } from '../../lib/api';

export default function QuotaSettingsPanel() {
  
  const [me, setMe] = useState(null);

  useEffect(() => {
    
    apiFetch('/api/v1/auth/me')
      .then((res) => res.json())
      .then((data) => setMe(data));
  }, []);

  if (!me?.quotas) {
    return <p className="text-sm text-zinc-400">Loading quota information…</p>;
  }

  const q = me.quotas;
  const u = q.usage || {};
  const isAdmin = me.role === 'admin';

  const rows = [
    { label: 'Workspaces', used: u.projects ?? 0, max: q.max_projects },
    { label: 'Concurrent sessions', used: u.sessions ?? 0, max: q.max_sessions },
    { label: 'Concurrent previews', used: u.previews ?? 0, max: q.max_previews },
  ];

  return (
    <div className="h-full overflow-y-auto console-scroll-hidden">
      <div className={`${consoleCardClass} p-6 space-y-5`}>
        <div>
          <h3 className={consoleSectionLabelClass}>Usage</h3>
          <div className="mt-3 space-y-4">
            {rows.map(({ label, used, max }) => (
              <div key={label}>
                <div className="flex justify-between items-baseline mb-1.5">
                  <span className="text-sm text-zinc-700">{label}</span>
                  {isAdmin ? (
                    <span className="text-sm">
                      <span className="font-mono font-medium text-zinc-900">{used}</span>
                      <span className="text-zinc-400"> / </span>
                      <span className="text-zinc-500">Unlimited</span>
                    </span>
                  ) : (
                    <span className="text-sm">
                      <span className="font-mono font-medium text-zinc-900">{used}</span>
                      <span className="text-zinc-400"> / </span>
                      <span className="font-mono text-zinc-500">{max}</span>
                    </span>
                  )}
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

        <div className="border-t border-zinc-100" />

        <div className="flex justify-between items-center">
          <span className={consoleSectionLabelClass}>Resource tier</span>
          <span className="text-sm font-medium text-zinc-900 capitalize">{q.resource_tier || 'basic'}</span>
        </div>
      </div>
    </div>
  );
}
