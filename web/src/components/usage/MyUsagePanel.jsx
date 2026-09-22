import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { consoleSectionLabelClass, consoleCardClass } from '../../lib/consoleTokens';

import { apiFetch } from '../../lib/api';
import { formatTokens, formatTokensFull } from '../../lib/formatTokens';
import MiniBarChart, { SERIES_COLORS } from './MiniBarChart';
import { buildAgentCostChart } from './costSeries';
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

  // 日趋势两图：卡片定高、fill 模式撑满剩余高度（X 轴基线对齐且无框内留白）
  const CHART_HEIGHT = 104;

  // 费用日趋势按 agent 堆叠：Top N 各自成段，超出的合并为「其他」，
  // 保证柱高 = 当日真实合计（否则尾部 agent 费用被静默丢弃，费用预估偏低）。
  const costChart = useMemo(
    () => buildAgentCostChart(usage?.trend || [], t('observability:my_usage.cost_other')),
    [usage, t],
  );

  // 兜底：后端未返回 costByAgent（旧版服务端）时退回单一总量序列，仅展示合计
  const hasCostByAgent = (usage?.trend || []).some((d) => d.costByAgent && Object.keys(d.costByAgent).length > 0);
  const costSeries = hasCostByAgent
    ? costChart.series
    : (usage?.trend || []).some((d) => (d.costUsd || 0) > 0)
      ? [{ key: 'total', label: t('observability:my_usage.cost_total'), color: SERIES_COLORS[0] }]
      : [];
  const costData = hasCostByAgent
    ? costChart.data
    : (usage?.trend || []).map((d) => ({ label: d.day, tip: d.day, values: { total: d.costUsd || 0 } }));

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
              label={t('observability:my_usage.est_cost')}
              value={`$${Number(s.costUsd ?? 0).toFixed(2)}`}
              full={`$${Number(s.costUsd ?? 0).toFixed(4)}`}
            />
          </div>

          <div>
            <div className={`${consoleSectionLabelClass} mb-2`}>{t('observability:my_usage.trend')}</div>
            {/* 两卡同构填满框格：图例悬浮在绘图区内（legendOverlay，自动抬高量程让位），
                无独立图例行/占位带 → 柱区上下沿贴卡片，两图 X 轴基线同高。
                卡片 flex-col，MiniBarChart 区 flex-1 撑满剩余高度。 */}
            {/* 两卡定高（h-56）：fill 模式的柱区 flex-1 需要父级有确定高度才撑得开——
                此页卡片在普通文档流（无定高祖先），flex-1 会让柱区塌 0（实测图消失）。
                定高后柱区 = 卡片高 − X 行，两卡同高、X 轴基线对齐、无框内留白。 */}
            <div className="grid h-56 grid-cols-1 gap-3 lg:grid-cols-2">
              <div className={`${consoleCardClass} flex min-h-0 flex-col px-3 py-4`}>
                <MiniBarChart
                  data={(usage.trend || []).map((d) => ({
                    label: d.day,
                    tip: d.day,
                    values: { prompt: d.promptTokens || 0, completion: d.completionTokens || 0 },
                  }))}
                  height={CHART_HEIGHT}
                  showAxes
                  fill
                  legendOverlay
                  formatValue={formatTokens}
                  series={[
                    { key: 'prompt', label: t('observability:my_usage.prompt_tokens'), color: 'bg-blue-500' },
                    { key: 'completion', label: t('observability:my_usage.completion_tokens'), color: 'bg-emerald-400' },
                  ]}
                />
              </div>
              <div className={`${consoleCardClass} flex min-h-0 flex-col px-3 py-4`}>
                <MiniBarChart
                  data={costData}
                  height={CHART_HEIGHT}
                  showAxes
                  fill
                  legendOverlay
                  formatValue={(v) => `$${Number(v).toFixed(2)}`}
                  series={costSeries}
                  totalLabel={hasCostByAgent ? t('observability:my_usage.cost_total') : undefined}
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
            <div className={`${consoleSectionLabelClass} mb-2`}>{t('observability:my_usage.by_agent_breakdown')}</div>
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
                  {(usage.byAgent || []).map((a) => (
                    <tr key={a.key} className="text-zinc-600">
                      {/* agentId 为 NULL 的行 = 内置 AI 用量（服务端兜底为 '(unknown)'），
                          展示为「内置 AI」；内置 AI 的用量本就计入按项目/按 Agent 分解 */}
                      <td className="px-4 py-2.5 font-medium text-zinc-900">{a.key === '(unknown)' ? t('observability:my_usage.internal_ai') : a.key}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{a.requests}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatTokens(a.promptTokens)}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatTokens(a.completionTokens)}</td>
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
