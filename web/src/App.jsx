import React, { useState, useRef, useCallback, useEffect, useContext } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import Login from './pages/Login';
import Sessions from './pages/Sessions';
import SkillsMarket from './pages/SkillsMarket';
import MySkills from './pages/MySkills';
import LoopTasks from './pages/LoopTasks';
import LoopRunDetail from './pages/LoopRunDetail';
import AgentsAdmin from './pages/AgentsAdmin';
import ImagesManager from './pages/ImagesManager';
import UsersAdmin from './pages/UsersAdmin';
import GatewayAdmin from './pages/GatewayAdmin';
import ObservabilityPage from './pages/Observability';
import AppSidebar from './components/AppSidebar';
import BrandMark from './components/BrandMark';
import ConfirmDialog from './components/ConfirmDialog';
import WorkspaceSwitcher from './components/WorkspaceSwitcher';
import SettingsTabSidebar, { defaultSettingsSection } from './components/SettingsTabSidebar';
import SettingsShell from './components/settings/SettingsShell';
import { useWorkspaces } from './hooks/useWorkspaces';
import { cn } from './lib/utils';
import { APP_SHELL_MAIN_PY_CLASS, APP_SHELL_PAD_CLASS } from './lib/appShellLayout';
import { bgCanvas, consoleButtonFocusClass } from './lib/consoleTokens';
import { getAccessToken, setTokens, clearTokens, apiFetch, isStoredAuthStale, setAuthExpiredHandler, getStoredUser, setStoredUser, clearStoredUser } from './lib/api';
import { setSessionContext } from './lib/sessionContext';
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
  const [settingsSection, setSettingsSection] = useState(
    () => defaultSettingsSection(user?.role === 'admin'),
  );
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
  const isMySkills = location.pathname === '/skills';
  const isSkillsMarket = location.pathname === '/skills/market';
  const isSkillsManager = isMySkills || isSkillsMarket;
  const isLoopTasks = location.pathname === '/loop-tasks';
  const isLoopRunDetail = /^\/loop-tasks\/[^/]+\/runs\/[^/]+$/.test(location.pathname);
  const isAgentsAdmin = location.pathname === '/admin/agents';
  const isUsersAdmin = location.pathname === '/admin/users';
  const isGatewayAdmin = location.pathname === '/admin/gateway';
  const isObservabilityPage = location.pathname === '/observability';
  const isImagesAdmin = location.pathname === '/admin/images';
  const isCustomImages = location.pathname === '/custom-images';
  const isImagesManager = isCustomImages || isImagesAdmin;
  const isSettingsPage = location.pathname === '/settings';

  const isSettingsRoute = isAgentsAdmin || isUsersAdmin || isGatewayAdmin || isObservabilityPage || isImagesManager || isSkillsManager || isSettingsPage;

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
    <div className={`h-full flex ${bgCanvas}`}>
      {/* 侧边栏独占全高列（分隔线贯穿到顶），logo 与折叠按钮锚在侧栏头部（Claude.ai/Notion 模式）。 */}
      {!isSettingsRoute && (
      <AppSidebar
        agents={agents}
        sessions={sessions}
        activeSession={activeSession}
        activeWorkspaceId={activeWorkspaceId}
        activeWorkspaceName={activeWorkspaceName}
        onSelectSession={onSelectSession}
        onNewSession={() => { setLaunchPanelOpen(true); sessionsRef.current?.openLaunchModal?.('session'); }}
        onRequestDeleteSession={(session, ws, action) => sessionsRef.current?.requestDeleteSession?.(session, ws, action)}
        user={user}
        onOpenSettings={() => navigate('/settings')}
        onOpenObservability={() => navigate('/observability')}
        onLogout={logout}
        onOpenLoopTasks={() => navigate('/loop-tasks')}
      />
      )}
      {/* 右列：内容区顶栏 + 页面。设置路由下侧栏隐藏，logo 回到顶栏。 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div
          className="shrink-0 h-12 border-b border-zinc-200 bg-surface flex items-center px-4 gap-3 relative z-30"
        >
          {isSettingsRoute ? (
            <>
              <BrandMark className="h-7 w-7 shrink-0" iconClassName="h-3.5 w-3.5" />
              <div className="flex flex-col shrink-0 leading-tight">
                <span className="text-sm font-bold text-zinc-900">AgentHarness</span>
                <span className="text-[10px] text-zinc-400 font-medium -mt-0.5 flex justify-between">
                  <span>Yuma</span>
                  <span>Engineering</span>
                </span>
              </div>
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
            </>
          ) : (
            <>
              {/* Workspace switcher lives in the content top bar (all routes), so
                  /trajectory, /skills etc. never lose access to the active workspace.
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
        <main
          className={`relative flex min-h-0 flex-1 flex-col min-w-0 overflow-hidden ${bgCanvas}`}
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
        <LoopTasks
          className={cn(
            'flex h-full min-h-0 flex-1 flex-col',
            isLoopTasks ? 'relative z-20' : offRouteClass,
          )}
          aria-hidden={!isLoopTasks}
        />
        {isLoopRunDetail && (
          <LoopRunDetail className="flex h-full min-h-0 flex-1 flex-col relative z-20" />
        )}
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
        {isObservabilityPage && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-row overflow-hidden',
                launchPanelOpen ? offRouteClass : 'relative z-10',
              )}
            >
              <ObservabilityPage user={user} onLogout={logout} />
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
        {isSkillsManager && (
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-row overflow-hidden',
                launchPanelOpen ? offRouteClass : 'relative z-10',
              )}
            >
              <SettingsTabSidebar activeTab="skills" onSectionChange={handleSettingsSectionChange} user={user} onOpenSettings={null} onLogout={logout} />
              {isMySkills ? (
                <div className={cn('flex min-h-0 flex-1 flex-col overflow-auto console-scroll-hidden', APP_SHELL_PAD_CLASS, APP_SHELL_MAIN_PY_CLASS)}>
                  <MySkills />
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <SkillsMarket />
                </div>
              )}
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

/** /admin/usage → /observability?section=usage，保留 ?user= 深链参数。 */
function UsageRedirect() {
  const { user } = useContext(AuthContext);
  const location = useLocation();
  if (user?.role !== 'admin') return <Navigate to="/sessions" replace />;
  const params = new URLSearchParams(location.search);
  params.set('section', 'usage');
  return <Navigate to={`/observability?${params.toString()}`} replace />;
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
    // 模块级 sessionContext 是 SPA 单例，登出必须清掉，否则下一个账号
    // 的 API 调用会带上一个账号的 session_id →「会话不存在」。
    setSessionContext(null);
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
              <Route path="/trajectory" element={<Navigate to="/sessions" replace />} />
              <Route path="/history" element={<Navigate to="/sessions" replace />} />
              <Route path="/skills" element={null} />
              <Route path="/skills/market" element={null} />
              <Route path="/loop-tasks" element={null} />
              <Route path="/loop-tasks/:taskId/runs/:runId" element={null} />
              <Route path="/settings" element={null} />
              <Route path="/observability" element={null} />
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
                path="/admin/usage"
                element={<UsageRedirect />}
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
