import { useState, useEffect } from 'react';
import { consoleSectionLabelClass } from '../../lib/consoleTokens';

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
    <div className="space-y-3">
      <div className="space-y-2.5">
        {rows.map(({ label, used, max }) => (
          <div key={label}>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-zinc-700">{label}</span>
              {isAdmin ? (
                <span className="font-mono text-zinc-500">Unlimited</span>
              ) : (
                <span className="font-mono text-zinc-900">
                  {used}
                  /
                  {max}
                </span>
              )}
            </div>
            {!isAdmin && (
              <div className="h-1.5 rounded-full bg-zinc-100 overflow-hidden">
                <div
                  className="h-full bg-black rounded-full transition-all"
                  style={{ width: `${max > 0 ? Math.min(100, (used / max) * 100) : 0}%` }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <div>
        <span className={consoleSectionLabelClass}>Resource tier</span>
        <p className="text-sm font-medium text-zinc-900 mt-1 capitalize">{q.resource_tier || 'basic'}</p>
      </div>
      {me.role !== 'admin' && me.granted_agents_count === 0 && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          No agents are assigned to your account. Ask an administrator to grant access.
        </p>
      )}
    </div>
  );
}
