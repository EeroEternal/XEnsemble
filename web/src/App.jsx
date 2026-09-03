import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import Login from './pages/Login';
import Sessions from './pages/Sessions';
import History from './pages/History';
import SkillsMarket from './pages/SkillsMarket';
import MySkills from './pages/MySkills';
import AgentsAdmin from './pages/AgentsAdmin';
import ImagesManager from './pages/ImagesManager';
import UsersAdmin from './pages/UsersAdmin';
import GatewayAdmin from './pages/GatewayAdmin';
import AppSidebar from './components/AppSidebar';
import BrandMark from './components/BrandMark';
import ConfirmDialog from './components/ConfirmDialog';
import WorkspaceSwitcher from './components/WorkspaceSwitcher';
import SettingsTabSidebar from './components/SettingsTabSidebar';
import SettingsShell from './components/settings/SettingsShell';
import { useWorkspaces } from './hooks/useWorkspaces';
import { cn } from './lib/utils';
import { APP_SHELL_MAIN_PY_CLASS, APP_SHELL_PAD_CLASS } from './lib/appShellLayout';
import { bgCanvas, consoleButtonFocusClass } from './lib/consoleTokens';
import { getAccessToken, setTokens, clearTokens, apiFetch, isStoredAuthStale, setAuthExpiredHandler, getStoredUser, setStoredUser, clearStoredUser } from './lib/api';
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
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const sessionsRef = useRef(null);
  const [launchPanelOpen, setLaunchPanelOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState('general');
  const handleSettingsSectionChange = useCallback((section) => {
    setSettingsSection(section);
    if (location.pathname !== '/settings') navigate('/settings');
  }, [navigate, location.pathname]);
  const isAdmin = user?.role === 'admin';
  const effectiveSettingsSection =
    settingsSection === 'api-keys' ? (isAdmin ? 'general' : 'git')
    : (!isAdmin && settingsSection === 'general') ? 'git'
    : settingsSection;
  const activeWorkspaceName = projects.find((p) => p.id === activeWorkspaceId)?.name || null;

  useEffect(() => {
    setLaunchPanelOpen(false);
    sessionsRef.current?.closeLaunchModal?.();
  }, [location.pathname]);

  const isSessions = location.pathname === '/sessions';
  const isHistory = location.pathname === '/history';
  const isSkillsMarket = location.pathname === '/skills';
  const isMySkills = location.pathname === '/skills/mine';
  const isAgentsAdmin = location.pathname === '/admin/agents';
  const isUsersAdmin = location.pathname === '/admin/users';
  const isGatewayAdmin = location.pathname === '/admin/gateway';
  const isImagesAdmin = location.pathname === '/admin/images';
  const isCustomImages = location.pathname === '/custom-images';
  const isImagesManager = isCustomImages || isImagesAdmin;
  const isSettingsPage = location.pathname === '/settings';

  const isSettingsRoute = isAgentsAdmin || isUsersAdmin || isGatewayAdmin || isImagesManager || isSettingsPage;

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
        className="shrink-0 h-12 border-b border-zinc-200 bg-surface flex items-center px-4 gap-3 relative z-30"
      >
        <BrandMark className="h-7 w-7 shrink-0" iconClassName="h-3.5 w-3.5" />
        <div className="flex flex-col shrink-0 leading-tight">
          <span className="text-sm font-bold text-zinc-900">AgentHarness</span>
          <span className="text-[10px] text-zinc-400 font-medium -mt-0.5 flex justify-between">
            <span>Yuma</span>
            <span>Engineering</span>
          </span>
        </div>
        {isSettingsRoute ? (
          <div className="flex-1 min-w-0 flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/sessions')}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 ${consoleButtonFocusClass}`}
              title={t('sessions:action.back_to_workspaces')}
            >
              <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.75} />
              {t('sessions:action.back_to_workspaces')}
            </button>
          </div>
        ) : (
          <>
            {/* Workspace switcher lives in the global top bar (all routes), so
                /history, /skills etc. never lose access to the active workspace.
                Session-specific controls (branch/restart/preview) portal into
                #xe-topbar-dynamic below and only render on /sessions. */}
            <WorkspaceSwitcher
              projects={projects}
              activeWorkspaceId={activeWorkspaceId}
              sessions={sessions}
              onSelect={switchWorkspace}
              onCreate={() => { setLaunchPanelOpen(true); sessionsRef.current?.openLaunchModal?.('workspace'); }}
              onDelete={(ws) => sessionsRef.current?.requestDeleteWorkspace?.(ws)}
            />
            <div id="xe-topbar-dynamic" className="flex-1 min-w-0 flex items-center justify-between gap-3" />
          </>
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
        onNewSession={() => { setLaunchPanelOpen(true); sessionsRef.current?.openLaunchModal?.('session'); }}
        onRequestDeleteSession={(session, ws) => sessionsRef.current?.requestDeleteSession?.(session, ws)}
        user={user}
        onOpenSettings={() => navigate('/settings')}
        onLogout={logout}
        onOpenHistory={() => navigate('/history')}
        onOpenSkills={() => navigate('/skills')}
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
            // Only the sessions route occupies layout. The launch modal portals
            // to document.body, so opening New Session from History/Skills must
            // NOT bring the Sessions page into the flex flow (would split the
            // screen 50/50 with the current page).
            isSessions ? 'relative z-20' : offRouteClass,
          )}
          aria-hidden={!isSessions}
        />
        <History
          agents={agents}
          projects={projects}
          className={cn(
            'flex h-full min-h-0 flex-1 flex-col',
            isHistory ? 'relative z-20' : offRouteClass,
          )}
          aria-hidden={!isHistory}
        />
        <SkillsMarket
          className={cn(
            'flex h-full min-h-0 flex-1 flex-col',
            isSkillsMarket ? 'relative z-20' : offRouteClass,
          )}
          aria-hidden={!isSkillsMarket}
        />
        <MySkills
          className={cn(
            'flex h-full min-h-0 flex-1 flex-col',
            isMySkills ? 'relative z-20' : offRouteClass,
          )}
          aria-hidden={!isMySkills}
        />
        {user?.role === 'admin' && isAgentsAdmin && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-row overflow-hidden',
                launchPanelOpen ? offRouteClass : 'relative z-10',
              )}
            >
              <SettingsTabSidebar activeTab="agents" onSectionChange={handleSettingsSectionChange} user={user} onOpenSettings={null} onLogout={logout} />
              <div className={cn('flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden', APP_SHELL_PAD_CLASS, APP_SHELL_MAIN_PY_CLASS)}>
                <AgentsAdmin />
              </div>
            </div>
        )}
        {user?.role === 'admin' && isUsersAdmin && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-row overflow-hidden',
                launchPanelOpen ? offRouteClass : 'relative z-10',
              )}
            >
              <SettingsTabSidebar activeTab="users" onSectionChange={handleSettingsSectionChange} user={user} onOpenSettings={null} onLogout={logout} />
              <div className={cn('flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden', APP_SHELL_PAD_CLASS, APP_SHELL_MAIN_PY_CLASS)}>
                <UsersAdmin />
              </div>
            </div>
        )}
        {user?.role === 'admin' && isGatewayAdmin && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-row overflow-hidden',
                launchPanelOpen ? offRouteClass : 'relative z-10',
              )}
            >
              <SettingsTabSidebar activeTab="gateway" onSectionChange={handleSettingsSectionChange} user={user} onOpenSettings={null} onLogout={logout} />
              <div className={cn('flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden', APP_SHELL_PAD_CLASS, APP_SHELL_MAIN_PY_CLASS)}>
                <GatewayAdmin />
              </div>
            </div>
        )}
        {isImagesManager && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-row overflow-hidden',
                launchPanelOpen ? offRouteClass : 'relative z-10',
              )}
            >
              <SettingsTabSidebar activeTab="images" onSectionChange={handleSettingsSectionChange} user={user} onOpenSettings={null} onLogout={logout} />
              <div className={cn('flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden', APP_SHELL_PAD_CLASS, APP_SHELL_MAIN_PY_CLASS)}>
                <ImagesManager />
              </div>
            </div>
        )}
        {isSettingsPage && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-row overflow-hidden',
                launchPanelOpen ? offRouteClass : 'relative z-10',
              )}
            >
              <SettingsTabSidebar activeTab={effectiveSettingsSection} onSectionChange={handleSettingsSectionChange} user={user} onOpenSettings={null} onLogout={logout} />
              <div className={cn('flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden', APP_SHELL_PAD_CLASS, APP_SHELL_MAIN_PY_CLASS)}>
                <SettingsShell section={effectiveSettingsSection} />
              </div>
            </div>
        )}
      </main>
      </div>
      <ConfirmDialog />
    </div>
  );
}

