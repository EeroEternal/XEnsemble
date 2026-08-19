import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import Login from './pages/Login';
import Sessions from './pages/Sessions';
import AgentsAdmin from './pages/AgentsAdmin';
import ImagesManager from './pages/ImagesManager';
import UsersAdmin from './pages/UsersAdmin';
import GatewayAdmin from './pages/GatewayAdmin';
import AppSidebar from './components/AppSidebar';
import BrandMark from './components/BrandMark';
import SettingsModal from './components/SettingsModal';
import ConfirmDialog from './components/ConfirmDialog';
import { useWorkspaces } from './hooks/useWorkspaces';
import { cn } from './lib/utils';
import { APP_SHELL_ADMIN_CLASS } from './lib/appShellLayout';
import { bgCanvas, consoleButtonFocusClass } from './lib/consoleTokens';
import { getAccessToken, setTokens, clearTokens, apiFetch, isStoredAuthStale, setAuthExpiredHandler } from './lib/api';
import { TerminalThemeProvider } from './hooks/useTerminalTheme.jsx';

export const AuthContext = React.createContext(null);

function AuthenticatedLayout({
  token,
  user,
  agents,
  projects,
  setProjects,
  projectsLoaded,
  sessions,
  setSessions,
  activeSession,
  setActiveSession,
  activeWorkspaceId,
  switchWorkspace,
  fetchWorkspaces,
  fetchAgents,
  logout,
  showSettingsModal,
  setShowSettingsModal,
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const sessionsRef = useRef(null);
  const [launchPanelOpen, setLaunchPanelOpen] = useState(false);
  const activeWorkspaceName = projects.find((p) => p.id === activeWorkspaceId)?.name || null;

  useEffect(() => {
    setLaunchPanelOpen(false);
    sessionsRef.current?.closeLaunchModal?.();
  }, [location.pathname]);

  const isSessions = location.pathname === '/sessions';
  const isAgentsAdmin = location.pathname === '/admin/agents';
  const isUsersAdmin = location.pathname === '/admin/users';
  const isGatewayAdmin = location.pathname === '/admin/gateway';
  const isImagesAdmin = location.pathname === '/admin/images';
  const isCustomImages = location.pathname === '/custom-images';
  const isImagesManager = isCustomImages || isImagesAdmin;

  const isSettingsRoute = isAgentsAdmin || isUsersAdmin || isGatewayAdmin || isImagesManager;
  const settingsTitle = isImagesManager ? 'Images'
    : isAgentsAdmin ? 'Agents'
    : isUsersAdmin ? 'Users'
    : isGatewayAdmin ? 'Gateway' : '';

  const offRouteClass = 'pointer-events-none invisible absolute inset-0 z-0 [&_*]:pointer-events-none';

  const onSelectSession = useCallback((session) => {
    setLaunchPanelOpen(false);
    sessionsRef.current?.closeLaunchModal?.();
    setActiveSession({
      sessionId: session.id,
      agentId: session.agentId,
      agentName: agents.find((a) => a.id === session.agentId)?.name || session.agentId,
      projectId: session.projectId ?? null,
      projectName: session.projectName ?? null,
    });
    if (location.pathname !== '/sessions') navigate('/sessions');
  }, [setActiveSession, agents, navigate, location.pathname]);

  return (
    <div className={`h-full flex flex-col ${bgCanvas}`}>
      {/* Full-width top bar (above the sidebar). */}
      <div
        className="shrink-0 h-12 border-b border-zinc-200 bg-white flex items-center px-4 gap-3 relative z-30"
      >
        <BrandMark className="h-7 w-7 shrink-0" iconClassName="h-3.5 w-3.5" />
        <span className="text-sm font-bold text-zinc-900 shrink-0">XEnsemble</span>
        {isSettingsRoute ? (
          <div className="flex-1 min-w-0 flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-zinc-500 truncate">{settingsTitle}</span>
            <button
              type="button"
              onClick={() => navigate('/sessions')}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 ${consoleButtonFocusClass}`}
              title="Back to workspace"
            >
              <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.75} />
              Back to workspace
            </button>
          </div>
        ) : (
          <div id="xe-topbar-dynamic" className="flex-1 min-w-0 flex items-center justify-between gap-3" />
        )}
      </div>

      <div className="flex flex-1 min-h-0">
      {!isSettingsRoute && (
      <AppSidebar
        agents={agents}
        sessions={sessions}
        activeSession={activeSession}
        activeWorkspaceId={activeWorkspaceId}
        activeWorkspaceName={activeWorkspaceName}
        onSelectSession={onSelectSession}
        fetchWorkspaces={fetchWorkspaces}
        onNewSession={() => { setLaunchPanelOpen(true); sessionsRef.current?.openLaunchModal?.('session'); }}
        onRequestDeleteSession={(session, ws) => sessionsRef.current?.requestDeleteSession?.(session, ws)}
        onRestartSession={(session) => sessionsRef.current?.restartSession?.(session)}
        user={user}
        onOpenSettings={(section) => setShowSettingsModal(section || 'general')}
        onLogout={logout}
      />
      )}
      <main
        className={`relative flex h-full min-h-0 flex-1 flex-col min-w-0 ${bgCanvas}`}
      >
        <Sessions
          ref={sessionsRef}
          token={token}
          user={user}
          agents={agents}
          projects={projects}
          setProjects={setProjects}
          projectsLoaded={projectsLoaded}
          sessions={sessions}
          setSessions={setSessions}
          activeSession={activeSession}
          setActiveSession={setActiveSession}
          activeWorkspaceId={activeWorkspaceId}
          switchWorkspace={switchWorkspace}
          fetchWorkspaces={fetchWorkspaces}
          fetchAgents={fetchAgents}
          launchPanelOpen={launchPanelOpen}
          onLaunchPanelClose={() => setLaunchPanelOpen(false)}
          className={cn(
            'flex h-full min-h-0 flex-1 flex-col',
            (isSessions || launchPanelOpen) ? 'relative z-20' : offRouteClass,
          )}
          aria-hidden={!isSessions && !launchPanelOpen}
        />
        {user?.role === 'admin' && isAgentsAdmin && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden',
                APP_SHELL_ADMIN_CLASS,
                launchPanelOpen ? offRouteClass : 'relative z-10',
              )}
            >
              <AgentsAdmin />
            </div>
        )}
        {user?.role === 'admin' && isUsersAdmin && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden',
                APP_SHELL_ADMIN_CLASS,
                launchPanelOpen ? offRouteClass : 'relative z-10',
              )}
            >
              <UsersAdmin />
            </div>
        )}
        {user?.role === 'admin' && isGatewayAdmin && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden',
                APP_SHELL_ADMIN_CLASS,
                launchPanelOpen ? offRouteClass : 'relative z-10',
              )}
            >
              <GatewayAdmin />
            </div>
        )}
        {isImagesManager && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden',
                APP_SHELL_ADMIN_CLASS,
                launchPanelOpen ? offRouteClass : 'relative z-10',
              )}
            >
              <ImagesManager />
            </div>
        )}
      </main>
      </div>
      {showSettingsModal && (
        <SettingsModal section={showSettingsModal} onClose={() => setShowSettingsModal(null)} />
      )}
      <ConfirmDialog />
    </div>
  );
}

function App() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(null);

  const openSettings = useCallback((section) => {
    setShowSettingsModal(section || 'general');
  }, []);

  React.useEffect(() => {
    window.addEventListener('xe:open-settings', () => openSettings('general'));
    return () => window.removeEventListener('xe:open-settings', () => openSettings('general'));
  }, [openSettings]);
  const navigate = useNavigate();

  const {
    agents,
    projects,
    setProjects,
    projectsLoaded,
    sessions,
    setSessions,
    activeSession,
    setActiveSession,
    activeWorkspaceId,
    switchWorkspace,
    fetchWorkspaces,
    fetchAgents,
  } = useWorkspaces(user);

  React.useEffect(() => {
    setAuthExpiredHandler(() => {
      localStorage.removeItem('user');
      setToken(null);
      setUser(null);
      navigate('/login', { replace: true });
    });
    return () => setAuthExpiredHandler(null);
  }, [navigate]);

  React.useEffect(() => {
    (async () => {
      const accessToken = getAccessToken();
      let storedUser = null;
      const userRaw = localStorage.getItem('user');
      if (userRaw) {
        try { storedUser = JSON.parse(userRaw); } catch { storedUser = null; }
      }

      if (accessToken && isStoredAuthStale()) {
        clearTokens();
        localStorage.removeItem('user');
        setToken(null);
        setUser(null);
        setAuthReady(true);
        return;
      }

      if (accessToken) {
        try {
          const res = await apiFetch('/api/v1/auth/me');
          if (!res.ok) {
            clearTokens();
            localStorage.removeItem('user');
            setToken(null);
            setUser(null);
            setAuthReady(true);
            return;
          }
          const me = await res.json();
          setToken(getAccessToken());
          setUser(me?.user || (me?.id ? me : null) || storedUser);
          setAuthReady(true);
          return;
        } catch {
          setToken(accessToken);
          setUser(storedUser);
          setAuthReady(true);
          return;
        }
      }

      setToken(null);
      setUser(storedUser);
      setAuthReady(true);
    })();
  }, []);

  const login = async (accessToken, refreshToken, user) => {
    await setTokens(accessToken, refreshToken);
    localStorage.setItem('user', JSON.stringify(user));
    setToken(accessToken);
    setUser(user);
    navigate('/sessions', { replace: true });
  };

  const logout = async () => {
    await clearTokens();
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
    navigate('/login', { replace: true });
  };

  if (!authReady) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-100">
        <div className="text-sm text-zinc-500">Loading…</div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ token, user, login, logout }}>
      <TerminalThemeProvider token={token}>
        <div className="h-full">
          <Routes>
            <Route
              path="/login"
              element={!token ? <Login /> : <Navigate to="/sessions" replace />}
            />

            <Route
              element={
                token ? (
                  <AuthenticatedLayout
                    token={token}
                    user={user}
                    agents={agents}
                    projects={projects}
                    setProjects={setProjects}
                    projectsLoaded={projectsLoaded}
                    sessions={sessions}
                    setSessions={setSessions}
                    activeSession={activeSession}
                    setActiveSession={setActiveSession}
                    activeWorkspaceId={activeWorkspaceId}
                    switchWorkspace={switchWorkspace}
                    fetchWorkspaces={fetchWorkspaces}
                    fetchAgents={fetchAgents}
                    logout={logout}
                    showSettingsModal={showSettingsModal}
                    setShowSettingsModal={setShowSettingsModal}
                  />
                ) : (
                  <Navigate to="/login" replace />
                )
              }
            >
              <Route path="/sessions" element={null} />
              <Route path="/custom-images" element={null} />
              <Route path="/console" element={<Navigate to="/sessions" replace />} />
              <Route
                path="/admin/agents"
                element={user?.role === 'admin' ? null : <Navigate to="/sessions" replace />}
              />
              <Route
                path="/admin/users"
                element={user?.role === 'admin' ? null : <Navigate to="/sessions" replace />}
              />
              <Route
                path="/admin/gateway"
                element={user?.role === 'admin' ? null : <Navigate to="/sessions" replace />}
              />
              <Route
                path="/admin/images"
                element={user?.role === 'admin' ? null : <Navigate to="/custom-images" replace />}
              />
            </Route>

            <Route path="/settings" element={<Navigate to="/sessions" replace />} />
            <Route path="/admin/boxlite-images" element={<Navigate to="/admin/images" replace />} />
            <Route path="/admin/platform" element={<Navigate to="/sessions" replace />} />
            <Route path="/" element={<Navigate to={token ? '/sessions' : '/login'} replace />} />
            <Route path="*" element={<Navigate to={token ? '/sessions' : '/login'} replace />} />
          </Routes>
        </div>
      </TerminalThemeProvider>
    </AuthContext.Provider>
  );
}

export default App;
