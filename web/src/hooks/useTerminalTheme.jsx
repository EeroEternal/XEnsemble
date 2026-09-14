import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { apiFetch } from '../lib/api';
import { useTheme } from './useTheme';
import {
  DEFAULT_TERMINAL_THEME_ID,
  getTerminalTheme,
  listTerminalThemes,
  mergeTerminalCatalog,
} from '../lib/terminalThemes.js';
import { loadTerminalThemeId, saveTerminalThemeId } from '../lib/terminalPrefs.js';

const TerminalThemeContext = createContext(null);

async function syncPreferencesToServer(token, themeId) {
  if (!token) return;
  try {
    await apiFetch('/api/v1/user/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal_theme_id: themeId }),
    });
  } catch {
    /* local preference still applies */
  }
}

async function fetchRemoteCatalog(token) {
  if (!token) return null;
  try {
    const res = await apiFetch('/api/v1/terminal-themes');
    if (!res.ok) return null;
    const data = await res.json();
    return mergeTerminalCatalog(data.themes);
  } catch {
    return null;
  }
}

async function fetchRemotePreference(token) {
  if (!token) return null;
  try {
    const res = await apiFetch('/api/v1/user/preferences');
    if (!res.ok) return null;
    const data = await res.json();
    const id = data?.terminal_theme_id;
    if (id && getTerminalTheme(id).id === id) return id;
  } catch {
    /* ignore */
  }
  return null;
}

export function TerminalThemeProvider({ token, children }) {
  const { isDark } = useTheme();
  const [themeId, setThemeIdState] = useState(loadTerminalThemeId);
  const [themeRevision, setThemeRevision] = useState(0);
  const [catalog, setCatalog] = useState(listTerminalThemes);

  // 记住每种外观下用户最后选的终端主题，用于跟随应用主题（light/dark）自动切换。
  const darkIdRef = useRef(null);
  const lightIdRef = useRef(null);
  if (darkIdRef.current === null) {
    const initial = getTerminalTheme(themeId);
    darkIdRef.current = initial.appearance === 'dark' ? themeId : DEFAULT_TERMINAL_THEME_ID;
    lightIdRef.current = initial.appearance === 'light' ? themeId : 'github-light';
  }

  // 跟随应用主题切换终端外观：应用浅色 → 浅色终端；深色 → 深色终端。
  useEffect(() => {
    const current = getTerminalTheme(themeId);
    const targetAppearance = isDark ? 'dark' : 'light';
    if (current.appearance === targetAppearance) return;
    const targetId = isDark ? darkIdRef.current : lightIdRef.current;
    if (getTerminalTheme(targetId).id === targetId) {
      setThemeIdState(targetId);
      setThemeRevision((n) => n + 1);
    }
  }, [isDark, themeId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [remoteCatalog, remoteThemeId] = await Promise.all([
        fetchRemoteCatalog(token),
        fetchRemotePreference(token),
      ]);
      if (cancelled) return;
      if (remoteCatalog) setCatalog(remoteCatalog);
      if (remoteThemeId) {
        setThemeIdState(remoteThemeId);
        saveTerminalThemeId(remoteThemeId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const setThemeId = useCallback((nextId, { onAppearanceChange } = {}) => {
    const next = getTerminalTheme(nextId);
    if (!next || next.id !== nextId) return false;

    const prev = getTerminalTheme(themeId);

    if (next.appearance === 'dark') darkIdRef.current = nextId;
    else lightIdRef.current = nextId;

    saveTerminalThemeId(nextId);
    setThemeIdState(nextId);
    setThemeRevision((n) => n + 1);
    syncPreferencesToServer(token, nextId);

    if (prev.appearance !== next.appearance) {
      onAppearanceChange?.(prev.appearance, next.appearance);
    }
    return true;
  }, [themeId, token]);

  const preset = useMemo(() => getTerminalTheme(themeId), [themeId]);

  const value = useMemo(() => ({
    themeId,
    preset,
    catalog,
    themeRevision,
    setThemeId,
  }), [themeId, preset, catalog, themeRevision, setThemeId]);

  return (
    <TerminalThemeContext.Provider value={value}>
      {children}
    </TerminalThemeContext.Provider>
  );
}

export function useTerminalTheme() {
  const ctx = useContext(TerminalThemeContext);
  if (!ctx) {
    throw new Error('useTerminalTheme must be used within TerminalThemeProvider');
  }
  return ctx;
}