function App() {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const navigate = useNavigate();
  const { t } = useTranslation();

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
      clearStoredUser();
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
      const userRaw = getStoredUser();
      if (userRaw) {
        try { storedUser = JSON.parse(userRaw); } catch { storedUser = null; }
      }

      if (accessToken && isStoredAuthStale()) {
        clearTokens();
        clearStoredUser();
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
            clearStoredUser();
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
    setStoredUser(user);
    setToken(accessToken);
    setUser(user);
    navigate('/sessions', { replace: true });
  };

  const logout = async () => {
    await clearTokens();
    clearStoredUser();
    setToken(null);
    setUser(null);
    navigate('/login', { replace: true });
  };

  if (!authReady) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-100">
        <div className="text-sm text-zinc-500">{t('common:state.loading')}</div>
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
                  />
                ) : (
                  <Navigate to="/login" replace />
                )
              }
            >
              <Route path="/sessions" element={null} />
              <Route path="/history" element={null} />
              <Route path="/skills" element={null} />
              <Route path="/skills/mine" element={null} />
              <Route path="/settings" element={null} />
              <Route
                path="/custom-images"
                element={user?.role === 'admin' ? null : <Navigate to="/sessions" replace />}
              />
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
                element={user?.role === 'admin' ? null : <Navigate to="/sessions" replace />}
              />
            </Route>

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
