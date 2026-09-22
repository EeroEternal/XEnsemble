import { apiFetch } from './api';
import { withSessionId } from './sessionContext';

export function generateWorkBranchName(repoFullName) {
  const repoName = (repoFullName || '').split('/').pop() || 'workspace';
  const shortId = Date.now().toString(36).slice(-4);
  return `agentharness/${repoName}-${shortId}`;
}

async function request(path, options = {}) {
  const res = await apiFetch(withSessionId(path), options);
  let data;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const e = new Error(data.error || data.message || `Request failed: ${res.status}`);
    if (data.code) e.code = data.code;
    throw e;
  }
  return data;
}

export const listProviders = () => request('/api/v1/git/providers');

export const getProviderConfig = (provider) =>
  request(`/api/v1/git/providers/${encodeURIComponent(provider)}/config`);

export const getConnection = (provider) =>
  request(`/api/v1/git/connections/${encodeURIComponent(provider)}`);

export const connectProvider = (provider) =>
  request('/api/v1/git/connect', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });

export const disconnectProvider = (provider) =>
  request(`/api/v1/git/connections/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
  });

export const connectWithPat = (provider, token) =>
  request(`/api/v1/git/connections/${encodeURIComponent(provider)}/pat`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  });

export const listRepos = (provider, params = {}) => {
  const qs = new URLSearchParams({ provider, ...params });
  return request(`/api/v1/git/repos?${qs.toString()}`);
};

export const getRepo = (provider, repoPath) =>
  request(`/api/v1/git/repos/${repoPath}?provider=${encodeURIComponent(provider)}`);

export const importRepo = (payload) =>
  request('/api/v1/projects/import-git', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const listMergeRequests = (projectId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests`);

export const createMergeRequest = (projectId, payload) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const syncMergeRequest = (projectId, mrId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/sync`, {
    method: 'POST',
  });

export const syncAllMergeRequests = (projectId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/sync-all`, {
    method: 'POST',
  });

export const getMergeRequest = (projectId, mrId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}`);

export const mergeMergeRequest = (projectId, mrId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/merge`, {
    method: 'POST',
  });

export const closeMergeRequest = (projectId, mrId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/close`, {
    method: 'POST',
  });

export const reopenMergeRequest = (projectId, mrId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/reopen`, {
    method: 'POST',
  });

export const approveMergeRequest = (projectId, mrId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/approve`, {
    method: 'POST',
  });

export const addMergeRequestComment = (projectId, mrId, body) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });

export const replyToReviewComment = (projectId, mrId, commentId, body, discussionId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/comments/${encodeURIComponent(commentId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ body, discussionId }),
  });

export const editMergeRequestComment = (projectId, mrId, commentId, body, commentType = 'issue') => {
  const qs = new URLSearchParams({ type: commentType });
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/comments/${encodeURIComponent(commentId)}?${qs}`, {
    method: 'PUT',
    body: JSON.stringify({ body }),
  });
};

export const deleteMergeRequestComment = (projectId, mrId, commentId, commentType = 'issue') => {
  const qs = new URLSearchParams({ type: commentType });
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/comments/${encodeURIComponent(commentId)}?${qs}`, {
    method: 'DELETE',
  });
};

export const listReviews = (projectId, mrId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/reviews`);

export const listReviewComments = (projectId, mrId, params = {}) => {
  const qs = new URLSearchParams(params);
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/comments?${qs}`);
};

export const listIssueComments = (projectId, mrId, params = {}) => {
  const qs = new URLSearchParams(params);
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/issue-comments?${qs}`);
};

export const listMrFiles = (projectId, mrId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mrId)}/files`);

export const getBlame = (projectId, filePath, params = {}) => {
  const qs = new URLSearchParams({ path: filePath, ...params });
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/repository/blame?${qs}`);
};

export const getDetailedLog = (projectId, params = {}) => {
  const qs = new URLSearchParams(params);
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/repository/log/detailed?${qs}`);
};

export const getCommitFiles = (projectId, sha) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/repository/commit/${encodeURIComponent(sha)}/files`);

export const listTrackedFiles = (projectId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/repository/files`);

export const getGraphLog = (projectId, count = 50) => {
  const qs = new URLSearchParams({ count: String(count) });
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/repository/log/graph?${qs}`);
};

export const conflictCheck = (projectId, targetBranch) => {
  const qs = new URLSearchParams({ target: targetBranch });
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/repository/conflict-check?${qs}`);
};

export const listConflicts = (projectId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/repository/conflicts`);

export const resolveConflict = (projectId, filePath, strategy) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/repository/conflicts/resolve`, {
    method: 'POST',
    body: JSON.stringify({ path: filePath, strategy }),
  });

export const writeWorkspaceFile = (projectId, filePath, content) => {
  const qs = new URLSearchParams({ project_id: projectId, path: filePath });
  return request(`/api/v1/workspace/file?${qs.toString()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
};

export const getFileAtRef = (projectId, filePath, ref = 'HEAD') => {
  const qs = new URLSearchParams({ path: filePath, ref });
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/repository/file?${qs}`);
};
