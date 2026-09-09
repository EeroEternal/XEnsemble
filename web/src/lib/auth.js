const LS_ACCESS = 'xe_access_token';
const LS_REFRESH = 'xe_refresh_token';
const LS_API_BASE = 'xe_api_base';
const LS_USER = 'user';

// Preview deployments (iframe / pop-out) run same-origin as the console but
// must not share auth tokens with it — the deployed app has its own backend
// and JWT secret, so a 401 from the deployed app would otherwise trigger
// clearTokens() and destroy the console session. We isolate auth storage by
// using sessionStorage inside any preview context: the console's tokens live
// in localStorage (top window, non-preview URL), and preview contexts use
// sessionStorage — two distinct storage areas that never collide.
// Note: same-origin iframes share the parent tab's sessionStorage (per HTML
// spec, sessionStorage is scoped to origin + top-level browsing context), but
// the console never stores auth tokens in sessionStorage, so there is no
// cross-contamination.
// 预览上下文识别的第三个信号：路由引导 shim（沙箱 previewProxyServer 注入）剥掉
// /preview/<id>/ 前缀后，pop-out 的地址栏不再命中上面的正则。shim 在剥前缀前写入
// sessionStorage 标记（仅独立窗口，iframe 跳过以避免污染父控制台），据此维持
// sessionStorage 隔离，防止嵌套部署间 token 经 localStorage 串扰。
function hasPreviewSessionMarker() {
  try { return !!window.sessionStorage.getItem('xe_preview_dep'); } catch { return false; }
}
const IS_PREVIEW_CONTEXT = typeof window !== 'undefined'
  && (window.self !== window.top
      || /\/preview\/[^/]+/.test(window.location.pathname)
      || hasPreviewSessionMarker());
const store = IS_PREVIEW_CONTEXT ? sessionStorage : localStorage;

export function getCurrentApiBase() {
  const env = import.meta.env.VITE_API_BASE?.trim();
  if (env) return env.replace(/\/+$/, '');
  if (import.meta.env.PROD) return window.location.origin;
  return 'http://localhost:3888';
}

function apiUrl(path) {
  return `${getCurrentApiBase()}${path}`;
}

export function isStoredAuthStale() {
  const storedBase = store.getItem(LS_API_BASE);
  if (!storedBase) return false;
  return storedBase !== getCurrentApiBase();
}

export function getAccessToken() {
  try { return store.getItem(LS_ACCESS); } catch { return null; }
}

export function getRefreshToken() {
  try { return store.getItem(LS_REFRESH); } catch { return null; }
}

export function setTokens(accessToken, refreshToken) {
  store.setItem(LS_ACCESS, accessToken);
  store.setItem(LS_REFRESH, refreshToken);
  store.setItem(LS_API_BASE, getCurrentApiBase());
}

export function clearTokens() {
  store.removeItem(LS_ACCESS);
  store.removeItem(LS_REFRESH);
  store.removeItem(LS_API_BASE);
}

export function getStoredUser() {
  try { return store.getItem(LS_USER); } catch { return null; }
}

export function setStoredUser(user) {
  store.setItem(LS_USER, JSON.stringify(user));
}

export function clearStoredUser() {
  store.removeItem(LS_USER);
}

let refreshPromise = null;
let onAuthExpired = null;

export function setAuthExpiredHandler(handler) {
  onAuthExpired = typeof handler === 'function' ? handler : null;
}

function notifyAuthExpired() {
  clearTokens();
  onAuthExpired?.();
}

export async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const refreshToken = getRefreshToken();
      if (!refreshToken) return null;
      const res = await fetch(apiUrl('/api/v1/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.access_token || !data.refresh_token) return null;
      setTokens(data.access_token, data.refresh_token);
      return data.access_token;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function apiFetch(path, options = {}) {
  const accessToken = getAccessToken();
  const headers = {
    ...(options.headers || {}),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const locale = localStorage.getItem('xe_locale') || 'en';
  if (!headers['Accept-Language']) {
    headers['Accept-Language'] = locale;
  }

  const url = apiUrl(path);
  let res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers.Authorization = `Bearer ${newToken}`;
      res = await fetch(url, { ...options, headers });
    }
    if (res.status === 401) {
      // Check if this is a git provider auth error (not user session expiry).
      // Git routes return 400 + code:REAUTH_REQUIRED for expired git tokens,
      // but as a defensive guard: if a 401 slips through, check the response
      // body for REAUTH_REQUIRED before logging out the user.
      try {
        const cloned = res.clone();
        const body = await cloned.json().catch(() => ({}));
        if (body?.code === 'REAUTH_REQUIRED') {
          return res;
        }
      } catch (_) { /* not JSON */ }
      notifyAuthExpired();
    }
  }
  return res;
}
