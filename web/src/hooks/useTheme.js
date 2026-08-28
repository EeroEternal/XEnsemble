import { useEffect, useSyncExternalStore } from 'react';
import {
  loadThemePref,
  resolveTheme,
  setThemePref,
  subscribeTheme,
  watchSystemTheme,
} from '../lib/themePrefs';

function getSnapshot() {
  const pref = loadThemePref();
  return `${pref}:${resolveTheme(pref)}`;
}

/**
 * React binding for the theme preference.
 * Returns the stored pref ('light'|'dark'|'system'), the resolved concrete
 * theme, and a setter. Re-renders on pref / OS-theme changes.
 */
export function useTheme() {
  const snapshot = useSyncExternalStore(subscribeTheme, getSnapshot);
  const [pref, resolved] = snapshot.split(':');

  // Follow OS theme changes while pref === 'system'.
  useEffect(() => {
    if (pref !== 'system') return undefined;
    return watchSystemTheme();
  }, [pref]);

  return { pref, isDark: resolved === 'dark', setPref: setThemePref };
}
