const LS_ACCESS = 'xe_access_token';
const LS_REFRESH = 'xe_refresh_token';
const LS_API_BASE = 'xe_api_base';

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
  const storedBase = localStorage.getItem(LS_API_BASE);
  if (!storedBase) return false;
  return storedBase !== getCurrentApiBase();
}

export function getAccessToken() {
  return localStorage.getItem(LS_ACCESS);
}

export function getRefreshToken() {
  return localStorage.getItem(LS_REFRESH);
}

export function setTokens(accessToken, refreshToken) {
  localStorage.setItem(LS_ACCESS, accessToken);
  localStorage.setItem(LS_REFRESH, refreshToken);
  localStorage.setItem(LS_API_BASE, getCurrentApiBase());
}

export function clearTokens() {
  localStorage.removeItem(LS_ACCESS);
  localStorage.removeItem(LS_REFRESH);
  localStorage.removeItem(LS_API_BASE);
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
