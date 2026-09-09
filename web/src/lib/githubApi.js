import { apiFetch } from './api';
import { withSessionId } from './sessionContext';

async function request(path, options = {}) {
  const res = await apiFetch(withSessionId(path), options);
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data.error || data.message || `Request failed: ${res.status}`);
    if (data.code) err.code = data.code;
    throw err;
  }
  return data;
}

export function openExternal(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export const getGitStatus = (projectId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/status`);

export const getGitStatusLight = (projectId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/status?mode=light`);

export const getCloneStatus = (projectId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/clone-status`);

export const commitStaged = (projectId, message, author) => {
  const body = { message };
  if (author) body.author = author;
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/commit`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
};

export const stageFiles = (projectId, files) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/stage`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  });

export const unstageFiles = (projectId, files) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/unstage`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  });

export const discardFiles = (projectId, files) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/discard`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  });

export const pushBranch = (projectId, branch, repoId) => {
  const body = { branch };
  // 多仓库：repoId 指定时只推该仓库（per-repo push），缺省推全部仓库
  if (repoId) body.repo_id = repoId;
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/push`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
};

export const pullLatest = (projectId, options = {}) => {
  const body = {};
  if (options.force) body.force = true;
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/pull`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
};

export const fetchRemote = (projectId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/fetch`, {
    method: 'POST',
  });

export const getGitDiff = (projectId, { base, head } = {}) => {
  const qs = new URLSearchParams();
  if (base) qs.set('base', base);
  if (head) qs.set('head', head);
  const query = qs.toString();
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/diff${query ? `?${query}` : ''}`);
};

export const getGitFileDiff = (projectId, filePath) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/file-diff?path=${encodeURIComponent(filePath)}`);

export const getGitFileDiffView = (projectId, filePath) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/file-diff-view?path=${encodeURIComponent(filePath)}`);

export const getGitFileContent = (projectId, filePath, ref = 'HEAD') =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/file-content?path=${encodeURIComponent(filePath)}&ref=${encodeURIComponent(ref)}`);

export const listBranches = (projectId) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/branches`);

export const switchBranch = (projectId, name) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/branches/switch`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

export const createBranch = (projectId, name, baseBranch) => {
  const body = { name };
  if (baseBranch) body.base_branch = baseBranch;
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/branches`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
};

export const generatePRDescription = (projectId, { sourceBranch, targetBranch } = {}) =>
  request(`/api/v1/projects/${encodeURIComponent(projectId)}/git/pr-description`, {
    method: 'POST',
    body: JSON.stringify({ source_branch: sourceBranch, target_branch: targetBranch }),
  });

export const createPullRequest = (projectId, payload) =>
  request(withSessionId(`/api/v1/projects/${encodeURIComponent(projectId)}/merge-requests`), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
