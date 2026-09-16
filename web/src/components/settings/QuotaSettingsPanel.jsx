import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { consoleSectionLabelClass, consoleCardClass } from '../../lib/consoleTokens';

import { apiFetch } from '../../lib/api';
import { formatTokens, formatTokensFull } from '../../lib/formatTokens';
import MiniBarChart from '../usage/MiniBarChart';
import SelectMenu from '../SelectMenu';

export default function QuotaSettingsPanel() {
  const { t } = useTranslation();
  const [me, setMe] = useState(null);
  const [meLoading, setMeLoading] = useState(true);
  const [usageDays, setUsageDays] = useState('7');
  const [usage, setUsage] = useState(null);
  const [usageLoading, setUsageLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/v1/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) {
          // 非 200 / 空体 / 缺 quotas（如预览后端与令牌用户不一致）都视为
          // 加载失败，展示失败态而不是永久停在 loading。
          setMe(data && data.quotas ? data : null);
          setMeLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setMeLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setUsageLoading(true);
    apiFetch(`/api/v1/usage/me?days=${usageDays}`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setUsage(data?.summary != null ? data : null); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setUsageLoading(false); });
    return () => { cancelled = true; };
  }, [usageDays]);

  if (meLoading) {
    return <p className="text-sm text-zinc-400">{t('settings:quota.loading')}</p>;
  }
  if (!me?.quotas) {
    return <p className="text-sm text-zinc-400">{t('settings:quota.load_failed')}</p>;
  }

  const q = me.quotas;
  const u = q.usage || {};
  const isAdmin = me.role === 'admin';

  const rows = [
    { label: t('settings:quota.projects'), used: u.projects ?? 0, max: q.max_projects },
    { label: t('settings:quota.sessions'), used: u.sessions ?? 0, max: q.max_sessions },
    { label: t('settings:quota.previews'), used: u.previews ?? 0, max: q.max_previews },
  ];

  const s = usage?.summary;
  const prevTotal = usage?.prevTotalTokens ?? 0;
  const deltaPct = s && prevTotal > 0 ? Math.round(((s.totalTokens - prevTotal) / prevTotal) * 100) : null;

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

      {/* Token 用量（LLM Proxy 自动计量） */}
      <div className="flex items-center justify-between pt-2">
        <div className={consoleSectionLabelClass}>{t('settings:usage.title')}</div>
        <SelectMenu
          value={usageDays}
          onChange={(v) => setUsageDays(v)}
          options={[
            { value: '7', label: t('settings:usage.period_7d') },
            { value: '30', label: t('settings:usage.period_30d') },
          ]}
        />
      </div>

      {usageLoading ? (
        <div className={`${consoleCardClass} p-6 text-center text-sm text-zinc-400`}>{t('common:state.loading')}</div>
      ) : !s || s.requests === 0 ? (
        <div className={`${consoleCardClass} p-6 text-center text-sm text-zinc-400`}>{t('settings:usage.no_data')}</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <UsageStatCard
              label={t('settings:usage.total_tokens')}
              value={formatTokens(s.totalTokens)}
              full={formatTokensFull(s.totalTokens)}
              deltaPct={deltaPct}
              deltaText={deltaPct != null
                ? t('settings:usage.vs_prev', { pct: Math.abs(deltaPct) })
                : null}
            />
            <UsageStatCard
              label={t('settings:usage.requests')}
              value={formatTokens(s.requests)}
              full={formatTokensFull(s.requests)}
            />
            <UsageStatCard
              label={t('settings:usage.completion_tokens')}
              value={formatTokens(s.completionTokens)}
              full={formatTokensFull(s.completionTokens)}
            />
          </div>

          <div>
            <div className={`${consoleSectionLabelClass} mb-2`}>{t('settings:usage.trend')}</div>
            <div className={`${consoleCardClass} px-3 py-4`}>
              <MiniBarChart
                data={(usage.trend || []).map((d) => ({
                  label: d.day,
                  tip: d.day,
                  primary: d.promptTokens || 0,
                  secondary: d.completionTokens || 0,
                }))}
                height={80}
              />
            </div>
          </div>

          <div>
            <div className={`${consoleSectionLabelClass} mb-2`}>{t('settings:usage.by_project')}</div>
            <div className={`${consoleCardClass} max-h-64 overflow-y-auto overflow-x-hidden console-scroll-hidden`}>
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wide text-zinc-400">
                    <th className="px-4 py-2 font-medium">{t('settings:usage.project')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('settings:usage.requests')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('settings:usage.prompt_tokens')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('settings:usage.completion_tokens')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('settings:usage.cache_hit_rate')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('settings:usage.total_tokens')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {(usage.byProject || []).map((p) => (
                    <tr key={p.projectId ?? 'deleted'} className="text-zinc-600">
                      <td className="max-w-40 truncate px-4 py-2.5">
                        {p.projectName || t('settings:usage.deleted_project')}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{p.requests}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatTokens(p.promptTokens)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatTokens(p.completionTokens)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                        {p.cacheHitRate != null ? `${Math.round(p.cacheHitRate * 100)}%` : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums text-zinc-900">
                        {formatTokens(p.totalTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function UsageStatCard({ label, value, full, deltaPct, deltaText }) {
  return (
    <div className={`${consoleCardClass} p-4`} title={full}>
      <div className={consoleSectionLabelClass}>{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">{value}</div>
      {deltaPct != null && deltaText ? (
        <div className={`mt-0.5 text-[11px] ${deltaPct >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
          {deltaPct >= 0 ? '↑' : '↓'} {deltaText}
        </div>
      ) : null}
    </div>
  );
}
