/**
 * Session view preference — how the running agent is displayed.
 *
 * 'agent' (default): the agent's native TUI terminal.
 * 'chat'          : a Devin/Cursor-style dialog built from the structured
 *                   messages the LLM proxy records for the session.
 *
 * Stored in localStorage (same pattern as xe_theme / xe_locale).
 */
const VIEW_KEY = 'xe_view_mode';
const VIEW_OPTIONS = ['agent', 'chat'];

export function loadViewPref() {
  if (typeof localStorage === 'undefined') return 'agent';
  const stored = localStorage.getItem(VIEW_KEY);
  return VIEW_OPTIONS.includes(stored) ? stored : 'agent';
}

export function saveViewPref(mode) {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch (_) { /* ignore */ }
}
