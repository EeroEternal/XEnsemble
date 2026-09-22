import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import PageHeader from '../components/PageHeader';
import UsagePeriodActions from '../components/usage/UsagePeriodActions';
import MiniBarChart, { SERIES_COLORS } from '../components/usage/MiniBarChart';
import { buildAgentCostChart } from '../components/usage/costSeries';
import { useUsageOverview } from '../components/usage/useUsageOverview';
import {
  consoleAdminPageClass,
  consoleAdminTableScrollClass,
  consoleTableHeadBandClass,
  consoleAdminTableShellClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableHeadRowClass,
} from '../lib/consoleTokens';
import { formatTokens } from '../lib/formatTokens';

// Agent 表与模型表共用同一套 6 列等宽（表头带/表体两个 colgroup 共用，须逐字一致）：
// 两表列宽完全一致，视觉上齐平。
const TABLE_COLS = ['w-1/6', 'w-1/6', 'w-1/6', 'w-1/6', 'w-1/6', 'w-1/6'];

// 顶部两张图同排并排、完全同构：同高（CHART_HEIGHT）、同 Y 轴宽（Y_AXIS_WIDTH）、
// 卡片内均无独立图例行（费用图的图例由 legendOverlay 悬浮在绘图区右上角内侧）。
// → 两图绘图区上下沿、左右边界全部对齐，且卡片顶部无空白带。
const CHART_HEIGHT = 104;
const Y_AXIS_WIDTH = 'w-8';

