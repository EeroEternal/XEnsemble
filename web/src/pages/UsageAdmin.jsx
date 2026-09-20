import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Loader2, RefreshCw, Search } from 'lucide-react';

import PageHeader from '../components/PageHeader';
import SelectMenu from '../components/SelectMenu';
import MultiSelectMenu from '../components/MultiSelectMenu';
import UserUsageDialog from '../components/usage/UserUsageDialog';
import MiniBarChart, { SERIES_COLORS } from '../components/usage/MiniBarChart';
import { buildAgentCostChart } from '../components/usage/costSeries';
import {
  consoleAdminPageClass,
  consoleAdminTableScrollClass,
  consoleTableHeadBandClass,
  consoleAdminTableShellClass,
  consoleIconButtonClass,
  consoleTableBodyCellClass,
  consoleTableHeadCellClass,
  consoleTableHeadRowClass,
} from '../lib/consoleTokens';
import { apiFetch } from '../lib/api';
import { formatTokens, formatTokensFull } from '../lib/formatTokens';

const AVATAR_COLORS = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-violet-100 text-violet-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-cyan-100 text-cyan-700',
];

function avatarClass(userId = '') {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export default function UsageAdmin() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [days, setDays] = useState('30');
  const [overview, setOverview] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState(null);
  const [dialogUserId, setDialogUserId] = useState(null);

  const fetchData = useCallback(({ silent = false } = {}) => {
    if (!silent) setRefreshing(true);
    setLoading((prev) => (silent ? prev : true));
    return Promise.all([
      apiFetch(`/api/v1/admin/usage/overview?days=${days}`).then((r) => r.json()),
      apiFetch(`/api/v1/admin/usage/summary?days=${days}`).then((r) => r.json()),
    ])
      .then(([ov, sm]) => {
        setOverview(ov?.summary ? ov : null);
        setSummary(sm?.items ? sm : null);
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, [days]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // 深链：?user=<id> → 打开对应弹窗。清理参数时保留其余参数
  // （section 等），页面仍停留在当前观测 tab。
  useEffect(() => {
    const uid = searchParams.get('user');
    if (uid) {
      setDialogUserId(uid);
      const next = new URLSearchParams(searchParams);
      next.delete('user');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const closeUserDialog = () => {
    setDialogUserId(null);
    const next = new URLSearchParams(searchParams);
    next.delete('user');
    setSearchParams(next, { replace: true });
  };

  const items = summary?.items || [];
  const platformTotal = summary?.totalTokens ?? 0;

  // 搜索（本地过滤）；无搜索词时默认隐藏 0 用量用户，避免淹没排行榜
  const [search, setSearch] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);
  // 可选列：默认不展示，表头右上角下拉框勾选后显示
  const [extraCols, setExtraCols] = useState([]);
  const showSavings = extraCols.includes('savings');
  const showDifficulty = extraCols.includes('difficulty');
  // 用户排行列宽：可选列插在「总 Token」之后（表头带/表体两个 colgroup 共用）
  const rankCols = [
    'w-10', 'w-1/5', 'w-1/7', 'w-1/7', 'w-1/7', 'w-1/7',
    ...(showSavings ? ['w-[9%]'] : []),
    ...(showDifficulty ? ['w-[8%]'] : []),
    'w-1/7', 'w-1/6', 'w-12',
  ];
  const q = search.trim().toLowerCase();
  const matched = useMemo(() => {
    if (!q) return items;
    return items.filter((u) =>
      (u.username || '').toLowerCase().includes(q)
      || (u.displayName || '').toLowerCase().includes(q));
  }, [items, q]);
  const visibleRows = useMemo(
    () => (q || showEmpty ? matched : matched.filter((u) => u.requests > 0 || u.totalTokens > 0)),
    [matched, q, showEmpty],
  );
  const hiddenEmptyCount = matched.length - visibleRows.length;
  const emptyCount = useMemo(
    () => items.filter((u) => u.requests === 0 && u.totalTokens === 0).length,
    [items],
  );

  const trendData = useMemo(
    () => (overview?.trend || []).map((d) => ({
      label: d.day,
      tip: d.day,
      values: { prompt: d.promptTokens || 0, completion: d.completionTokens || 0 },
    })),
    [overview],
  );

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

  const toggleExpand = (userId) => setExpandedUserId((prev) => (prev === userId ? null : userId));

  return (
    <div className={consoleAdminPageClass}>
      <PageHeader
        title={t('users:usage.title')}
        actions={(
          <div className="flex items-center gap-2">
            <SelectMenu
              value={days}
              onChange={(v) => setDays(v)}
              options={[
                { value: '7', label: t('users:usage.period_7d') },
                { value: '30', label: t('users:usage.period_30d') },
                { value: '90', label: t('users:usage.period_90d') },
              ]}
            />
            <button
              type="button"
              onClick={() => fetchData()}
              disabled={refreshing}
              className={consoleIconButtonClass}
              title={t('common:action.refresh')}
            >
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          </div>
        )}
      />

      {loading && !overview ? (
        <div className="flex items-center justify-center py-16 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <>
          {/* 概览卡 */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label={t('users:usage.total_tokens')} value={formatTokens(overview?.summary?.totalTokens)} full={formatTokensFull(overview?.summary?.totalTokens || 0)} />
            <StatCard label={t('users:usage.requests')} value={formatTokens(overview?.summary?.requests)} full={formatTokensFull(overview?.summary?.requests || 0)} />
            <StatCard
              label={t('users:usage.active_users')}
              value={`${overview?.summary?.activeUsers ?? 0}`}
            />
            <StatCard
              label={t('users:usage.tokens_per_user')}
              value={formatTokens(
                overview?.summary?.activeUsers > 0
                  ? Math.round(overview.summary.totalTokens / overview.summary.activeUsers)
                  : 0,
              )}
            />
          </div>

          {/* 平台日趋势：左 Token（输入/输出两段）/ 右 费用（按 agent 堆叠） */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{t('users:usage.trend')}</h2>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-zinc-200 bg-surface px-3 py-4">
                <div className="mb-2 flex items-center gap-3">
                  <span className="flex items-center gap-1 text-[11px] text-zinc-400">
                    <span className="inline-block h-1.5 w-1.5 rounded-sm bg-blue-500" /> {t('users:usage.prompt')}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-zinc-400">
                    <span className="inline-block h-1.5 w-1.5 rounded-sm bg-emerald-400" /> {t('users:usage.completion')}
                  </span>
                </div>
                <MiniBarChart
                  data={trendData}
                  height={104}
                  showAxes
                  formatValue={formatTokens}
                  series={[
                    { key: 'prompt', label: t('users:usage.prompt'), color: 'bg-blue-500' },
                    { key: 'completion', label: t('users:usage.completion'), color: 'bg-emerald-400' },
                  ]}
                />
              </div>
              <div className="rounded-lg border border-zinc-200 bg-surface px-3 py-4">
                {costSeries.length > 0 && (
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {costSeries.map((s) => (
                      <span key={s.key} className="flex items-center gap-1 text-[11px] text-zinc-400">
                        <span className={`inline-block h-1.5 w-1.5 rounded-sm ${s.color}`} /> {s.label}
                      </span>
                    ))}
                  </div>
                )}
                <MiniBarChart
                  data={costData}
                  height={104}
                  showAxes
                  formatValue={(v) => `$${Number(v).toFixed(2)}`}
                  series={costSeries}
                  totalLabel={hasCostByAgent ? t('users:usage.cost_total') : undefined}
                />
              </div>
            </div>
          </section>

          {/* 用户排行 */}
          <section className="flex min-h-48 flex-1 flex-col">
            <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{t('users:usage.ranking')}</h2>
              <div className="relative w-56">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('users:search_placeholder')}
                  className="h-8 w-full rounded-md border border-zinc-200 bg-surface pl-8 pr-2 text-xs text-zinc-700 placeholder:text-zinc-400 outline-none focus:border-zinc-400"
                />
              </div>
            </div>
            <div className={consoleAdminTableShellClass}>
              <div className={consoleTableHeadBandClass}>
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <colgroup>
                    {rankCols.map((c, i) => (
                      <col key={i} className={c} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className={consoleTableHeadRowClass}>
                      <th className={consoleTableHeadCellClass}>#</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.user')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.requests')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.prompt')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.completion')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.total_tokens')}</th>
                      {showSavings && <th className={consoleTableHeadCellClass}>{t('users:usage.est_savings')}</th>}
                      {showDifficulty && <th className={consoleTableHeadCellClass}>{t('users:usage.avg_difficulty')}</th>}
                      <th className={consoleTableHeadCellClass}>{t('users:usage.cache_hit_rate')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.share')}</th>
                      <th className={`${consoleTableHeadCellClass} pr-2`}>
                        <div className="flex justify-end">
                          <MultiSelectMenu
                            value={extraCols}
                            onChange={setExtraCols}
                            options={[
                              { value: 'savings', label: t('users:usage.est_savings') },
                              { value: 'difficulty', label: t('users:usage.avg_difficulty') },
                            ]}
                            placeholder={t('users:usage.extra_columns')}
                            hideSummary
                            className="flex justify-end"
                          />
                        </div>
                      </th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div className={consoleAdminTableScrollClass}>
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <colgroup>
                    {rankCols.map((c, i) => (
                      <col key={i} className={c} />
                    ))}
                  </colgroup>
                  <tbody className="divide-y divide-zinc-100">
                    {visibleRows.length === 0 ? (
                      <tr>
                        <td colSpan={9 + extraCols.length} className={`${consoleTableBodyCellClass} text-center text-zinc-400`}>
                          {q ? t('users:empty.no_match', { defaultValue: 'No users match your search.' }) : t('users:usage.no_data')}
                        </td>
                      </tr>
                    ) : visibleRows.map((u) => {
                      const share = platformTotal > 0 ? Math.round((u.totalTokens / platformTotal) * 100) : 0;
                      const expanded = expandedUserId === u.userId;
                      return (
                        <Row
                          key={u.userId}
                          user={u}
                          idx={items.indexOf(u)}
                          share={share}
                          expanded={expanded}
                          expandable={u.requests > 0 || u.totalTokens > 0}
                          showSavings={showSavings}
                          showDifficulty={showDifficulty}
                          onToggle={() => toggleExpand(u.userId)}
                          onOpenDialog={() => setDialogUserId(u.userId)}
                          t={t}
                        />
                      );
                    })}
                    {!q && !showEmpty && emptyCount > 0 && hiddenEmptyCount > 0 && (
                      <tr
                        className="cursor-pointer transition-colors hover:bg-zinc-50"
                        onClick={() => setShowEmpty(true)}
                      >
                        <td colSpan={9 + extraCols.length} className="px-4 py-2.5 text-center text-[11px] text-zinc-400">
                          <span className="mr-1 inline-flex items-center justify-center align-[-2px]">
                            <ChevronDown className="h-3 w-3" />
                          </span>
                          {t('users:usage.show_empty_users', { count: hiddenEmptyCount })}
                        </td>
                      </tr>
                    )}
                    {!q && showEmpty && emptyCount > 0 && (
                      <tr
                        className="cursor-pointer transition-colors hover:bg-zinc-50"
                        onClick={() => setShowEmpty(false)}
                      >
                        <td colSpan={9 + extraCols.length} className="px-4 py-2.5 text-center text-[11px] text-zinc-400">
                          <span className="mr-1 inline-flex items-center justify-center align-[-2px]">
                            <ChevronUp className="h-3 w-3" />
                          </span>
                          {t('users:usage.hide_empty_users')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* Agent 分布（含缓存命中率）：与上方用户排行等权重平分剩余高度，
              行数多时在表体滚动，避免 agent 表挤占排行表空间 */}
          <section className="flex min-h-48 flex-1 flex-col">
            <h2 className="mb-2 shrink-0 text-xs font-semibold uppercase tracking-wider text-zinc-500">{t('users:usage.by_agent')}</h2>
            <div className={consoleAdminTableShellClass}>
              <div className={consoleTableHeadBandClass}>
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <colgroup>
                    <col className="w-1/6" />
                    <col className="w-1/6" />
                    <col className="w-1/6" />
                    <col className="w-1/6" />
                    <col className="w-1/6" />
                    <col className="w-1/6" />
                  </colgroup>
                  <thead>
                    <tr className={consoleTableHeadRowClass}>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.agent')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.requests')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.prompt')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.cached_tokens')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.cache_hit_rate')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.total_tokens')}</th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div className={consoleAdminTableScrollClass}>
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <colgroup>
                    <col className="w-1/6" />
                    <col className="w-1/6" />
                    <col className="w-1/6" />
                    <col className="w-1/6" />
                    <col className="w-1/6" />
                    <col className="w-1/6" />
                  </colgroup>
                  <tbody className="divide-y divide-zinc-100">
                    {(overview?.byAgent || []).length === 0 ? (
                      <tr>
                        <td colSpan={6} className={`${consoleTableBodyCellClass} text-center text-zinc-400`}>
                          {t('users:usage.no_data')}
                        </td>
                      </tr>
                    ) : (overview?.byAgent || []).map((a) => (
                      <tr key={a.key} className="transition-colors hover:bg-zinc-50/70">
                        <td className={`${consoleTableBodyCellClass} font-medium text-zinc-700`}>{a.key}</td>
                        <td className={consoleTableBodyCellClass}>{formatTokens(a.requests)}</td>
                        <td className={consoleTableBodyCellClass}>{formatTokens(a.promptTokens)}</td>
                        <td className={consoleTableBodyCellClass}>{a.cachedTokens > 0 ? formatTokens(a.cachedTokens) : '—'}</td>
                        <td className={consoleTableBodyCellClass}>{a.cacheHitRate != null ? `${Math.round(a.cacheHitRate * 100)}%` : '—'}</td>
                        <td className={consoleTableBodyCellClass}>{formatTokens(a.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}

      {dialogUserId && (
        <UserUsageDialog userId={dialogUserId} days={Number(days)} onClose={closeUserDialog} />
      )}
    </div>
  );
}

function Row({ user, idx, share, expanded, expandable, showSavings, showDifficulty, onToggle, onOpenDialog, t }) {
  return (
    <>
      <tr
        className={`transition-colors ${expandable ? 'cursor-pointer hover:bg-zinc-50/70' : ''} ${expanded ? 'bg-zinc-50' : ''}`}
        onClick={expandable ? onToggle : undefined}
      >
        <td className={consoleTableBodyCellClass}>
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-zinc-100 text-[11px] font-semibold text-zinc-500">
            {idx + 1}
          </span>
        </td>
        <td className={consoleTableBodyCellClass}>
          <div className="flex items-center gap-2">
            <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${avatarClass(user.userId)}`}>
              {(user.username || '?').slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="truncate font-medium text-zinc-900">{user.username}</div>
              {user.displayName ? <div className="truncate text-xs text-zinc-400">{user.displayName}</div> : null}
            </div>
          </div>
        </td>
        <td className={`${consoleTableBodyCellClass} font-mono tabular-nums`}>{formatTokensFull(user.requests)}</td>
        <td className={`${consoleTableBodyCellClass} font-mono tabular-nums text-zinc-500`}>{formatTokens(user.promptTokens)}</td>
        <td className={`${consoleTableBodyCellClass} font-mono tabular-nums text-zinc-500`}>{formatTokens(user.completionTokens)}</td>
        <td className={`${consoleTableBodyCellClass} font-mono font-semibold tabular-nums text-zinc-900`}>
          {formatTokens(user.totalTokens)}
        </td>
        {showSavings && (
          <td className={`${consoleTableBodyCellClass} font-mono tabular-nums text-emerald-600`}>
            {user.estSavingsUsd != null ? `$${Number(user.estSavingsUsd).toFixed(2)}` : '—'}
          </td>
        )}
        {showDifficulty && (
          <td className={`${consoleTableBodyCellClass} font-mono tabular-nums`}>
            {user.avgDifficulty != null ? Number(user.avgDifficulty).toFixed(2) : '—'}
          </td>
        )}
        <td className={`${consoleTableBodyCellClass} font-mono tabular-nums text-zinc-500`}>
          {user.cacheHitRate != null ? `${Math.round(user.cacheHitRate * 100)}%` : '—'}
        </td>
        <td className={consoleTableBodyCellClass}>
          {share > 0 ? (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-100">
                <div className="h-full rounded-full bg-zinc-800" style={{ width: `${Math.min(100, share)}%` }} />
              </div>
              <span className="text-[11px] tabular-nums text-zinc-400">{share}%</span>
            </div>
          ) : (
            <span className="text-[11px] tabular-nums text-zinc-300">0%</span>
          )}
        </td>
        <td className={`${consoleTableBodyCellClass} pr-3 text-right`}>
            {expandable
              ? (expanded
                  ? <ChevronUp className="ml-auto h-3.5 w-3.5 text-zinc-400" />
                  : <ChevronDown className="ml-auto h-3.5 w-3.5 text-zinc-400" />)
              : null}
          </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={9 + (showSavings ? 1 : 0) + (showDifficulty ? 1 : 0)} className="bg-zinc-50/60 px-4 py-4" onClick={(e) => e.stopPropagation()}>
            <ExpandedDetail userId={user.userId} days={30} onOpenDialog={onOpenDialog} t={t} />
          </td>
        </tr>
      )}
    </>
  );
}

/** 行内展开：懒加载该用户的模型/项目分布（轻量视图） */
function ExpandedDetail({ userId, days, onOpenDialog, t }) {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/v1/admin/usage/users/${userId}?days=${days}`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled && data?.summary) setDetail(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [userId, days]);

  const byProject = (detail?.byProject || []).map((r) => ({
    key: r.projectName || t('users:usage.deleted_project', { defaultValue: 'Deleted workspace' }),
    totalTokens: r.totalTokens,
    requests: r.requests,
  }));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="rounded-lg border border-zinc-200 bg-surface p-3.5">
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('users:usage.by_model')}</p>
        <MiniList items={detail?.byModel} t={t} />
      </div>
      <div className="rounded-lg border border-zinc-200 bg-surface p-3.5">
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{t('users:usage.by_project')}</p>
        <MiniList items={byProject} t={t} />
      </div>
      <div>
        <button
          type="button"
          onClick={onOpenDialog}
          className="text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline"
        >
          {t('users:usage.view_detail')} →
        </button>
      </div>
    </div>
  );
}

function MiniList({ items, t }) {
  if (!items) {
    return <div className="flex justify-center py-3 text-zinc-300"><Loader2 className="h-4 w-4 animate-spin" /></div>;
  }
  if (!items.length) {
    return <p className="py-2 text-xs text-zinc-400">{t('users:usage.no_data')}</p>;
  }
  const max = Math.max(...items.map((i) => i.totalTokens || 0), 1);
  return (
    <div className="space-y-1.5">
      {items.map((item) => (
        <div key={item.key} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2.5">
          <span className="truncate text-xs text-zinc-600" title={item.key}>{item.key}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100">
            <div className="h-full rounded-full bg-zinc-800" style={{ width: `${((item.totalTokens || 0) / max) * 100}%` }} />
          </div>
          <span className="font-mono text-[11px] tabular-nums text-zinc-500">{formatTokens(item.totalTokens)}</span>
        </div>
      ))}
    </div>
  );
}

function StatCard({ label, value, full }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-surface p-4" title={full}>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">{value}</div>
    </div>
  );
}
