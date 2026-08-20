import { useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { withSessionId } from '@/lib/sessionContext';

async function request(path, options = {}) {
  const res = await apiFetch(withSessionId(path), options);
  let data;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data.error || data.message || `Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function useWorkspaceFiles() {
  const [loading, setLoading] = useState(false);

  const withLoading = useCallback(async (fn) => {
    setLoading(true);
    try {
      return await fn();
    } finally {
      setLoading(false);
    }
  }, []);

  const listFiles = useCallback((projectId, path, depth) => {
    const params = new URLSearchParams({ project_id: projectId, path });
    if (depth) params.set('depth', depth);
    return withLoading(() =>
      request(`/api/v1/workspace/files?${params.toString()}`).then((d) => (Array.isArray(d) ? d : d.entries || []))
    );
  }, [withLoading]);

  const readFile = useCallback((projectId, path) => {
    const params = new URLSearchParams({ project_id: projectId, path });
    return withLoading(() =>
      request(`/api/v1/workspace/file?${params.toString()}`).then((data) => {
        if (data.isBinary) {
          return { content: '', isBinary: true };
        }
        return data;
      })
    );
  }, [withLoading]);

  const writeFile = useCallback((projectId, path, content, opts = {}) => {
    const params = new URLSearchParams({ project_id: projectId, path });
    const headers = { 'Content-Type': 'application/json' };
    if (opts.loadedAt) {
      headers['If-Unmodified-Since'] = new Date(opts.loadedAt).toUTCString();
    }
    return withLoading(() =>
      request(`/api/v1/workspace/file?${params.toString()}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content }),
      })
    );
  }, [withLoading]);

  const deleteFile = useCallback((projectId, path) => {
    const params = new URLSearchParams({ project_id: projectId, path });
    return withLoading(() =>
      request(`/api/v1/workspace/file?${params.toString()}`, { method: 'DELETE' })
    );
  }, [withLoading]);

  const createDir = useCallback((projectId, path) => {
    const params = new URLSearchParams({ project_id: projectId });
    return withLoading(() =>
      request(`/api/v1/workspace/dir?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    );
  }, [withLoading]);

  const deleteDir = useCallback((projectId, path) => {
    const params = new URLSearchParams({ project_id: projectId, path });
    return withLoading(() =>
      request(`/api/v1/workspace/dir?${params.toString()}`, { method: 'DELETE' })
    );
  }, [withLoading]);

  const moveFile = useCallback((projectId, from, to) => {
    const params = new URLSearchParams({ project_id: projectId });
    return withLoading(() =>
      request(`/api/v1/workspace/move?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      })
    );
  }, [withLoading]);

  return {
    listFiles,
    readFile,
    writeFile,
    deleteFile,
    createDir,
    deleteDir,
    moveFile,
    loading,
  };
}