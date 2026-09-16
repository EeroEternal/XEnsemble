import { useTranslation } from 'react-i18next';

import PageHeader from '../components/PageHeader';
import { consoleCardClass } from '../lib/consoleTokens';

// 静态占位页（结构对齐 SmartGate AnalyticsPage：难度评分 D ∈ [0,1]，
// D ≥ 0.55 → Pro 档，否则 Flash 档）；所有取值展示为 “—”，数据库确认
// 后在此接入真实路由数据。

const SPECTRUM_LEGEND = [
  { key: 'legend_high', dotClass: 'bg-purple-600' },
  { key: 'legend_medium', dotClass: 'bg-amber-500' },
  { key: 'legend_low', dotClass: 'bg-emerald-500' },
];

export default function RoutingAnalytics() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-6">
      <PageHeader
        title={t('observability:routing.title')}
        description={t('observability:routing.subtitle')}
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {/* 分析请求数 */}
        <div className={`${consoleCardClass} p-4`}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('observability:routing.analyzed_queries')}</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">—</div>
          <div className="mt-0.5 text-[11px] text-zinc-400">{t('observability:routing.analyzed_queries_sub')}</div>
        </div>

        {/* 复杂度分布：高 / 中 / 低 三档计数 */}
        <div className={`${consoleCardClass} p-4`}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('observability:routing.complexity_breakdown')}</div>
          <div className="mt-1 grid grid-cols-3 divide-x divide-zinc-200">
            <div className="pr-3">
              <div className="text-xl font-bold tabular-nums text-purple-700">—</div>
              <div className="text-[11px] text-zinc-400">{t('observability:routing.tier_high_short')}</div>
            </div>
            <div className="px-3">
              <div className="text-xl font-bold tabular-nums text-amber-600">—</div>
              <div className="text-[11px] text-zinc-400">{t('observability:routing.tier_medium_short')}</div>
            </div>
            <div className="pl-3">
              <div className="text-xl font-bold tabular-nums text-emerald-600">—</div>
              <div className="text-[11px] text-zinc-400">{t('observability:routing.tier_low_short')}</div>
            </div>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">{t('observability:routing.high_reasoning_sub', { pct: '—' })}</div>
        </div>

        {/* 模型梯度路由：Pro / Flash 计数 */}
        <div className={`${consoleCardClass} p-4`}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('observability:routing.model_tier_routing')}</div>
          <div className="mt-1 grid grid-cols-2 divide-x divide-zinc-200">
            <div className="pr-3">
              <div className="text-xl font-bold tabular-nums text-purple-700">—</div>
              <div className="text-[11px] text-zinc-400">{t('observability:routing.pro_model_short')}</div>
            </div>
            <div className="px-3">
              <div className="text-xl font-bold tabular-nums text-emerald-600">—</div>
              <div className="text-[11px] text-zinc-400">{t('observability:routing.flash_model_short')}</div>
            </div>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">{t('observability:routing.dynamic_dispatch')}</div>
        </div>

        {/* 预估节省成本 */}
        <div className={`${consoleCardClass} p-4`}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('observability:routing.estimated_savings')}</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-emerald-600">—</div>
          <div className="mt-0.5 text-[11px] text-zinc-400">{t('observability:routing.total_spend', { amount: '—' })}</div>
        </div>
      </div>

      {/* 复杂度光谱与信号分布：高/中/低 占比堆叠条 + 图例 */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-900">{t('observability:routing.spectrum_title')}</h2>
        <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-zinc-100" />
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
          {SPECTRUM_LEGEND.map(({ key, dotClass }) => (
            <span key={key} className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
              <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
              {t(`observability:routing.${key}`)}
              <span className="font-mono tabular-nums">— (—%)</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
