import { getStoredUser } from './auth';

const STORAGE_PREFIX = 'xensemble.console.snapshot.';

function cacheKey(userId) {
  return `${STORAGE_PREFIX}${userId}`;
}

export function getCacheUserId(user) {
  if (user?.id) return String(user.id);
  try {
    const stored = JSON.parse(getStoredUser());
    if (stored?.id) return String(stored.id);
  } catch {
    // ignore
  }
  return null;
}

export function loadConsoleCache(userId) {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    return {
      agents: Array.isArray(data.agents) ? data.agents : [],
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      projects: Array.isArray(data.projects) ? data.projects : [],
      selectedAgentId: typeof data.selectedAgentId === 'string' ? data.selectedAgentId : '',
      activeSession:
        data.activeSession && typeof data.activeSession === 'object' ? data.activeSession : null,
      savedAt: typeof data.savedAt === 'number' ? data.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveConsoleCache(userId, snapshot) {
  if (!userId) return;
  const prev = loadConsoleCache(userId);
  const next = {
    agents: prev?.agents ?? [],
    sessions: prev?.sessions ?? [],
    projects: prev?.projects ?? [],
    selectedAgentId: prev?.selectedAgentId ?? '',
    activeSession: prev?.activeSession ?? null,
    ...snapshot,
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(next));
  } catch {
    // quota exceeded — ignore
  }
}

export function readInitialConsoleState(user) {
  const cached = loadConsoleCache(getCacheUserId(user));
  if (!cached) {
    return {
      agents: [],
      sessions: [],
      projects: [],
      selectedAgentId: '',
      activeSession: null,
    };
  }
  return {
    agents: cached.agents,
    sessions: cached.sessions,
    projects: cached.projects,
    selectedAgentId: cached.selectedAgentId,
    activeSession: cached.activeSession,
  };
}

let bootstrapSnapshot = null;

export function readBootstrapConsoleState(user) {
  if (!bootstrapSnapshot) {
    bootstrapSnapshot = readInitialConsoleState(user);
  }
  return bootstrapSnapshot;
}
