import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { consoleSectionLabelClass, consoleCardClass } from '../../lib/consoleTokens';

import { apiFetch } from '../../lib/api';
import { formatTokens, formatTokensFull } from '../../lib/formatTokens';
import MiniBarChart from './MiniBarChart';
import SelectMenu from '../SelectMenu';

/** 个人 LLM Token 用量：汇总 / 日趋势 / 按项目分解 / 按 Agent。无配额上限，独立于配额页。 */
export default function MyUsagePanel() {
  const { t } = useTranslation();
  const [usageDays, setUsageDays] = useState('7');
  const [usage, setUsage] = useState(null);
  const [usageLoading, setUsageLoading] = useState(true);

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

  const s = usage?.summary;
  const prevTotal = usage?.prevTotalTokens ?? 0;
  const deltaPct = s && prevTotal > 0 ? Math.round(((s.totalTokens - prevTotal) / prevTotal) * 100) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className={consoleSectionLabelClass}>{t('observability:my_usage.title')}</div>
        <SelectMenu
          value={usageDays}
          onChange={(v) => setUsageDays(v)}
          options={[
            { value: '7', label: t('observability:my_usage.period_7d') },
            { value: '30', label: t('observability:my_usage.period_30d') },
          ]}
        />
      </div>

      {usageLoading ? (
        <div className={`${consoleCardClass} p-6 text-center text-sm text-zinc-400`}>{t('common:state.loading')}</div>
      ) : !s || s.requests === 0 ? (
        <div className={`${consoleCardClass} p-6 text-center text-sm text-zinc-400`}>{t('observability:my_usage.no_data')}</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <UsageStatCard
              label={t('observability:my_usage.total_tokens')}
              value={formatTokens(s.totalTokens)}
              full={formatTokensFull(s.totalTokens)}
              deltaPct={deltaPct}
              deltaText={deltaPct != null
                ? t('observability:my_usage.vs_prev', { pct: Math.abs(deltaPct) })
                : null}
            />
            <UsageStatCard
              label={t('observability:my_usage.requests')}
              value={formatTokens(s.requests)}
              full={formatTokensFull(s.requests)}
            />
            <UsageStatCard
              label={t('observability:my_usage.completion_tokens')}
              value={formatTokens(s.completionTokens)}
              full={formatTokensFull(s.completionTokens)}
            />
          </div>

          <div>
            <div className={`${consoleSectionLabelClass} mb-2`}>{t('observability:my_usage.trend')}</div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className={`${consoleCardClass} px-3 py-4`}>
                <MiniBarChart
                  data={(usage.trend || []).map((d) => ({
                    label: d.day,
                    tip: d.day,
                    primary: d.promptTokens || 0,
                    secondary: d.completionTokens || 0,
                  }))}
                  height={80}
                  showAxes
                  formatValue={formatTokens}
                />
              </div>
              <div className={`${consoleCardClass} px-3 py-4`}>
                <MiniBarChart
                  data={(usage.trend || []).map((d) => ({ label: d.day, tip: d.day, primary: d.costUsd || 0 }))}
                  height={80}
                  showAxes
                  formatValue={(v) => `$${Number(v).toFixed(2)}`}
                  primaryLabel={t('observability:my_usage.cost_trend')}
                />
              </div>
            </div>
          </div>

          <div>
            <div className={`${consoleSectionLabelClass} mb-2`}>{t('observability:my_usage.by_project')}</div>
            <div className={`${consoleCardClass} overflow-hidden`}>
              <div className="shrink-0 overflow-x-hidden overflow-y-auto">
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-400">
                    <th className="px-4 py-2 font-medium">{t('observability:my_usage.project')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('observability:my_usage.requests')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('observability:my_usage.prompt_tokens')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('observability:my_usage.completion_tokens')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('observability:my_usage.cache_hit_rate')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('observability:my_usage.total_tokens')}</th>
                  </tr>
                </thead>
              </table>
              </div>
              <div className="max-h-64 overflow-y-auto overflow-x-hidden console-scroll-hidden">
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                </colgroup>
                <tbody className="divide-y divide-zinc-100">
                  {(usage.byProject || []).map((p) => (
                    <tr key={p.projectId ?? 'deleted'} className="text-zinc-600">
                      <td className="max-w-40 truncate px-4 py-2.5">
                        {p.projectName || t('observability:my_usage.deleted_project')}
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
          </div>

          <div>
            <div className={`${consoleSectionLabelClass} mb-2`}>{t('observability:my_usage.by_agent')}</div>
            <div className={`${consoleCardClass} overflow-hidden`}>
              <div className="shrink-0 overflow-x-hidden overflow-y-auto">
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-400">
                    <th className="px-4 py-2 font-medium">{t('observability:my_usage.agent')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('observability:my_usage.requests')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('observability:my_usage.prompt_tokens')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('observability:my_usage.cached_tokens')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('observability:my_usage.cache_hit_rate')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('observability:my_usage.total_tokens')}</th>
                  </tr>
                </thead>
              </table>
              </div>
              <div className="max-h-64 overflow-y-auto overflow-x-hidden console-scroll-hidden">
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                </colgroup>
                <tbody className="divide-y divide-zinc-100">
                  {(usage.byAgent || []).map((a) => (
                    <tr key={a.key} className="text-zinc-600">
                      <td className="px-4 py-2.5 font-medium text-zinc-900">{a.key}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{a.requests}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatTokens(a.promptTokens)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatTokens(a.cachedTokens)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                        {a.cacheHitRate != null ? `${Math.round(a.cacheHitRate * 100)}%` : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums text-zinc-900">
                        {formatTokens(a.totalTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
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
