import { TIMEZONES, DEFAULT_TIMEZONE } from './timezones';

/**
 * 用户默认时区偏好（新建 LoopTask 时预填）。
 * 存储于 localStorage（同 xe_theme / xe_view_mode / xe_locale 模式）。
 */
const TIMEZONE_KEY = 'xe_timezone';

export function loadTimezonePref() {
  if (typeof localStorage === 'undefined') return DEFAULT_TIMEZONE;
  try {
    const stored = localStorage.getItem(TIMEZONE_KEY);
    return TIMEZONES.includes(stored) ? stored : DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function saveTimezonePref(tz) {
  if (!TIMEZONES.includes(tz)) return;
  try {
    localStorage.setItem(TIMEZONE_KEY, tz);
  } catch { /* ignore */ }
}