/** 百万 Token 均价：低价模型（< $1）需要更多小数位才不显示成 $0.00。 */
function formatPerMillion(v) {
  if (v == null) return '—';
  const n = Number(v);
  return `$${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;
}

/** 智能体与模型：按 Agent 堆叠的费用日趋势 + Agent 使用量表 + 模型百万 Token 均价 + 模型使用量。
 *  用户维度（概览卡 / Token 趋势 / 用户排行）在「用户统计」页。 */
export default function AgentsModelsAdmin() {
  const { t } = useTranslation();

  const { days, setDays, overview, loading, refreshing, refresh } = useUsageOverview();

  // 费用日趋势按 agent 堆叠：Top N 各自成段，超出的合并为「其他」，
  // 保证柱高 = 当日真实合计（否则尾部 agent 费用被静默丢弃，费用预估偏低）。
  const costChart = useMemo(
    () => buildAgentCostChart(overview?.trend || [], t('users:usage.cost_other')),
    [overview, t],
  );

  // 兜底：后端未返回 costByAgent（旧版服务端）时退回单一总量序列，仅展示合计
  const hasCostByAgent = (overview?.trend || []).some((d) => d.costByAgent && Object.keys(d.costByAgent).length > 0);
  const costSeries = hasCostByAgent
    ? costChart.series
    : (overview?.trend || []).some((d) => (d.costUsd || 0) > 0)
      ? [{ key: 'total', label: t('users:usage.cost_total'), color: SERIES_COLORS[0] }]
      : [];
  const costData = hasCostByAgent
    ? costChart.data
    : (overview?.trend || []).map((d) => ({ label: d.day, tip: d.day, values: { total: d.costUsd || 0 } }));

  const byAgent = overview?.byAgent || [];

  // 模型：后端 byModel 已按总 token 降序。均价图只取目录里查得到单价的模型——
  // 无单价的模型画成 0 会误导（看起来"免费"），因此排除（表格里仍有该行，费用/均价显示 —）。
  const byModel = overview?.byModel || [];
  const TOP_MODELS = 10;
  const topPricedModels = useMemo(
    () => byModel.filter((m) => m.avgCostPerMillion != null).slice(0, TOP_MODELS),
    [byModel],
  );
  const perMillionData = useMemo(
    () => topPricedModels.map((m) => ({
      label: m.key,
      tip: m.key,
      values: { avg: m.avgCostPerMillion },
    })),
    [topPricedModels],
  );

  return (
    <div className={consoleAdminPageClass}>
      <PageHeader
        title={t('observability:tabs.agents_models')}
        actions={(
          <UsagePeriodActions
            days={days}
            onDaysChange={setDays}
            refreshing={refreshing}
            onRefresh={() => refresh()}
          />
        )}
      />

      {loading && !overview ? (
        <div className="flex flex-1 items-center justify-center text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        // 单页布局：顶部两张图左右并排且高度固定，下方两张表各占等分剩余空间。
        // 全部门为 flex 子项且 min-h-0，超出部分在**表格内部**滚动，
        // 页面本身不产生纵向溢出（不出现页面级滚动条）。
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {/* 第一排：费用日趋势（左） | 百万 Token 均价（右） */}
          <div className="grid shrink-0 grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="flex min-h-0 flex-col">
              <h2 className="mb-2 shrink-0 text-xs font-semibold uppercase tracking-wider text-zinc-500">{t('users:usage.cost_trend')}</h2>
              <div className="flex flex-1 flex-col rounded-lg border border-zinc-200 bg-surface px-3 py-3">
                <MiniBarChart
                  data={costData}
                  height={CHART_HEIGHT}
                  yAxisWidth={Y_AXIS_WIDTH}
                  showAxes
                  formatValue={(v) => `$${Number(v).toFixed(2)}`}
                  series={costSeries}
                  totalLabel={hasCostByAgent ? t('users:usage.cost_total') : undefined}
                  // 图例悬浮在绘图区右上角内测：稍低于纵轴顶端刻度、位于纵轴右侧，
                  // 不占独立布局行 → 卡片内无顶部空白带，费用/均价两图顶部对齐。
                  legendOverlay
                />
              </div>
            </section>

            <section className="flex min-h-0 flex-col">
              <h2 className="mb-2 shrink-0 text-xs font-semibold uppercase tracking-wider text-zinc-500">{t('users:usage.avg_cost_per_million')}</h2>
              <div className="flex flex-1 flex-col rounded-lg border border-zinc-200 bg-surface px-3 py-3">
                <MiniBarChart
                  data={perMillionData}
                  height={CHART_HEIGHT}
                  yAxisWidth={Y_AXIS_WIDTH}
                  showAxes
                  formatValue={formatPerMillion}
                  series={[{ key: 'avg', label: t('users:usage.avg_cost_per_million'), color: SERIES_COLORS[0] }]}
                />
              </div>
            </section>
          </div>

          {/* Agent 用量：与下方模型表等分剩余高度（两者 flex 设置一致，高度严格相等） */}
          <section className="flex min-h-0 flex-1 basis-0 flex-col">
            <h2 className="mb-2 shrink-0 text-xs font-semibold uppercase tracking-wider text-zinc-500">{t('users:usage.by_agent')}</h2>
            <div className={consoleAdminTableShellClass}>
              <div className={consoleTableHeadBandClass}>
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <colgroup>
                    {TABLE_COLS.map((c, i) => (
                      <col key={i} className={c} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className={consoleTableHeadRowClass}>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.agent')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.requests')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.prompt')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.completion')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.cache_hit_rate')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.total_tokens')}</th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div className={consoleAdminTableScrollClass}>
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <colgroup>
                    {TABLE_COLS.map((c, i) => (
                      <col key={i} className={c} />
                    ))}
                  </colgroup>
                  <tbody className="divide-y divide-zinc-100">
                    {byAgent.length === 0 ? (
                      <tr>
                        <td colSpan={6} className={`${consoleTableBodyCellClass} text-center text-zinc-400`}>
                          {t('users:usage.no_data')}
                        </td>
                      </tr>
                    ) : byAgent.map((a) => (
                      <tr key={a.key} className="transition-colors hover:bg-zinc-50/70">
                        {/* 与模型表同处理：超长 agent 名截断 + 悬停看全名 */}
                        <td className={`${consoleTableBodyCellClass} font-medium text-zinc-700`} title={a.key}>
                          <div className="truncate">{a.key}</div>
                        </td>
                        <td className={consoleTableBodyCellClass}>{formatTokens(a.requests)}</td>
                        <td className={consoleTableBodyCellClass}>{formatTokens(a.promptTokens)}</td>
                        <td className={consoleTableBodyCellClass}>{formatTokens(a.completionTokens)}</td>
                        <td className={consoleTableBodyCellClass}>{a.cacheHitRate != null ? `${Math.round(a.cacheHitRate * 100)}%` : '—'}</td>
                        <td className={consoleTableBodyCellClass}>{formatTokens(a.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* 模型用量：flex 设置与上方 agent 表逐字一致 → 高度相等 */}
          <section className="flex min-h-0 flex-1 basis-0 flex-col">
            <h2 className="mb-2 shrink-0 text-xs font-semibold uppercase tracking-wider text-zinc-500">{t('users:usage.model_usage')}</h2>
            <div className={consoleAdminTableShellClass}>
              <div className={consoleTableHeadBandClass}>
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <colgroup>
                    {TABLE_COLS.map((c, i) => (
                      <col key={i} className={c} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className={consoleTableHeadRowClass}>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.model')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.requests')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.prompt')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.completion')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.cache_hit_rate')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.total_tokens')}</th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div className={consoleAdminTableScrollClass}>
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <colgroup>
                    {TABLE_COLS.map((c, i) => (
                      <col key={i} className={c} />
                    ))}
                  </colgroup>
                  <tbody className="divide-y divide-zinc-100">
                    {byModel.length === 0 ? (
                      <tr>
                        <td colSpan={TABLE_COLS.length} className={`${consoleTableBodyCellClass} text-center text-zinc-400`}>
                          {t('users:usage.no_data')}
                        </td>
                      </tr>
                    ) : byModel.map((m) => (
                      <tr key={m.key} className="transition-colors hover:bg-zinc-50/70">
                        {/* 模型名可能超长（如 gateway 前缀的完整 id）：列宽由 table-fixed 固定，
                            inner div truncate 出省略号，title 悬停展示全名 */}
                        <td className={`${consoleTableBodyCellClass} font-medium text-zinc-700`} title={m.key}>
                          <div className="truncate">{m.key}</div>
                        </td>
                        <td className={consoleTableBodyCellClass}>{formatTokens(m.requests)}</td>
                        <td className={consoleTableBodyCellClass}>{formatTokens(m.promptTokens)}</td>
                        <td className={consoleTableBodyCellClass}>{formatTokens(m.completionTokens)}</td>
                        <td className={consoleTableBodyCellClass}>{m.cacheHitRate != null ? `${Math.round(m.cacheHitRate * 100)}%` : '—'}</td>
                        <td className={consoleTableBodyCellClass}>{formatTokens(m.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
