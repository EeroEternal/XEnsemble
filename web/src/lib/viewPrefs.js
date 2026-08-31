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

// Cross-component subscription so the Settings panel can flip the preference
// and the open Sessions page re-renders without a full page reload.
const listeners = new Set();

export function loadViewPref() {
    if (typeof localStorage === 'undefined') return 'agent';
    const stored = localStorage.getItem(VIEW_KEY);
    return VIEW_OPTIONS.includes(stored) ? stored : 'agent';
}

export function saveViewPref(mode) {
    try {
        localStorage.setItem(VIEW_KEY, mode);
    } catch (_) { /* ignore */ }
    for (const fn of listeners) {
        try { fn(mode); } catch (_) { /* ignore */ }
    }
}

export function subscribeViewPref(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
