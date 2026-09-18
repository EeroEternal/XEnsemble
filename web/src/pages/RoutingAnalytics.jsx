import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import PageHeader from '../components/PageHeader';
import SelectMenu from '../components/SelectMenu';
import { consoleCardClass } from '../lib/consoleTokens';
import { apiFetch } from '../lib/api';

// 智能路由统计（结构对齐 SmartGate AnalyticsPage）：难度评分 D ∈ [0,1]，
// D ≥ 0.55 → 高难；模型价格档按目录 USD 输出单价，达最高价 50% 记 Pro，其余 Flash。
// 数据来自 /api/v1/routing/me（self 过滤）。

const SPECTRUM = [
  { key: 'high', legendKey: 'legend_high', dotClass: 'bg-purple-600', barClass: 'bg-purple-600' },
  { key: 'mid', legendKey: 'legend_medium', dotClass: 'bg-amber-500', barClass: 'bg-amber-500' },
  { key: 'low', legendKey: 'legend_low', dotClass: 'bg-emerald-500', barClass: 'bg-emerald-500' },
];

const EMPTY_SUMMARY = {
  requests: 0,
  avgDifficulty: null,
  highDifficultyShare: null,
  estSavingsUsd: null,
  totalSpendUsd: null,
};
const EMPTY_BUCKETS = { high: 0, mid: 0, low: 0 };
const EMPTY_TIER = { pro: 0, flash: 0 };

export default function RoutingAnalytics() {
  const { t } = useTranslation();
  const [usageDays, setUsageDays] = useState('7');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/v1/routing/me?days=${usageDays}`)
      .then((res) => res.json())
      .then((d) => { if (!cancelled) setData(d?.summary != null ? d : null); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [usageDays]);

  const summary = data?.summary || EMPTY_SUMMARY;
  const buckets = data?.difficultyBuckets || EMPTY_BUCKETS;
  const tier = data?.tierRouting || EMPTY_TIER;
  const spectrumTotal = buckets.high + buckets.mid + buckets.low;

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-6">
      <PageHeader
        title={t('observability:routing.title')}
        actions={(
          <SelectMenu
            value={usageDays}
            onChange={(v) => setUsageDays(v)}
            options={[
              { value: '7', label: t('observability:my_usage.period_7d') },
              { value: '30', label: t('observability:my_usage.period_30d') },
            ]}
          />
        )}
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {/* 分析请求数（不含 sticky 沿用） */}
        <div className={`${consoleCardClass} p-4`}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('observability:routing.analyzed_queries')}</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">{loading ? '—' : summary.requests}</div>
        </div>

        {/* 复杂度分布：高 / 中 / 低 三档计数 */}
        <div className={`${consoleCardClass} p-4`}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('observability:routing.complexity_breakdown')}</div>
          <div className="mt-1 grid grid-cols-3 divide-x divide-zinc-200">
            <div className="pr-3">
              <div className="text-xl font-bold tabular-nums text-zinc-900">{loading ? '—' : buckets.high}</div>
              <div className="text-[11px] text-zinc-400">{t('observability:routing.tier_high_short')}</div>
            </div>
            <div className="px-3">
              <div className="text-xl font-bold tabular-nums text-zinc-900">{loading ? '—' : buckets.mid}</div>
              <div className="text-[11px] text-zinc-400">{t('observability:routing.tier_medium_short')}</div>
            </div>
            <div className="pl-3">
              <div className="text-xl font-bold tabular-nums text-zinc-900">{loading ? '—' : buckets.low}</div>
              <div className="text-[11px] text-zinc-400">{t('observability:routing.tier_low_short')}</div>
            </div>
          </div>
        </div>

        {/* 模型梯度路由：Pro / Flash 计数 */}
        <div className={`${consoleCardClass} p-4`}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('observability:routing.model_tier_routing')}</div>
          <div className="mt-1 grid grid-cols-2 divide-x divide-zinc-200">
            <div className="pr-3">
              <div className="text-xl font-bold tabular-nums text-zinc-900">{loading ? '—' : tier.pro}</div>
              <div className="text-[11px] text-zinc-400">{t('observability:routing.pro_model_short')}</div>
            </div>
            <div className="px-3">
              <div className="text-xl font-bold tabular-nums text-zinc-900">{loading ? '—' : tier.flash}</div>
              <div className="text-[11px] text-zinc-400">{t('observability:routing.flash_model_short')}</div>
            </div>
          </div>
        </div>

        {/* 预估节省成本 */}
        <div className={`${consoleCardClass} p-4`}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('observability:routing.estimated_savings')}</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">
            {loading ? '—' : `$${Number(summary.estSavingsUsd || 0).toFixed(2)}`}
          </div>
        </div>
      </div>

      {/* 模型改写：改写率 + 能力门槛升档 */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-900">{t('observability:routing.model_rewrite')}</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className={`${consoleCardClass} p-4`}>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('observability:routing.rewrite_rate')}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">
              {loading ? '—' : `${Math.round((summary.rewriteRate || 0) * 100)}%`}
            </div>
          </div>
          <div className={`${consoleCardClass} p-4`}>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('observability:routing.capability_upgrades')}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">{loading ? '—' : (summary.upgrades ?? 0)}</div>
          </div>
        </div>
      </div>

      {/* 复杂度光谱与信号分布：高/中/低 占比堆叠条 + 图例 */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-900">{t('observability:routing.spectrum_title')}</h2>
        <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-zinc-100">
          {SPECTRUM.map(({ key, barClass }) => {
            const n = Number(buckets[key] || 0);
            const pct = spectrumTotal > 0 ? (n / spectrumTotal) * 100 : 0;
            return n > 0 ? (
              <div key={key} className={barClass} style={{ width: `${pct}%` }} />
            ) : null;
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
          {SPECTRUM.map(({ key, legendKey, dotClass }) => {
            const n = Number(buckets[key] || 0);
            const pct = spectrumTotal > 0 ? Math.round((n / spectrumTotal) * 100) : 0;
            return (
              <span key={key} className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
                <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
                {t(`observability:routing.${legendKey}`)}
                <span className="font-mono tabular-nums">{n} ({pct}%)</span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
