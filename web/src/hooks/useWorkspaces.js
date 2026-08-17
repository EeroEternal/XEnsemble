import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch, getAccessToken, refreshAccessToken } from '../lib/api';
import {
  readBootstrapConsoleState,
  saveConsoleCache,
  getCacheUserId,
} from '../lib/consoleCache.js';
import {
  loadSidebarPrefs,
  pickSessionToRestore,
} from '../lib/sidebarPrefs.js';

const PENDING_INTERVAL_MS = 2000;
const NORMAL_INTERVAL_MS = 15000;
const PENDING_MAX_DURATION_MS = 5 * 60 * 1000; // cap 2s mode at 5 minutes
const DEBOUNCE_MS = 300;

function getSseUrl() {
  const base = import.meta.env.VITE_API_BASE_URL
    || (typeof window !== 'undefined' ? window.location.origin : '');
  const token = getAccessToken();
  return `${base}/api/v1/events?access_token=${encodeURIComponent(token || '')}`;
}

export function useWorkspaces(user) {
  const [agents, setAgents] = useState(() => readBootstrapConsoleState(null).agents);
  const [projects, setProjects] = useState(() => readBootstrapConsoleState(null).projects);
  const [sessions, setSessions] = useState(() => readBootstrapConsoleState(null).sessions);
  // Don't restore activeSession from localStorage cache — it may reference a
  // session that no longer exists, causing 404 cascades on initial render.
  // Let the sessions-fetch effect (below) validate and restore it instead.
  const [activeSession, setActiveSession] = useState(null);

  const hasPendingRef = useRef(false);
  const [hasPending, setHasPending] = useState(false);
  const pendingSinceRef = useRef(0);
  const debounceTimerRef = useRef(null);
  const fetchInFlightRef = useRef(false);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/agents');
      const data = await res.json();
      if (Array.isArray(data)) setAgents(data);
    } catch {
      // ignore transient errors
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/projects');
      const data = await res.json();
      if (Array.isArray(data)) {
        setProjects(data.map((p) => ({
          id: p.id,
          name: p.name,
          createdAt: p.created_at ?? p.createdAt ?? 0,
          repoProvider: p.repo_provider ?? p.repoProvider ?? 'none',
          repoUrl: p.repo_url ?? p.repoUrl ?? null,
          repoDefaultBranch: p.repo_default_branch ?? p.repoDefaultBranch ?? 'main',
          currentBranch: p.current_branch ?? p.currentBranch ?? null,
          githubRepoId: p.github_repo_id ?? p.githubRepoId ?? null,
          githubFullName: p.github_full_name ?? p.githubFullName ?? null,
          cloneStatus: p.clone_status ?? p.cloneStatus ?? null,
          cloneError: p.clone_error ?? p.cloneError ?? null,
          workspaceMode: p.workspace_mode ?? p.workspaceMode ?? 'local',
        })));
      }
    } catch {
      // ignore transient errors
    }
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await apiFetch('/api/v1/sessions');
      const data = await res.json();
      if (Array.isArray(data)) setSessions(data);
    } catch {
      // ignore transient errors
    }
  }, []);

  // Debounced fetch: coalesces burst calls (e.g. multiple state updates
  // firing fetchWorkspaces within 300ms) into a single network round-trip.
  const fetchWorkspaces = useCallback(() => {
    // If a fetch is already in flight, skip (another will be scheduled by the timer).
    if (fetchInFlightRef.current) return;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(async () => {
      debounceTimerRef.current = null;
      fetchInFlightRef.current = true;
      try {
        await Promise.all([fetchProjects(), fetchSessions()]);
      } finally {
        fetchInFlightRef.current = false;
      }
    }, DEBOUNCE_MS);
  }, [fetchProjects, fetchSessions]);

  // Fetch agents only on mount (not in the polling loop) since agent configs
  // are essentially static. Callers can still call fetchAgents() explicitly.
  useEffect(() => {
    if (!user?.id) return;
    fetchAgents();
  }, [user?.id, fetchAgents]);

  useEffect(() => {
    const pending = sessions.some((s) => s.status === 'pending');
    hasPendingRef.current = pending;
    setHasPending(pending);
    if (pending && !pendingSinceRef.current) {
      pendingSinceRef.current = Date.now();
    } else if (!pending) {
      pendingSinceRef.current = 0;
    }
  }, [sessions]);

  useEffect(() => {
    if (!user?.id) return undefined;
    let timer;
    const scheduleNext = () => {
      let interval = NORMAL_INTERVAL_MS;
      if (hasPendingRef.current) {
        // Cap 2s polling: if pending for too long, fall back to normal interval.
        const pendingDuration = pendingSinceRef.current ? Date.now() - pendingSinceRef.current : 0;
        interval = pendingDuration < PENDING_MAX_DURATION_MS ? PENDING_INTERVAL_MS : NORMAL_INTERVAL_MS;
      }
      timer = setTimeout(async () => {
        // Skip polling when the tab is hidden (saves battery + server load).
        if (typeof document !== 'undefined' && document.hidden) {
          scheduleNext();
          return;
        }
        await Promise.all([fetchProjects(), fetchSessions()]);
        scheduleNext();
      }, interval);
    };
    // Initial fetch (projects + sessions; agents fetched separately above).
    Promise.all([fetchProjects(), fetchSessions()]);
    scheduleNext();
    return () => clearTimeout(timer);
  }, [fetchProjects, fetchSessions, user?.id]);

  // Also pause/resume when tab visibility changes: fetch immediately on return.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityChange = () => {
      if (!document.hidden && user?.id) {
        Promise.all([fetchProjects(), fetchSessions(), fetchAgents()]);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [fetchProjects, fetchSessions, fetchAgents, user?.id]);

  useEffect(() => {
    if (typeof EventSource === 'undefined' || sessions.length === 0) return;
    let es = null;
    let reconnectTimer = null;
    let closed = false;
    const onMessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'session_status' || data.type === 'session_title') {
          fetchSessions();
        }
      } catch {
        // ignore invalid data
      }
    };
    const connect = () => {
      es = new EventSource(getSseUrl());
      es.addEventListener('message', onMessage);
      es.addEventListener('error', async () => {
        es.close();
        if (closed) return;
        const newToken = await refreshAccessToken();
        if (!newToken) return;
        reconnectTimer = setTimeout(connect, 2000);
      });
    };
    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (es) {
        es.removeEventListener('message', onMessage);
        es.close();
      }
    };
  }, [sessions.length > 0, fetchSessions]);

  useEffect(() => {
    if (sessions.length === 0) return;
    if (activeSession?.sessionId) {
      const exists = sessions.some((s) => s.id === activeSession.sessionId);
      if (!exists) {
        setActiveSession(null);
        const userId = getCacheUserId(user);
        if (userId) saveConsoleCache(userId, { agents, sessions, projects, activeSession: null });
      }
      return;
    }
    const prefs = loadSidebarPrefs();
    const candidate = pickSessionToRestore(sessions, prefs);
    if (!candidate || candidate.alive !== true) return;
    const projectName = candidate.projectName || projects.find((p) => p.id === candidate.projectId)?.name;
    setActiveSession({
      sessionId: candidate.id,
      agentId: candidate.agentId,
      agentName: agents.find((a) => a.id === candidate.agentId)?.name || candidate.agentId,
      projectId: candidate.projectId ?? null,
      projectName: projectName ?? null,
    });
  }, [sessions]);

  useEffect(() => {
    const userId = getCacheUserId(user);
    if (!userId) return;
    saveConsoleCache(userId, { agents, sessions, projects, activeSession });
  }, [user, agents, sessions, projects, activeSession]);

  return {
    agents,
    setAgents,
    projects,
    setProjects,
    sessions,
    setSessions,
    activeSession,
    setActiveSession,
    fetchWorkspaces,
    fetchAgents,
  };
}
