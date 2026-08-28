/**
 * Theme preference management — light / dark / system.
 *
 * Persists to localStorage (same pattern as language pref `xe_locale`).
 * Applies the resolved theme by toggling `.dark` on <html>, which drives
 * Tailwind's `darkMode: ["class"]` plus the CSS variable sets in index.css.
 */
const THEME_KEY = 'xe_theme'; // 'light' | 'dark' | 'system'
const THEME_OPTIONS = ['light', 'dark', 'system'];

const listeners = new Set();

function systemPrefersDark() {
  return (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function loadThemePref() {
  // Default to light (the console's native design). 'system' is opt-in so a
  // fresh deployment never comes up dark just because the OS/browser is.
  if (typeof localStorage === 'undefined') return 'light';
  const stored = localStorage.getItem(THEME_KEY);
  return THEME_OPTIONS.includes(stored) ? stored : 'light';
}

export function saveThemePref(pref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch (_) { /* ignore */ }
}

/** Resolve a pref ('system' → OS preference) to a concrete 'light' | 'dark'. */
export function resolveTheme(pref) {
  return pref === 'dark' || (pref === 'system' && systemPrefersDark()) ? 'dark' : 'light';
}

/** Apply the resolved theme to <html>; returns whether dark is active. */
export function applyTheme(pref) {
  const isDark = resolveTheme(pref) === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  return isDark;
}

function notify() {
  listeners.forEach((cb) => {
    try { cb(); } catch (_) { /* ignore */ }
  });
}

/** Persist + apply + notify subscribers. */
export function setThemePref(pref) {
  saveThemePref(pref);
  applyTheme(pref);
  notify();
}

/** Subscribe to theme changes; returns an unsubscribe function. */
export function subscribeTheme(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Follow OS theme changes while pref is 'system'. Returns an unsubscribe
 * function. The caller decides whether to re-subscribe when pref changes.
 */
export function watchSystemTheme(onChange) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    try { onChange?.(); } catch (_) { /* ignore */ }
    notify();
  };
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}
