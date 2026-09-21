import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { ConsoleDialogShell, ConsoleStructuredDialogHeader, ConsoleStructuredDialogBody } from '../ConsoleDialog';
import { consoleDialogLgClass } from '../../lib/consoleTokens';
import { apiFetch } from '../../lib/api';
import { formatTokens, formatTokensFull } from '../../lib/formatTokens';
import MiniBarChart from './MiniBarChart';
import UsageBarList from './UsageBarList';

// 内置功能标识 → 本地化名称；未知 feature 原样展示（向前兼容新功能）。
function featureLabel(feature, t) {
  const key = `observability:my_usage.feature_${feature}`;
  const label = t(key);
  return label === key ? feature : label;
}

/**
 * Admin 单用户 Token 用量详情弹窗（ConsoleDialogShell 体系）。
 * @param {string} userId
 * @param {number} days 周期（7/30/90）
 * @param {Function} onClose
 */
export default function UserUsageDialog({ userId, days = 30, onClose }) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    apiFetch(`/api/v1/admin/usage/users/${userId}?days=${days}`)
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || 'Failed to load usage');
        setDetail(data);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [userId, days]);

  const s = detail?.summary;
  const byProject = (detail?.byProject || []).map((r) => ({
    key: r.projectName || t('users:usage.deleted_project', { defaultValue: 'Deleted workspace' }),
    totalTokens: r.totalTokens,
    requests: r.requests,
  }));

  return (
    <ConsoleDialogShell onClose={onClose} panelClassName={`${consoleDialogLgClass} max-h-[calc(100vh-2rem)] overflow-y-auto`}>
      <ConsoleStructuredDialogHeader
        title={t('users:usage.detail_title', { username: detail?.user?.username || '…', defaultValue: "{{username}}'s usage" })}
        subtitle={t('users:usage.detail_subtitle', { days, defaultValue: 'LLM token consumption, last {{days}} days' })}
      />
      <ConsoleStructuredDialogBody>
        {error ? (
          <p className="text-sm text-red-500">{error}</p>
        ) : !detail ? (
          <div className="flex items-center justify-center py-12 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* 统计卡 */}
            <div className="grid grid-cols-3 gap-3">
              <StatCard label={t('users:usage.total_tokens')} value={formatTokens(s.totalTokens)} full={formatTokensFull(s.totalTokens)} />
              <StatCard label={t('users:usage.requests')} value={formatTokens(s.requests)} />
              <StatCard
                label={t('users:usage.avg_per_request')}
                value={formatTokens(s.requests > 0 ? Math.round(s.totalTokens / s.requests) : 0)}
              />
            </div>

            {/* 日趋势 */}
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                {t('users:usage.trend')}
              </p>
              <div className="rounded-lg border border-zinc-200 px-2 py-3">
                <MiniBarChart
                  data={(detail.trend || []).map((d) => ({
                    label: d.day,
                    tip: d.day,
                    values: { prompt: d.promptTokens || 0, completion: d.completionTokens || 0 },
                  }))}
                  height={88}
                  series={[
                    { key: 'prompt', label: t('users:usage.prompt'), color: 'bg-blue-500' },
                    { key: 'completion', label: t('users:usage.completion'), color: 'bg-emerald-400' },
                  ]}
                  totalLabel={t('users:usage.total_tokens')}
                />
              </div>
            </div>

            {/* 分布 */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-zinc-200 p-3.5">
                <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t('users:usage.by_model')}
                </p>
                <UsageBarList
                  items={detail.byModel || []}
                  emptyText={t('users:usage.no_data')}
                  unnamedText={t('users:usage.unknown')}
                />
              </div>
              <div className="rounded-lg border border-zinc-200 p-3.5">
                <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t('users:usage.by_project')}
                </p>
                <UsageBarList
                  items={byProject}
                  emptyText={t('users:usage.no_data')}
                  unnamedText={t('users:usage.unknown')}
                />
              </div>
            </div>

            {/* 0043：内置 AI 用量（按功能）；旧版服务端无 internalByFeature 时隐藏 */}
            {(detail.internalByFeature || []).length > 0 && (
              <div>
                <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t('observability:my_usage.internal_by_feature')}
                </p>
                <div className="overflow-hidden rounded-lg border border-zinc-200">
                  <table className="w-full table-fixed border-collapse text-left text-xs">
                    <colgroup>
                      <col className="w-[40%]" />
                      <col className="w-[15%]" />
                      <col className="w-[15%]" />
                      <col className="w-[30%]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-400">
                        <th className="px-3 py-2 font-medium">{t('observability:my_usage.feature')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('users:usage.requests')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('users:usage.total_tokens')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('observability:my_usage.source_internal')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {detail.internalByFeature.map((f) => (
                        <tr key={f.feature} className="text-zinc-600">
                          <td className="px-3 py-2 font-medium text-zinc-900">{featureLabel(f.feature, t)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">{f.requests}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">{formatTokensFull(f.totalTokens)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-400">
                            {formatTokens(f.promptTokens)} / {formatTokens(f.completionTokens)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 最近请求 */}
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                {t('users:usage.recent_requests')}
              </p>
              <div className="overflow-hidden rounded-lg border border-zinc-200">
                <div className="shrink-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
                <table className="w-full table-fixed border-collapse text-left text-xs">
                  <colgroup>
                    <col className="w-[22%]" />
                    <col className="w-[22%]" />
                    <col className="w-[30%]" />
                    <col className="w-[14%]" />
                    <col className="w-[12%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-400">
                      <th className="px-3 py-2 font-medium">{t('users:usage.time')}</th>
                      <th className="px-3 py-2 font-medium">{t('users:usage.model')}</th>
                      <th className="px-3 py-2 font-medium">{t('users:usage.project')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('users:usage.total_tokens')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('users:usage.status')}</th>
                    </tr>
                  </thead>
                </table>
                </div>
                <div className="max-h-64 overflow-y-auto [scrollbar-gutter:stable]">
                <table className="w-full table-fixed border-collapse text-left text-xs">
                  <colgroup>
                    <col className="w-[22%]" />
                    <col className="w-[22%]" />
                    <col className="w-[30%]" />
                    <col className="w-[14%]" />
                    <col className="w-[12%]" />
                  </colgroup>
                  <tbody className="divide-y divide-zinc-100">
                    {(detail.recent || []).length === 0 ? (
                      <tr><td colSpan={5} className="px-3 py-4 text-center text-zinc-400">{t('users:usage.no_data')}</td></tr>
                    ) : detail.recent.map((r) => (
                      <tr key={r.id} className="text-zinc-600">
                        <td className="px-3 py-2 tabular-nums">{new Date(r.createdAt).toLocaleString()}</td>
                        <td className="px-3 py-2">{r.model || '—'}</td>
                        <td className="max-w-32 truncate px-3 py-2" title={r.projectName || ''}>
                          {r.projectName || t('users:usage.deleted_project', { defaultValue: 'Deleted workspace' })}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{formatTokensFull(r.totalTokens)}</td>
                        <td className={`px-3 py-2 text-right font-mono ${r.statusCode && r.statusCode < 400 ? 'text-emerald-600' : 'text-red-500'}`}>
                          {r.statusCode ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            </div>
          </div>
        )}
      </ConsoleStructuredDialogBody>
    </ConsoleDialogShell>
  );
}

function StatCard({ label, value, full }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4" title={full}>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">{value}</div>
    </div>
  );
}
