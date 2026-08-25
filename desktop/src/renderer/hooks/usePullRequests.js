import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast';
import * as githubApi from '../lib/githubApi.js';

export function usePullRequests(projectId) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [pullRequests, setPullRequests] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchPRs = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const { pull_requests: rows } = await githubApi.listPullRequests(projectId);
      setPullRequests(Array.isArray(rows) ? rows : []);
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, showToast]);

  useEffect(() => {
    fetchPRs();
  }, [fetchPRs]);

  const sync = useCallback(async (prId) => {
    if (!projectId || !prId) return;
    try {
      const updated = await githubApi.syncPullRequest(projectId, prId);
      setPullRequests((prev) =>
        prev.map((pr) => (pr.id === prId ? updated : pr)),
      );
      showToast('success', t('git:toast.pr_synchronized', { defaultValue: 'Pull request synchronized.' }));
      return updated;
    } catch (err) {
      showToast('error', err.message);
      throw err;
    }
  }, [projectId, showToast]);

  return {
    pullRequests,
    loading,
    fetchPRs,
    sync,
  };
}
