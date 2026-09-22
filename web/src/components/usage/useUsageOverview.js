import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

/**
 * 观测页共享取数：周期（days）+ 平台概览（/usage/overview）。
 *
 * 「用户统计」与「智能体与模型」两页都依赖同一份 overview（前者取 summary/trend，
 * 后者取 byAgent/trend.costByAgent），取数与周期状态在此收敛，避免两页各写一遍。
 *
 * @param {{ withSummary?: boolean }} [opts]
 *        withSummary=true 时额外拉 /usage/summary（用户排行，仅用户统计页需要）。
 * @returns {{days, setDays, overview, summary, loading, refreshing, refresh}}
 */
export function useUsageOverview({ withSummary = false } = {}) {
  const [days, setDays] = useState('30');
  const [overview, setOverview] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(({ silent = false } = {}) => {
    if (!silent) setRefreshing(true);
    setLoading((prev) => (silent ? prev : true));
    const requests = [apiFetch(`/api/v1/admin/usage/overview?days=${days}`).then((r) => r.json())];
    if (withSummary) {
      requests.push(apiFetch(`/api/v1/admin/usage/summary?days=${days}`).then((r) => r.json()));
    }
    return Promise.all(requests)
      .then(([ov, sm]) => {
        setOverview(ov?.summary ? ov : null);
        if (withSummary) setSummary(sm?.items ? sm : null);
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, [days, withSummary]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { days, setDays, overview, summary, loading, refreshing, refresh: fetchData };
}
