import { getApiBase } from './backend';

const LS_ACCESS = 'xe_access_token';
const LS_REFRESH = 'xe_refresh_token';

function isDesktop(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).xensembleDesktopAPI);
}

export async function getAccessToken(): Promise<string | null> {
  if (isDesktop()) return (window as any).xensembleDesktopAPI.getAccessToken();
  return localStorage.getItem(LS_ACCESS);
}

export async function getRefreshToken(): Promise<string | null> {
  if (isDesktop()) return (window as any).xensembleDesktopAPI.getRefreshToken();
  return localStorage.getItem(LS_REFRESH);
}

export async function setTokens(accessToken: string, refreshToken: string): Promise<void> {
  if (isDesktop()) {
    await (window as any).xensembleDesktopAPI.setAccessToken(accessToken);
    await (window as any).xensembleDesktopAPI.setRefreshToken(refreshToken);
  } else {
    localStorage.setItem(LS_ACCESS, accessToken);
    localStorage.setItem(LS_REFRESH, refreshToken);
  }
}

export async function clearTokens(): Promise<void> {
  if (isDesktop()) {
    await (window as any).xensembleDesktopAPI.clearTokens();
  } else {
    localStorage.removeItem(LS_ACCESS);
    localStorage.removeItem(LS_REFRESH);
  }
}

let refreshPromise: Promise<string | null> | null = null;

export async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const refreshToken = await getRefreshToken();
      if (!refreshToken) return null;
      const res = await fetch(`${getApiBase()}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.access_token || !data.refresh_token) return null;
      await setTokens(data.access_token, data.refresh_token);
      return data.access_token;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const accessToken = await getAccessToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const locale = localStorage.getItem('xe_locale') || 'en';
  if (!headers['Accept-Language']) {
    headers['Accept-Language'] = locale;
  }

  const url = `${getApiBase()}${path}`;
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers.Authorization = `Bearer ${newToken}`;
      return fetch(url, { ...options, headers });
    }
  }
  return res;
}
