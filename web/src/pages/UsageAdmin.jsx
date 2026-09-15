import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Loader2, RefreshCw, Search } from 'lucide-react';

import PageHeader from '../components/PageHeader';
import SelectMenu from '../components/SelectMenu';
import UserUsageDialog from '../components/usage/UserUsageDialog';
import MiniBarChart from '../components/usage/MiniBarChart';
import {
  consoleAdminPageClass,
  consoleAdminTableScrollClass,
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
  const navigate = useNavigate();
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

  // 深链：/admin/usage?user=<id> → 打开对应弹窗
  useEffect(() => {
    const uid = searchParams.get('user');
    if (uid) {
      setDialogUserId(uid);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const items = summary?.items || [];
  const platformTotal = summary?.totalTokens ?? 0;

  // 搜索（本地过滤）；无搜索词时默认隐藏 0 用量用户，避免淹没排行榜
  const [search, setSearch] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);
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
      primary: d.promptTokens || 0,
      secondary: d.completionTokens || 0,
    })),
    [overview],
  );

  const toggleExpand = (userId) => setExpandedUserId((prev) => (prev === userId ? null : userId));

  return (
    <div className={consoleAdminPageClass}>
      <PageHeader
        title={t('users:usage.title')}
        description={t('users:usage.subtitle', { defaultValue: 'Platform LLM token consumption overview and per-user ranking' })}
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

          {/* 平台日趋势 */}
          <section>
            <div className="mb-2 flex items-center gap-4">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{t('users:usage.trend')}</h2>
              <span className="flex items-center gap-1 text-[11px] text-zinc-400">
                <span className="inline-block h-1.5 w-1.5 rounded-sm bg-blue-500" /> {t('users:usage.prompt')}
              </span>
              <span className="flex items-center gap-1 text-[11px] text-zinc-400">
                <span className="inline-block h-1.5 w-1.5 rounded-sm bg-emerald-400" /> {t('users:usage.completion')}
              </span>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-surface px-3 py-4">
              <MiniBarChart data={trendData} height={104} />
            </div>
          </section>

          {/* 用户排行 */}
          <section className="flex min-h-0 flex-1 flex-col">
            <div className="mb-2 flex items-center justify-between gap-3">
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
              <div className={consoleAdminTableScrollClass}>
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <colgroup>
                    <col className="w-10" />
                    <col className="w-1/5" />
                    <col className="w-1/7" />
                    <col className="w-1/7" />
                    <col className="w-1/7" />
                    <col className="w-1/7" />
                    <col className="w-1/7" />
                    <col className="w-1/6" />
                    <col className="w-12" />
                  </colgroup>
                  <thead className="sticky top-0 z-10">
                    <tr className={consoleTableHeadRowClass}>
                      <th className={consoleTableHeadCellClass}>#</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.user')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.requests')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.prompt')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.completion')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.total_tokens')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.cache_hit_rate')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.share')}</th>
                      <th className={consoleTableHeadCellClass} />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {visibleRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className={`${consoleTableBodyCellClass} text-center text-zinc-400`}>
                          {q ? t('users:empty.no_match', { defaultValue: 'No users match your search.' }) : t('users:usage.no_data')}
                        </td>
                      </tr>
                    ) : visibleRows.map((u, idx) => {
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
                        <td colSpan={9} className="px-4 py-2.5 text-center text-[11px] text-zinc-400">
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
                        <td colSpan={9} className="px-4 py-2.5 text-center text-[11px] text-zinc-400">
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

          {/* Agent 分布（含缓存命中率） */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{t('users:usage.by_agent')}</h2>
            <div className={consoleAdminTableShellClass}>
              <div className={consoleAdminTableScrollClass}>
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <thead className="sticky top-0 z-10">
                    <tr className={consoleTableHeadRowClass}>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.agent')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.requests')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.prompt')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.cached_tokens')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.cache_hit_rate')}</th>
                      <th className={consoleTableHeadCellClass}>{t('users:usage.total_tokens')}</th>
                    </tr>
                  </thead>
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
        <UserUsageDialog userId={dialogUserId} days={Number(days)} onClose={() => { setDialogUserId(null); navigate('/admin/usage', { replace: true }); }} />
      )}
    </div>
  );
}

function Row({ user, idx, share, expanded, expandable, onToggle, onOpenDialog, t }) {
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
        <td className={`${consoleTableBodyCellClass} font-mono text-xs tabular-nums`}>{formatTokensFull(user.requests)}</td>
        <td className={`${consoleTableBodyCellClass} font-mono text-xs tabular-nums text-zinc-500`}>{formatTokens(user.promptTokens)}</td>
        <td className={`${consoleTableBodyCellClass} font-mono text-xs tabular-nums text-zinc-500`}>{formatTokens(user.completionTokens)}</td>
        <td className={`${consoleTableBodyCellClass} font-mono text-xs font-semibold tabular-nums text-zinc-900`}>
          {formatTokens(user.totalTokens)}
        </td>
        <td className={`${consoleTableBodyCellClass} font-mono text-xs tabular-nums text-zinc-500`}>
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
          <td colSpan={9} className="bg-zinc-50/60 px-4 py-4" onClick={(e) => e.stopPropagation()}>
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
