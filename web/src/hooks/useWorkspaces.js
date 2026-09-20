import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch, getAccessToken, refreshAccessToken } from '../lib/api';
import {
  readBootstrapConsoleState,
  readInitialConsoleState,
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
// 侧栏「显示循环任务会话」开关的持久化 key（开启后列表并入 source=loop_task 会话）
const SHOW_LOOP_SESSIONS_KEY = 'xe_show_loop_sessions';

function loadShowLoopSessions() {
    try {
        return window.localStorage.getItem(SHOW_LOOP_SESSIONS_KEY) === '1';
    } catch {
        return false;
    }
}

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

  // The "current workspace" context. Follows the active session's project,
  // but can be switched independently (clears the active session view without
  // stopping the underlying session).
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(null);
  // Latch set when the user explicitly switches workspace so the auto-restore
  // effect below doesn't immediately re-pick a session for the new workspace.
  const userSwitchedWorkspaceRef = useRef(false);

  // True after the first workspaces fetch resolves, so consumers can tell an
  // genuinely-empty workspace list apart from the initial pre-fetch state.
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  // 循环任务会话默认不进列表（与后端 source 过滤对齐）；开关持久化到 localStorage。
  const [showLoopSessions, setShowLoopSessionsState] = useState(loadShowLoopSessions);
  const setShowLoopSessions = useCallback((v) => {
    setShowLoopSessionsState(Boolean(v));
    try {
      window.localStorage.setItem(SHOW_LOOP_SESSIONS_KEY, v ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  // SPA 登录/登出不会整页刷新，bootstrap 单例在上一账号会话期就已生成。
  // 账号切换时必须用当前用户自己的缓存桶重新播种，否则会带着上一账号的
  // 会话/项目 id 发请求 → 404「项目不存在」（getProjectForUser 归属校验失败）。
  const seededForUserRef = useRef(null);
  useEffect(() => {
    const uid = user?.id ? String(user.id) : null;
    if (!uid || seededForUserRef.current === uid) return;
    seededForUserRef.current = uid;
    const fresh = readInitialConsoleState(user);
    setAgents(fresh.agents);
    setSessions(fresh.sessions);
    setProjects(fresh.projects);
    setActiveSession(null);
    setActiveWorkspaceId(null);
    setProjectsLoaded(false);
  }, [user]);

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
          defaultCustomImageId: p.default_custom_image_id ?? p.defaultCustomImageId ?? null,
        })));
      }
    } catch {
      // ignore transient errors
    } finally {
      setProjectsLoaded(true);
    }
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await apiFetch(showLoopSessions ? '/api/v1/sessions?include_loop_tasks=1' : '/api/v1/sessions');
      const data = await res.json();
      if (Array.isArray(data)) setSessions(data);
    } catch {
      // ignore transient errors
    }
  }, [showLoopSessions]);

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
        } else if (data.type === 'deploy_finished') {
          // 跨 session 部署完成：刷新数据 + 通知页面级监听（toast / 跳转）
          fetchProjects();
          fetchSessions();
          window.dispatchEvent(new CustomEvent('xensemble:deploy_finished', { detail: data }));
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
    // User just switched workspace: leave the view empty for them to pick.
    if (userSwitchedWorkspaceRef.current) return;
    const prefs = loadSidebarPrefs();
    const scoped = (activeWorkspaceId
      ? sessions.filter((s) => s.projectId === activeWorkspaceId)
      : sessions
    ).filter((s) => s.source !== 'loop_task');
    const candidate = pickSessionToRestore(scoped, prefs);
    if (!candidate || candidate.alive !== true) return;
    // 会话所属工作区必须仍存在：项目在 API 之外被删/环境重置后，sessions 列表
    // 可能残留指向已删项目的会话，恢复它会让顶部面板带着死 projectId 发请求
    // → 404「项目不存在」toast。
    if (candidate.projectId && projectsLoaded && !projects.some((p) => p.id === candidate.projectId)) return;
    const projectName = candidate.projectName || projects.find((p) => p.id === candidate.projectId)?.name;
    setActiveSession({
      sessionId: candidate.id,
      agentId: candidate.agentId,
      agentName: agents.find((a) => a.id === candidate.agentId)?.name || candidate.agentId,
      projectId: candidate.projectId ?? null,
      projectName: projectName ?? null,
    });
  }, [sessions, activeWorkspaceId, projects, projectsLoaded]);

  // 已恢复的会话若所属工作区消失（项目被删/环境重置），同样清掉，避免顶部面板
  // 持续用死 projectId 轮询（BranchSwitcher/DeployPanel/文件树都吃 activeSession.projectId）。
  useEffect(() => {
    if (!activeSession?.projectId || !projectsLoaded) return;
    if (projects.some((p) => p.id === activeSession.projectId)) return;
    setActiveSession(null);
    const userId = getCacheUserId(user);
    if (userId) saveConsoleCache(userId, { agents, sessions, projects, activeSession: null });
  }, [activeSession?.projectId, projects, projectsLoaded, user, agents, sessions]);

  // activeWorkspaceId follows the active session's project so the sidebar
  // and header stay in sync when a session is selected/restored.
  // Re-sync even when activeWorkspaceId was reset (e.g. by the deleted-workspace
  // fallback) so the active session's project always wins.
  useEffect(() => {
    if (activeSession?.projectId && activeSession.projectId !== activeWorkspaceId) {
      setActiveWorkspaceId(activeSession.projectId);
    }
  }, [activeSession?.projectId, activeWorkspaceId]);

  // Clear the user-switched latch once a session becomes active again.
  useEffect(() => {
    if (activeSession) userSwitchedWorkspaceRef.current = false;
  }, [activeSession]);

  // Pick a default workspace when none is set yet (recent session -> latest).
  useEffect(() => {
    if (activeWorkspaceId) return;
    if (projects.length === 0) return;
    const prefs = loadSidebarPrefs();
    for (const sessionId of prefs.recentSessionIds || []) {
      const snap = prefs.recentSessionSnapshots?.[sessionId];
      if (snap?.projectId && projects.some((p) => p.id === snap.projectId)) {
        setActiveWorkspaceId(snap.projectId);
        return;
      }
    }
    const latest = [...projects].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    if (latest) setActiveWorkspaceId(latest.id);
  }, [projects, activeWorkspaceId]);

  // If the current workspace is deleted, fall back to the latest remaining.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (projects.some((p) => p.id === activeWorkspaceId)) return;
    const latest = [...projects].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    setActiveWorkspaceId(latest?.id || null);
  }, [projects, activeWorkspaceId]);

  // Switch the current workspace without stopping the previous session:
  // just clear the active view and let the user pick one in the new workspace.
  const switchWorkspace = useCallback((workspaceId) => {
    userSwitchedWorkspaceRef.current = true;
    setActiveWorkspaceId(workspaceId);
    setActiveSession(null);
  }, []);

  useEffect(() => {
    const userId = getCacheUserId(user);
    if (!userId) return;
    saveConsoleCache(userId, { agents, sessions, projects, activeSession });
  }, [user, agents, sessions, projects, activeSession]);

  // 占用并发额度的会话标记已移至 AppSidebar 内部轮询（避免经 props 传递导致 esbuild 不重命名 → ReferenceError）

  return {
    agents,
    setAgents,
    projects,
    setProjects,
    projectsLoaded,
    sessions,
    setSessions,
    activeSession,
    setActiveSession,
    activeWorkspaceId,
    switchWorkspace,
    showLoopSessions,
    setShowLoopSessions,
    fetchWorkspaces,
    fetchAgents,
  };
}
