export function getApiBase() {
  const env = import.meta.env.VITE_API_BASE?.trim();
  if (env) return env.replace(/\/+$/, '');
  if (import.meta.env.PROD) return '';
  return 'http://localhost:3888';
}

export function getWsBase() {
  const env = import.meta.env.VITE_API_BASE?.trim();
  if (env) {
    const u = new URL(env);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}`;
  }
  if (import.meta.env.PROD) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  return 'ws://localhost:3888';
}

export function getWsUrl(sessionId, accessToken, after) {
  const params = new URLSearchParams({ sessionId });
  if (accessToken) params.set('access_token', accessToken);
  if (after != null && after > 0) params.set('after', String(after));
  return `${getWsBase()}/ws/v1/terminal?${params.toString()}`;
}

export function getWorkspaceShellWsUrl(projectId, accessToken, sessionId) {
  const params = new URLSearchParams({ project_id: projectId });
  if (accessToken) params.set('access_token', accessToken);
  if (sessionId) params.set('session_id', sessionId);
  return `${getWsBase()}/ws/v1/workspace-terminal?${params.toString()}`;
}

export function publicFetch(path, options = {}) {
  return fetch(`${getApiBase()}${path}`, options);
}

export {
  apiFetch,
  getAccessToken,
  getRefreshToken,
  setTokens,
  clearTokens,
  refreshAccessToken,
  getCurrentApiBase,
  isStoredAuthStale,
  setAuthExpiredHandler,
  getStoredUser,
  setStoredUser,
  clearStoredUser,
} from './auth';
