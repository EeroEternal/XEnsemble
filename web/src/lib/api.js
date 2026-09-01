export function getApiBase() {
  const env = import.meta.env.VITE_API_BASE?.trim();
  if (env) return env.replace(/\/+$/, '');
  if (import.meta.env.PROD) return '';
  return 'http://localhost:3888';
}

export function getWsBase() {
  const env = import.meta.env.VITE_API_BASE?.trim();
  if (env) {
    // live 预览：VITE_API_BASE 是相对路径 /preview/<id>，基于当前页面 origin 构造 ws 地址，
    // 让 WS 也带上 /preview/<id> 前缀，经网关+隧道反代到沙箱后端（否则连到宿主 8089 而失败）。
    if (/^https?:\/\//i.test(env)) {
      const u = new URL(env);
      const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${u.host}`;
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${env.replace(/\/+$/, '')}`;
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
  const headers = { ...(options.headers || {}) };
  if (!headers['Accept-Language']) {
    let locale = 'en';
    try { locale = localStorage.getItem('xe_locale') || 'en'; } catch { /* ignore */ }
    headers['Accept-Language'] = locale;
  }
  return fetch(`${getApiBase()}${path}`, { ...options, headers });
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
