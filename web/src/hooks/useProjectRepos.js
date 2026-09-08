import { useState, useCallback, useEffect } from 'react';
import { apiFetch } from '@/lib/api';

async function parseResponse(res) {
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(data.error || data.message || `Request failed: ${res.status}`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

/**
 * useProjectRepos — 拉取 / 管理 project_repos（多仓库项目）
 * 返回 { repos, loading, error, reload, addRepo, removeRepo, setPrimary }
 */
export function useProjectRepos(projectId) {
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await parseResponse(
        await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/repos`),
      );
      setRepos(Array.isArray(data.repos) ? data.repos : []);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const addRepo = useCallback(async (input) => {
    const data = await parseResponse(
      await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/repos`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    );
    await reload();
    return data.repo;
  }, [projectId, reload]);

  const removeRepo = useCallback(async (repoId) => {
    await parseResponse(
      await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}`, {
        method: 'DELETE',
      }),
    );
    await reload();
  }, [projectId, reload]);

  const setPrimary = useCallback(async (repoId) => {
    await parseResponse(
      await apiFetch(`/api/v1/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}/primary`, {
        method: 'POST',
      }),
    );
    await reload();
  }, [projectId, reload]);

  return { repos, loading, error, reload, addRepo, removeRepo, setPrimary };
}
