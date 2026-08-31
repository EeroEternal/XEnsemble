import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import AgentConsole from '../components/AgentConsole';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';
import WorkspaceShell from '../components/WorkspaceShell';
import WorkspacePanel from '../components/WorkspacePanel';
import RepoImportDialog from '../components/git/RepoImportDialog';
import OnboardingWizard from '../components/OnboardingWizard';
import CreationProgress from '../components/CreationProgress';
import BranchSwitcher, { GIT_REPO_PROVIDERS } from '../components/git/BranchSwitcher';
import { apiFetch } from '../lib/api';
import * as githubApi from '../lib/githubApi';
import * as gitApi from '../lib/gitApi';
import { generateWorkBranchName } from '../lib/gitApi';
import { setSessionContext, withSessionId } from '../lib/sessionContext';
import {
  ConsoleDialogShell,
  ConsoleInlineDialog,
} from '../components/ConsoleDialog';
import { useToast } from '../components/Toast';
import { useTerminalTheme } from '../hooks/useTerminalTheme.jsx';
import { useEditorTabs } from '../hooks/useEditorTabs';
import { useGitChanges } from '../hooks/useGitChanges';
import { usePreview, PreviewControlGroup } from '../components/PreviewPanel';
import DeployPanel from '../components/DeployPanel';
import {
  TerminalSquare,
  Play,
  RotateCw,
  Settings2,
  X,
  Power,
  FileText,
  Loader2,
  Trash2,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import ByokConfigForm from '../components/ByokConfigForm';
import LanguageToggle from '../components/LanguageToggle';
import { formatQuotaExceeded } from '../lib/quotaLabels';
import {
  archiveSession,
  loadSidebarPrefs,
  purgeWorkspaceSidebarPrefs,
  rememberRecentSession,
  replaceRecentSessionId,
  sortAgentsByRecentUsage,
  rememberRecentAgent,
} from '../lib/sidebarPrefs';
import {
  consoleDialogPanelClass,
  consoleStructuredDialogHeaderClass,
  consoleStructuredDialogFooterClass,
  consoleStructuredDialogBodyClass,
  consoleIconButtonClass,
  bgCanvas,
  textPrimary,
  textSecondary,
  textTertiary,
  textPlaceholder,
  borderHairline,
  transitionBase,
  hoverBgSecondary,
  hoverBgTertiary,
  hoverTextPrimary,
} from '../lib/consoleTokens';
import { pathParent, pathJoin } from '../lib/workspaceFileTree';
import { useTranslation } from 'react-i18next';

const DEFAULT_AGENT_ID = 'kimi-code';

function pickDefaultAgentId(agents, preferredId) {
  if (preferredId && agents.some((a) => a.id === preferredId)) return preferredId;
  const preferred = agents.find((a) => a.id === DEFAULT_AGENT_ID) || agents[0];
  return preferred?.id || '';
}

const SLUG_WORDS = [
  'small', 'heavy', 'many', 'quiet', 'swift', 'bright', 'calm', 'bold', 'brave', 'clear',
  'dark', 'fast', 'fresh', 'grand', 'keen', 'light', 'neat', 'proud', 'sharp', 'warm',
];

function defaultWorkspaceName() {
  const pick = () => SLUG_WORDS[Math.floor(Math.random() * SLUG_WORDS.length)];
  return `${pick()}-${pick()}`;
}

export default React.forwardRef(function Sessions({
  /* token, user kept for API compat */
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
  launchPanelOpen,
  onLaunchPanelClose,
  className,
}, ref) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const goToSessions = useCallback(() => {
    if (location.pathname !== '/sessions') navigate('/sessions');
  }, [location.pathname, navigate]);

  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [launchModalMode, setLaunchModalMode] = useState('workspace');
  const [launchWorkspaceId, setLaunchWorkspaceId] = useState('');
  const [projectCreating, setProjectCreating] = useState(false);
  const [launchModalError, setLaunchModalError] = useState(null);
  const [startSessionAfterCreate, setStartSessionAfterCreate] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [launchingSession, setLaunchingSession] = useState(false);
  // eslint-disable-next-line no-unused-vars
  const [_error, setError] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(() => {
    const maxW = typeof window !== 'undefined' ? Math.max(720, window.innerWidth - 240) : 800;
    return Math.min(Math.floor(maxW / 2), maxW);
  });
  // 拖拽调整宽度时禁用 width 过渡，避免每次 setPanelWidth 都触发 150ms 动画导致拖拽滞后
  const [panelDragging, setPanelDragging] = useState(false);
  const panelRowRef = useRef(null);
  // 拖拽期间禁用面板容器指针事件：DeployPanel 的预览是 iframe，会吞掉 mousemove/mouseup，
  // 导致拖拽冻结或面板跟着 iframe 内部行为乱跑；pointer-events:none 让事件穿透到父窗口。
  const panelContainerRef = useRef(null);
  const [skipPendingSpinner, setSkipPendingSpinner] = useState(false);

  // Measure actual container width for true 1:1 ratio (sidebar width varies)
  useLayoutEffect(() => {
    const measure = () => {
      if (panelRowRef.current) {
        const w = panelRowRef.current.offsetWidth;
        if (w > 0) setPanelWidth(Math.floor(w / 2));
      }
    };
    measure();
    const timer = setTimeout(measure, 100);
    return () => clearTimeout(timer);
  }, []);
  const resizingRef = useRef(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [viewingFile, setViewingFile] = useState(null);
  const [fileContent, setFileContent] = useState('');

  // Compute session liveness early so we can gate VM-triggering API calls
  // (git status polling, file tree listing) on the session being actually
  // running.  When the session is idle/pending, starting these polls would
  // trigger ensureProjectRuntime on the server, which creates a box-base VM
  // that is then torn down and recreated with an agent image when the
  // session resumes — causing 30-60s of unnecessary double VM provisioning.
  const activeSessionMeta = useMemo(
    () => sessions.find((s) => s.id === activeSession?.sessionId) || null,
    [sessions, activeSession?.sessionId],
  );
  const sessionAlive = activeSessionMeta?.alive === true;

  // Sync session context so all API calls (git, files, deploy) include session_id
  // for correct runtime/worktree routing.
  useEffect(() => {
    setSessionContext(activeSession?.sessionId || null);
  }, [activeSession?.sessionId]);

  const editorTabs = useEditorTabs(activeSession?.projectId, activeSession?.sessionId, sessionAlive || skipPendingSpinner);
  // Changes 与 Files 共用同一 workspace attach 路径；不能再按 sessionAlive 关掉，
  // 否则编辑器已能保存、Changes 却一直空白（分支显示 —）。
  const changesTabActiveRef = useRef(false);
  const gitChanges = useGitChanges(activeSession?.projectId || null, changesTabActiveRef, activeSession?.sessionId, sessionAlive || skipPendingSpinner);
  const preview = usePreview(activeSession?.projectId, Boolean(activeSession?.projectId), activeSession?.sessionId);
  const { showToast } = useToast();
  // 跨 session 部署完成提示（由 useWorkspaces 的 SSE 转发）：即使不在该 session 页也提示
  useEffect(() => {
    const onDeployFinished = (e) => {
      const d = e.detail;
      if (!d || typeof d.ok !== 'boolean') return;
      const ws = d.projectName || d.projectId || '';
      const ss = d.sessionName || d.sessionId || '';
      // workspace + session 加粗放在最前，便于一眼看清是哪个工作区的哪个会话
      const head = (
        <b>
          {t('deploy:toast.ws_label')}「{ws}」- {t('deploy:toast.sess_label')}「{ss}」
        </b>
      );
      const tail = d.ok
        ? t('deploy:toast.finished_text')
        : d.aborted
          ? t('deploy:toast.aborted_text')
          : t('deploy:toast.failed_text');
      // 部署完成提示 8s（默认成功 4s 太短），便于看清
      showToast(d.ok ? 'success' : 'error', <>{head} {tail}</>, { durationMs: 8000 });
    };
    window.addEventListener('xensemble:deploy_finished', onDeployFinished);
    return () => window.removeEventListener('xensemble:deploy_finished', onDeployFinished);
  }, [showToast]);
  const panelRef = useRef(null);
  const deployPanelRef = useRef(null);
  const shellRef = useRef(null);
  // 每次点小火箭自增，用于强制 DeployPanel remount（重新分析），而不是复用上次内容
  const [deployVersion, setDeployVersion] = useState(0);
  // 切换项目时重置部署版本：不把上次的"主动部署"信号带到新项目（避免跨 session 误触发部署）
  useEffect(() => {
    setDeployVersion(0);
  }, [activeSession?.projectId]);
  // 切换 session 时重置部署状态：右上角状态/Stop 按钮属于当前 session 的部署
  useEffect(() => {
    setDeployStatus('idle');
    setAbortRequested(false);
  }, [activeSession?.sessionId]);
  // 当前会话的部署状态（idle/running/finished/aborted），驱动右上角状态与中止按钮
  const [deployStatus, setDeployStatus] = useState('idle');
  // 中止信号：点 Stop 时置 true，让 DeployPanel 立即显示"已中止"（不等后端 abort 返回）
  const [abortRequested, setAbortRequested] = useState(false);
  // 部署成功：就地显示预览（DeployPanel 内嵌 WorkspacePreviewPane），不再弹出 preview tab
  const onDeploySuccess = useCallback(() => {
    preview.loadDeployments();
  }, [preview.loadDeployments]);

  // 中止部署：通知后端 abort（杀 verify agent / 停隧道），前端立即置 aborted（界面立即显示"已中止"）
  const handleCancelDeploy = useCallback(async () => {
    const pid = activeSession?.projectId;
    setDeployStatus('aborted');
    setAbortRequested(true);
    if (!pid) return;
    try {
      await apiFetch(withSessionId(`/api/v1/projects/${encodeURIComponent(pid)}/deploy/cancel`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
    } catch { /* ignore */ }
  }, [activeSession?.projectId]);

  // 方案 B：deployStatus 不永久凝固——它是一次性"部署动作"状态，成功后若预览资源已消失
  // （stopped/expired/被回收 → usePreview 的 status 变为 none 或 stopped），则重置回 idle，
  // 避免右上角永久残留「已完成」徽章与底下的 Deploy 按钮自相矛盾。
  const previewStatus = preview.status;
  useEffect(() => {
    if (deployStatus === 'finished' || deployStatus === 'aborted') {
      if (previewStatus === 'none' || previewStatus === 'stopped') {
        setDeployStatus('idle');
      }
    }
  }, [deployStatus, previewStatus]);

  const [gitDiffView, setGitDiffView] = useState(null);

  const [configEnvVars, setConfigEnvVars] = useState([{ key: '', value: '' }]);
  const [savedConfigKeys, setSavedConfigKeys] = useState({});
  const configModalInitialKeysRef = useRef(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState(null);
  const { themeId, preset } = useTerminalTheme();
  // eslint-disable-next-line no-unused-vars
  const [_deletingSessionId, setDeletingSessionId] = useState(null);
  const [restartingSession, setRestartingSession] = useState(false);
  const [reconnectVersion, setReconnectVersion] = useState(0);
  const [deleteConfirmSession, setDeleteConfirmSession] = useState(null);
  const [deleteConfirmWorkspace, setDeleteConfirmWorkspace] = useState(null);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState(null);

  const [showNewInstanceModal, setShowNewInstanceModal] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);

  // Portal target for the session header (rendered into the full-width top bar
  // provided by App.jsx). Null until mounted; the portal renders once available.
  const isSessionsRoute = location.pathname === '/sessions';
  const topbarVisible = isSessionsRoute || launchPanelOpen;
  const [topbarEl, setTopbarEl] = useState(null);
  useEffect(() => {
    if (!topbarVisible) { setTopbarEl(null); return; }
    const el = document.getElementById('xe-topbar-dynamic');
    if (el) setTopbarEl(el);
  }, [topbarVisible]);
  const [importedProject, setImportedProject] = useState(null);
  const [workspaceCreating, setWorkspaceCreating] = useState(false);
  const [creationStep, setCreationStep] = useState(null);
  const [createNewWorkspaceInline, setCreateNewWorkspaceInline] = useState(false);
  const [customImageId, setCustomImageId] = useState('');
  const [customImages, setCustomImages] = useState([]);
  // Onboarding wizard flow config
  const [wizardMode, setWizardMode] = useState('full'); // 'full' | 'session'
  const [wizardWorkspace, setWizardWorkspace] = useState(null);

  // Launch modal: agent config files
  const [launchConfigFiles, setLaunchConfigFiles] = useState([]);
  const [, setShowLaunchConfigModal] = useState(false);

  // Session config dialog (running session)
  const [showSessionConfigModal, setShowSessionConfigModal] = useState(false);
  const [sessionConfigError, setSessionConfigError] = useState(null);
  const [showRestartPrompt, setShowRestartPrompt] = useState(false);

  // Reset launch config when agent changes
  useEffect(() => {
    setLaunchConfigFiles([]);
  }, [selectedAgentId]);

  const startPanelResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    let moved = false;
    const maxW = Math.max(720, window.innerWidth - 240);
    // 按下即禁用面板容器指针事件：DeployPanel/浏览器预览是 iframe，会吞掉 mousemove/mouseup，
    // 导致拖拽冻结或面板跟着 iframe 乱跑；pointer-events:none 让事件穿透到父窗口。
    if (panelContainerRef.current) panelContainerRef.current.style.pointerEvents = 'none';
    // RAF 节流：高频 mousemove 只按帧更新宽度，避免 iframe（部署/浏览器预览）逐像素重排闪烁
    let rafId = null;
    let latestNext = startW;
    const applyWidth = () => {
      rafId = null;
      setPanelWidth(latestNext);
    };
    const onMove = (ev) => {
      if (Math.abs(ev.clientX - startX) > 3) {
        moved = true;
        setPanelDragging(true);
      }
      const delta = startX - ev.clientX;
      latestNext = Math.min(maxW, Math.max(420, startW + delta));
      if (rafId === null) rafId = requestAnimationFrame(applyWidth);
    };
    const onUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        // flush 最后一次宽度，避免快速松手丢失最终尺寸
        applyWidth();
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setPanelDragging(false);
      if (panelContainerRef.current) panelContainerRef.current.style.pointerEvents = '';
      // A click without dragging toggles the panel closed.
      if (!moved) setPanelOpen(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidth]);

  const getAgentLabel = useCallback(
    (agentId) => agents.find((a) => a.id === agentId)?.name || agentId,
    [agents],
  );

  useEffect(() => {
    if (activeSession && !workspaceCreating) setLaunchingSession(false);
  }, [activeSession, workspaceCreating]);

  useEffect(() => {
    if (!activeSession?.projectId) {
      setPanelOpen(true);
    }
    setViewingFile(null);
    setFileContent('');
  }, [activeSession?.projectId]);

  useEffect(() => {
    if (agents.length === 0) return;
    setSelectedAgentId((prev) => pickDefaultAgentId(agents, prev));
  }, [agents]);

  const fetchCustomImages = useCallback(() => {
    return apiFetch('/api/v1/custom-images').then((res) => res.json()).then((data) => {
      const list = data.images || (Array.isArray(data) ? data : []);
      setCustomImages(list.filter((img) => img.status === 'ready'));
    }).catch(() => {
      setCustomImages([]);
    });
  }, []);

  useEffect(() => {
    fetchCustomImages();
  }, [fetchCustomImages]);

  const selectedAgent = agents.find(a => a.id === selectedAgentId);

  const openLaunchConfigModal = async () => {
    setConfigError(null);
    setError(null);
    setShowLaunchConfigModal(true);
  };

  const configRequiredKeys = selectedAgent?.env_required || [];
  // eslint-disable-next-line no-unused-vars
  const configMissingKeys = useMemo(
    () => configRequiredKeys.filter((k) => !savedConfigKeys[k]),
    [configRequiredKeys, savedConfigKeys],
  );

  const ensureAgentSecrets = async () => true;

  const handleCreateProject = async (nameOverride) => {
    const name = (nameOverride ?? newProjectName).trim() || defaultWorkspaceName();
    setProjectCreating(true);
    setError(null);
    try {
      const res = await apiFetch('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401 || data.code === 'unauthorized') {
          throw new Error(t('auth:error.session_expired'));
        }
        if (data.code === 'quota_exceeded') {
          throw new Error(formatQuotaExceeded(data.dimension || 'max_projects', data.current, data.limit));
        }
        throw new Error(data.error || t('sessions:error.create_workspace_failed'));
      }
      return { id: data.id, name: data.name || name };
    } catch (err) {
      setLaunchModalError(err.message);
      return null;
    } finally {
      setProjectCreating(false);
    }
  };

  const handleStartSession = async (projectId, projectName, { closeLaunchModal = true } = {}) => {
    if (!selectedAgentId || !selectedAgent) return false;
    if (!projectId) {
      setLaunchModalError(t('sessions:error.no_workspace'));
      return false;
    }
    setIsLoading(true);
    setLaunchModalError(null);
    setError(null);
    try {
      const ready = await ensureAgentSecrets(selectedAgent);
      if (!ready) {
        setLaunchModalError(t('sessions:error.configure_keys'));
        return false;
      }

      // Collect non-empty config files from launch modal
      const cleanConfigFiles = launchConfigFiles.filter((f) => f.path && f.content);

      // Collect non-required env vars as custom_env (required ones are injected via secrets)
      const requiredSet = new Set(selectedAgent?.env_required || []);
      const cleanCustomEnv = {};
      for (const { key, value } of configEnvVars) {
        const k = (key || '').trim();
        const v = (value || '').trim();
        if (k && v && !requiredSet.has(k)) cleanCustomEnv[k] = v;
      }

      const response = await apiFetch('/api/v1/session/start', {
        method: 'POST',
        body: JSON.stringify({
          agent_id: selectedAgentId,
          project_id: projectId,
          terminal_theme_id: themeId,
          custom_image_id: (customImageId && customImageId !== '__none__') ? customImageId : undefined,
          ...(cleanConfigFiles.length ? { config_files: cleanConfigFiles } : {}),
          ...(Object.keys(cleanCustomEnv).length ? { custom_env: cleanCustomEnv } : {}),
        })
      });
      const data = await response.json();
      if (!response.ok) {
        const msg = data.detail || data.error || data.message || t('sessions:error.start_failed');
        if (response.status === 401 || data.code === 'unauthorized') {
          setLaunchModalError(t('auth:error.session_expired'));
          return false;
        }
        if (data.code === 'agent_not_granted') {
          setLaunchModalError(t('sessions:error.not_granted'));
          return false;
        }
        if (data.code === 'quota_exceeded') {
          setLaunchModalError(formatQuotaExceeded(data.dimension, data.current, data.limit));
          fetchWorkspaces();
          return false;
        }
        throw new Error(msg);
      }

      const isPending = response.status === 202 || data.status === 'pending';

      rememberRecentSession({
        id: data.session_id,
        agentId: selectedAgentId,
        projectId,
        projectName: projectName || projectId,
        createdAt: Date.now(),
      });
      rememberRecentAgent(selectedAgentId);
      setActiveSession({
        sessionId: data.session_id,
        agentId: selectedAgentId,
        agentName: selectedAgent.name,
        projectId,
        projectName: projectName || projectId,
      });
      // 新创建 session：右半边只保留 Files + Changes 两个 tab，回到文件界面。
      // 先清 sessionStorage（WorkspacePanel 首次挂载时从它恢复 tab），再清面板内 state。
      try {
        sessionStorage.removeItem('xe_main_tab');
        sessionStorage.removeItem('xe_extra_tabs');
      } catch { /* ignore */ }
      panelRef.current?.resetTabs();
      goToSessions();
      setSessions((prev) => {
        if (prev.some((s) => s.id === data.session_id)) return prev;
        const now = Date.now();
        return [
          ...prev,
          {
            id: data.session_id,
            projectId,
            agentId: selectedAgentId,
            status: data.status || 'running',
            alive: !isPending,
            projectName: projectName || projectId,
            createdAt: now,
          },
        ];
      });
      fetchWorkspaces();
      if (closeLaunchModal) { setShowNewInstanceModal(false); onLaunchPanelClose?.(); }
      return true;
    } catch (err) {
      setLaunchModalError(err.message);
      setError(err.message);
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const openLaunchModal = async (mode = 'session', workspace = null) => {
    setLaunchModalError(null);
    setCreateNewWorkspaceInline(false);
    setCustomImageId('');
    setImportedProject(null);
    setNewProjectName('');
    fetchCustomImages();
    const freshAgents = await fetchAgents?.() || agents;
    // Decide wizard flow: 'full' = step1 source + step2 agent (create workspace);
    // 'session' = agent-only, start a new agent session in the current workspace.
    let nextMode = 'full';
    let nextWorkspace = null;
    if (mode === 'workspace' || projects.length === 0) {
      // New Workspace button or no workspaces -> full creation flow.
      setLaunchModalMode('quickstart');
      setStartSessionAfterCreate(true);
      setLaunchWorkspaceId('');
    } else {
      // New Session -> agent selection in current workspace, if one is selected.
      const ws = workspace || projects.find((p) => p.id === activeWorkspaceId) || null;
      if (ws) {
        nextMode = 'session';
        nextWorkspace = ws;
        setLaunchModalMode('session');
        setStartSessionAfterCreate(true);
        setLaunchWorkspaceId(ws.id);
      } else {
        setLaunchModalMode('quickstart');
        setStartSessionAfterCreate(true);
        setLaunchWorkspaceId('');
      }
    }
    setWizardMode(nextMode);
    setWizardWorkspace(nextWorkspace);
    const prefs = loadSidebarPrefs();
    const sorted = sortAgentsByRecentUsage(freshAgents, prefs);
    if (sorted.length > 0) {
      setSelectedAgentId(sorted[0].id);
    }
    setShowNewInstanceModal(true);
  };

  // Auto-open the onboarding wizard once for users with no workspaces.
  const onboardingAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (onboardingAutoOpenedRef.current) return;
    if (!projectsLoaded) return;
    if (projects.length > 0) return;
    if (activeSession) return;
    onboardingAutoOpenedRef.current = true;
    openLaunchModal('session');
  }, [projectsLoaded, projects.length, activeSession, openLaunchModal]);

  const handleLaunchFromModal = async () => {
    setLaunchModalError(null);

    if (importedProject?.repo) {
      const repo = importedProject.repo;
      setLaunchingSession(true);
      setWorkspaceCreating(true);
      setCreationStep('import');
      setShowNewInstanceModal(false);
      onLaunchPanelClose?.();
      let creationFailed = false;
      try {
        const importPayload = repo.repo_url
          ? {
              repo_url: repo.repo_url,
              name: repo.name,
              branch: repo.default_branch,
              auto_create_branch: true,
              work_branch_name: generateWorkBranchName(repo.name || 'repo'),
            }
          : {
              provider: repo.provider,
              repo_full_name: repo.full_name,
              name: repo.name,
              branch: repo.default_branch,
              auto_create_branch: true,
              work_branch_name: generateWorkBranchName(repo.full_name),
            };
        const result = await gitApi.importRepo(importPayload);
        // Switch to the new workspace immediately
        switchWorkspace(result.id);
        setProjects((prev) => {
          if (prev.some((p) => p.id === result.id)) return prev;
          return [...prev, { id: result.id, name: repo.name, createdAt: Date.now() }];
        });
        await new Promise((resolve, reject) => {
          let attempts = 0;
          const pollId = setInterval(async () => {
            attempts += 1;
            try {
              const res = await githubApi.getCloneStatus(result.id);
              if (res?.clone_status === 'ready') {
                clearInterval(pollId);
                resolve();
              } else if (res?.clone_status === 'failed') {
                clearInterval(pollId);
                reject(new Error(res.clone_error || t('git:error.clone_failed')));
              }
            } catch {
              /* keep polling */
            }
            if (attempts >= 150) {
              clearInterval(pollId);
              reject(new Error(t('git:error.clone_timeout')));
            }
          }, 2000);
        });
        setCreationStep('session');
        await handleStartSession(result.id, repo.full_name || repo.name, { closeLaunchModal: true });
      } catch (err) {
        creationFailed = true;
        setLaunchModalError(err.message || t('git:error.import_failed'));
      } finally {
        if (!creationFailed) {
          await new Promise((r) => setTimeout(r, 800));
          setSkipPendingSpinner(true);
          setWorkspaceCreating(false);
          setCreationStep(null);
          setLaunchingSession(false);
        }
      }
      return;
    }

    setLaunchingSession(true);
    let started = false;
    try {
      if (launchModalMode === 'quickstart') {
        const name = newProjectName.trim() || defaultWorkspaceName();
        const created = await handleCreateProject(name);
        if (!created) return;
        setProjects((prev) => {
          if (prev.some((p) => p.id === created.id)) return prev;
          return [...prev, { id: created.id, name: created.name, createdAt: Date.now() }];
        });
        started = await handleStartSession(created.id, created.name, { closeLaunchModal: true });
        return;
      }
      if (launchModalMode === 'session') {
        if (createNewWorkspaceInline) {
          const name = newProjectName.trim() || defaultWorkspaceName();
          const created = await handleCreateProject(name);
          if (!created) return;
          setProjects((prev) => {
            if (prev.some((p) => p.id === created.id)) return prev;
            return [...prev, { id: created.id, name: created.name, createdAt: Date.now() }];
          });
          started = await handleStartSession(created.id, created.name, { closeLaunchModal: true });
          return;
        }
        if (!launchWorkspaceId) {
          setLaunchModalError(t('sessions:error.select_workspace', { defaultValue: 'Select a workspace first.' }));
          return;
        }
        const ws = projects.find((p) => p.id === launchWorkspaceId);
        started = await handleStartSession(launchWorkspaceId, ws?.name || launchWorkspaceId, { closeLaunchModal: true });
        return;
      }
      const name = newProjectName.trim() || defaultWorkspaceName();
      const created = await handleCreateProject(name);
      if (!created) return;
      setProjects((prev) => {
        if (prev.some((p) => p.id === created.id)) return prev;
        return [...prev, { id: created.id, name: created.name, createdAt: Date.now() }];
      });
      if (startSessionAfterCreate) {
        started = await handleStartSession(created.id, created.name, { closeLaunchModal: true });
        if (!started) fetchWorkspaces();
      } else {
        fetchWorkspaces();
        setShowNewInstanceModal(false); onLaunchPanelClose?.();
      }
    } finally {
      if (!started) setLaunchingSession(false);
    }
  };

  const handleRepoImported = useCallback((repo) => {
    setImportedProject({ name: repo.name, repo });
  }, []);

  const closeOnboarding = useCallback(() => {
    setShowNewInstanceModal(false);
    setLaunchModalError(null);
    setCreateNewWorkspaceInline(false);
    setShowLaunchConfigModal(false);
    setImportedProject(null);
    setNewProjectName('');
    setWizardMode('full');
    setWizardWorkspace(null);
    setWorkspaceCreating(false);
    setCreationStep(null);
    setSkipPendingSpinner(false);
    onLaunchPanelClose?.();
  }, [onLaunchPanelClose]);

  // New Session wizard (session mode): start a new agent session directly in
  // the current workspace, skipping workspace/source selection.
  const handleLaunchSessionInWorkspace = useCallback(async () => {
    if (!wizardWorkspace?.id) return;
    await handleStartSession(wizardWorkspace.id, wizardWorkspace.name, { closeLaunchModal: true });
  }, [wizardWorkspace, handleStartSession]);

  const handleSaveLaunchConfig = async () => {
    setConfigError(null);
    const payload = {};
    for (const { key, value } of configEnvVars) {
      const k = (key || '').trim();
      if (!k) continue;
      const v = (value || '').trim();
      payload[k] = v;
    }
    // Include keys that were removed via X button (present at modal open, now gone)
    if (configModalInitialKeysRef.current) {
      for (const k of configModalInitialKeysRef.current) {
        if (!(k in payload)) payload[k] = '';
      }
    }
    configModalInitialKeysRef.current = null;
    if (Object.keys(payload).length === 0) {
      setShowLaunchConfigModal(false);
      setLaunchModalError(null);
      return;
    }
    setConfigSaving(true);
    try {
      const res = await apiFetch('/api/v1/secrets', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('sessions:error.save_keys_failed'));
      setSavedConfigKeys((prev) => {
        const next = { ...prev };
        Object.keys(payload).forEach((k) => { next[k] = true; });
        return next;
      });
      showToast('success', t('sessions:toast.config_saved'));
      setShowLaunchConfigModal(false);
      setLaunchModalError(null);
    } catch (err) {
      setConfigError(err.message);
    } finally {
      setConfigSaving(false);
    }
  };

  const fetchWorkspaceFiles = useCallback(async ({ notifyError = false } = {}) => {
    if (!activeSession?.projectId) return;
    setIsLoadingFiles(true);
    try {
      const qs = new URLSearchParams({ project_id: activeSession.projectId });
      if (showHiddenFiles) qs.set('include_hidden', '1');
      const res = await apiFetch(withSessionId(`/api/v1/workspace/files?${qs}`));
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t('sessions:error.load_files_failed'));
      }
    } catch (err) {
      if (notifyError) showToast('error', err.message);
    } finally {
      setIsLoadingFiles(false);
    }
  }, [activeSession?.projectId, activeSession?.sessionId, showHiddenFiles, showToast]);

  const handleOpenFile = useCallback(async (file) => {
    if (!activeSession?.projectId || file?.type !== 'file') return;
    try {
      const res = await apiFetch(
        withSessionId(`/api/v1/workspace/file?project_id=${encodeURIComponent(activeSession.projectId)}&path=${encodeURIComponent(file.path)}`)
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t('sessions:error.read_file_failed'));
      }
      setViewingFile(file);
      setFileContent(data.content || '');
    } catch (err) {
      showToast('error', err.message);
    }
  }, [activeSession?.projectId, showToast]);

  const handleGitFileClick = useCallback(async (filePath) => {
    if (!activeSession?.projectId) return;
    setGitDiffView({ path: filePath, original: null, modified: null, loading: true });
    try {
      const data = await githubApi.getGitFileDiffView(activeSession.projectId, filePath);
      setGitDiffView({
        path: filePath,
        original: data.original || '',
        modified: data.modified || '',
        loading: false,
        binary: Boolean(data.binary),
        truncated: Boolean(data.truncated),
      });
    } catch (err) {
      setGitDiffView(null);
      showToast('error', err.message);
    }
  }, [activeSession?.projectId, showToast]);

  const handleCloseGitDiff = useCallback(() => {
    setGitDiffView(null);
  }, []);

  // Stabilized callbacks for WorkspacePanel to prevent re-renders on every keystroke.
  const handleSaveTab = useCallback((path) => {
    if (!activeSession?.projectId) return;
    return editorTabs.saveTab(activeSession.projectId, path)
      .then((result) => {
        gitChanges?.fetchStatus?.({ silent: true });
        return result;
      });
  }, [activeSession?.projectId, editorTabs.saveTab, gitChanges]);

  const handleEditorOpenFile = useCallback((file) => {
    if (!activeSession?.projectId) return;
    return editorTabs.openFile(activeSession.projectId, file);
  }, [activeSession?.projectId, editorTabs.openFile]);

  const handleCreateFile = useCallback((projectId, name) => {
    return editorTabs.handleCreateFile(projectId, name)
      .then(() => editorTabs.openFile(projectId, { path: name, type: 'file' }))
      .then((result) => {
        gitChanges?.fetchStatus?.({ silent: true });
        return result;
      })
      .catch((e) => showToast('error', e.message));
  }, [editorTabs.handleCreateFile, editorTabs.openFile, showToast, gitChanges]);

  const handleCreateDir = useCallback((projectId, name) => {
    return editorTabs.handleCreateDir(projectId, name)
      .then((result) => {
        gitChanges?.fetchStatus?.({ silent: true });
        return result;
      })
      .catch((e) => showToast('error', e.message));
  }, [editorTabs.handleCreateDir, showToast, gitChanges]);

  const handleDeleteFile = useCallback(async (projectId, path) => {
    try {
      await editorTabs.deleteFile(projectId, path);
      editorTabs.closeTabByPath(path);
      editorTabs.bumpTreeRefresh();
      gitChanges?.fetchStatus?.({ silent: true });
      showToast('success', t('sessions:toast.file_deleted'));
    } catch (e) {
      showToast('error', e.message);
    }
  }, [editorTabs.deleteFile, editorTabs.closeTabByPath, editorTabs.bumpTreeRefresh, showToast, gitChanges]);

  const handleDeleteDir = useCallback(async (projectId, path) => {
    if (!path || path === '.' || path === '') {
      showToast('error', t('sessions:error.cannot_delete_root', { defaultValue: 'Cannot delete root directory.' }));
      return;
    }
    try {
      await editorTabs.deleteDir(projectId, path);
      editorTabs.bumpTreeRefresh();
      gitChanges?.fetchStatus?.({ silent: true });
      showToast('success', t('sessions:toast.folder_deleted', { defaultValue: 'Folder deleted.' }));
    } catch (e) {
      showToast('error', e.message);
    }
  }, [editorTabs.deleteDir, editorTabs.bumpTreeRefresh, showToast, gitChanges]);

  const handleRenameFile = useCallback(async (projectId, oldPath, newName) => {
    const newPath = pathJoin(pathParent(oldPath), newName);
    if (newPath === oldPath) return;
    try {
      await editorTabs.moveFile(projectId, oldPath, newPath);
      editorTabs.renameTabPath(oldPath, newPath);
      editorTabs.bumpTreeRefresh();
      gitChanges?.fetchStatus?.({ silent: true });
      showToast('success', t('sessions:toast.renamed', { defaultValue: 'Renamed.' }));
    } catch (e) {
      showToast('error', e.message);
    }
  }, [editorTabs.moveFile, editorTabs.renameTabPath, editorTabs.bumpTreeRefresh, showToast, gitChanges]);

  const handleCopyPath = useCallback(async (path) => {
    try {
      await navigator.clipboard.writeText(path);
      showToast('success', t('sessions:toast.path_copied'));
    } catch {
      showToast('error', t('sessions:error.copy_path_failed', { defaultValue: 'Failed to copy path.' }));
    }
  }, [showToast]);

  const handleShowDiff = useCallback((path) => {
    if (!activeSession?.projectId) return;
    return editorTabs.showDiff(activeSession.projectId, path)
      .catch((e) => showToast('error', e.message));
  }, [activeSession?.projectId, editorTabs.showDiff, showToast]);

  const handleSessionEnd = useCallback((sessionId) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId ? { ...s, alive: false, memoryStatus: 'exited', status: 'exited' } : s
      )
    );
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  const handleSessionIdle = (sessionId) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId ? { ...s, alive: false, memoryStatus: 'idle', status: 'idle' } : s
      )
    );
    fetchWorkspaces();
  };

  const handleRestartSession = async (sessionParam) => {
    const sess = sessionParam || activeSession;
    if (!sess) return;
    const sessionId = sess.sessionId || sess.id;
    const agentId = sess.agentId || sessions.find((s) => s.id === sessionId)?.agentId;
    const projectId = sess.projectId;
    const projectName = sess.projectName;
    if (!agentId || !projectId) {
      showToast('error', t('sessions:error.missing_agent_or_workspace', { defaultValue: 'Cannot start: missing agent or workspace.' }));
      return;
    }
    const agent = agents.find((a) => a.id === agentId);
    const oldSessionId = sessionId;
    const sessionMeta = sessions.find((s) => s.id === oldSessionId);
    const targetAlive = sessionMeta?.alive === true;
    const isRecoverable = sessionMeta?.recoverable !== false;
    // Restarting a non-active sidebar session: switch the view to it first.
    if (sessionParam && activeSession?.sessionId !== sessionId) {
      setActiveSession({ sessionId, agentId, agentName: sess.agentName || agent?.name, projectId, projectName });
    }

    setRestartingSession(true);
    try {
      const ready = await ensureAgentSecrets(agent);
      if (!ready) {
        showToast('error', t('sessions:error.configure_keys'));
        return;
      }

      if (isRecoverable) {
        if (targetAlive) {
          const stopRes = await apiFetch(`/api/v1/sessions/${encodeURIComponent(oldSessionId)}/stop`, { method: 'POST' });
          const stopData = await stopRes.json();
          if (!stopRes.ok) throw new Error(stopData.error || t('sessions:error.pause_failed', { defaultValue: 'Failed to pause session' }));
          handleSessionIdle(oldSessionId);
        }
        const response = await apiFetch(`/api/v1/sessions/${encodeURIComponent(oldSessionId)}/resume`, {
          method: 'POST',
          body: JSON.stringify({ terminal_theme_id: themeId }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || t('sessions:error.resume_failed'));
        setSessions((prev) => prev.map((s) => (
          s.id === oldSessionId ? { ...s, alive: true, status: 'running', memoryStatus: 'running' } : s
        )));
        setReconnectVersion((v) => v + 1);
        fetchWorkspaces();
        showToast('success', targetAlive ? t('sessions:toast.session_restarted') : t('sessions:toast.session_resumed', { defaultValue: 'Session resumed.' }));
        return;
      }

      const deleteRes = await apiFetch(`/api/v1/sessions/${encodeURIComponent(oldSessionId)}`, { method: 'DELETE' });
      if (!deleteRes.ok) throw new Error(t('sessions:error.release_failed', { defaultValue: 'Failed to release previous session' }));
      archiveSession(oldSessionId);

      const response = await apiFetch('/api/v1/session/start', {
        method: 'POST',
        body: JSON.stringify({
          agent_id: agentId,
          project_id: projectId,
          terminal_theme_id: themeId,
          custom_image_id: sessionMeta?.customImageId || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('sessions:error.start_failed'));

      replaceRecentSessionId(oldSessionId, data.session_id, {
        agentId, projectId, projectName, createdAt: Date.now(),
      });
      rememberRecentAgent(agentId);
      setActiveSession({
        sessionId: data.session_id,
        agentId,
        agentName: agent?.name || sess.agentName,
        projectId,
        projectName,
      });
      goToSessions();
      setSessions((prev) => {
        const withoutOld = prev.filter((s) => s.id !== oldSessionId);
        if (withoutOld.some((s) => s.id === data.session_id)) return withoutOld;
        const now = Date.now();
        return [...withoutOld, { id: data.session_id, projectId, agentId, status: 'running', alive: true, projectName, createdAt: now }];
      });
      fetchWorkspaces();
      showToast('success', t('sessions:toast.session_restarted'));
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setRestartingSession(false);
    }
  };

  const handleDeleteSession = async (sessionId) => {
    setDeletingSessionId(sessionId);
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(t('sessions:error.delete_session_failed', { defaultValue: 'Failed to delete session' }));
      archiveSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSession?.sessionId === sessionId) setActiveSession(null);
      setDeleteConfirmSession(null);
      fetchWorkspaces();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingSessionId(null);
    }
  };

  const requestDeleteSession = (session, ws) => {
    setDeleteConfirmSession({
      sessionId: session.id,
      isLive: session.alive === true,
      agentLabel: getAgentLabel(session.agentId),
      workspaceName: ws?.name || t('sessions:label.unassigned'),
    });
  };

  const handleDeleteWorkspace = async (workspaceId) => {
    setDeletingWorkspaceId(workspaceId);
    try {
      if (workspaceId === '_orphan') {
        const orphanSessions = sessions.filter((s) => !s.projectId);
        for (const s of orphanSessions) {
          await apiFetch(`/api/v1/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
        }
        if (activeSession && !activeSession.projectId) setActiveSession(null);
      } else {
        const res = await apiFetch(`/api/v1/projects/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || t('sessions:error.delete_workspace_failed'));
        }
        if (activeSession?.projectId === workspaceId) setActiveSession(null);
      }
      purgeWorkspaceSidebarPrefs(workspaceId, sessions);
      setSessions((prev) => prev.filter((s) => (workspaceId === '_orphan' ? Boolean(s.projectId) : s.projectId !== workspaceId)));
      if (workspaceId !== '_orphan') {
        setProjects((prev) => prev.filter((p) => p.id !== workspaceId));
      }
      setDeleteConfirmWorkspace(null);
      fetchWorkspaces();
      showToast('success', workspaceId === '_orphan' ? t('sessions:toast.unassigned_cleared', { defaultValue: 'Unassigned sessions cleared.' }) : t('sessions:toast.workspace_deleted'));
    } catch (err) {
      showToast('error', err.message);
      fetchWorkspaces();
    } finally {
      setDeletingWorkspaceId(null);
    }
  };

  const requestDeleteWorkspace = (ws) => {
    const liveCount = ws.sessions.filter((s) => s.alive === true).length;
    setDeleteConfirmWorkspace({
      workspaceId: ws.id,
      workspaceName: ws.name,
      sessionCount: ws.sessions.length,
      liveCount,
      isOrphan: ws.id === '_orphan',
    });
  };

  const closeLaunchModal = useCallback(() => {
    setShowNewInstanceModal(false);
    setLaunchModalError(null);
    setCreateNewWorkspaceInline(false);
    setShowLaunchConfigModal(false);
    setImportedProject(null);
  }, []);

  React.useImperativeHandle(ref, () => ({
    openLaunchModal,
    closeLaunchModal,
    openImportDialog: () => setShowImportDialog(true),
    requestDeleteSession,
    requestDeleteWorkspace,
    restartSession: handleRestartSession,
  }), [openLaunchModal, closeLaunchModal, requestDeleteSession, requestDeleteWorkspace, handleRestartSession]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeSession?.projectId) || null,
    [projects, activeSession?.projectId],
  );

  // activeSessionMeta and sessionAlive are computed earlier (before useGitChanges)
  // so we can gate VM-triggering API calls on session liveness.
  const sessionPending = activeSessionMeta?.status === 'pending';
  const sessionFailed = activeSessionMeta?.status === 'failed';
  const sessionWakeable = !sessionAlive && !sessionPending && !sessionFailed
    && activeSessionMeta?.recoverable === true
    && activeSessionMeta?.status === 'idle';
  const sessionControlPending = restartingSession;

  // Auto-resume idle recoverable sessions (e.g. after server restart).
  // Without this, TUI agents like Kimi Code show a blank gray screen because
  // their alternate-screen output is stripped during idle replay, and the
  // idle-replay branch never opens a WebSocket to trigger server-side wake.
  const autoResumeTriedRef = useRef(new Set());
  useEffect(() => {
    if (!sessionWakeable || restartingSession) return;
    const sessionId = activeSession?.sessionId;
    if (!sessionId || autoResumeTriedRef.current.has(sessionId)) return;
    autoResumeTriedRef.current.add(sessionId);
    handleRestartSession(activeSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionWakeable, activeSession?.sessionId, restartingSession]);

  const handleSessionConnected = useCallback((sessionId) => {
    setSessions((prev) => prev.map((s) => (
      s.id === sessionId ? { ...s, alive: true, status: 'running', memoryStatus: 'running' } : s
    )));
    setSkipPendingSpinner(false);
    fetchWorkspaces();
  }, [fetchWorkspaces, setSessions]);

  return (
    <div className={className || 'h-full w-full'}>
      {/* Simple delete confirm */}
      {deleteConfirmSession && (
        <ConsoleInlineDialog onClose={() => setDeleteConfirmSession(null)} panelClassName={`${consoleDialogPanelClass} w-full max-w-md`}>
          <div className={`${consoleStructuredDialogHeaderClass}`}>{t('common:dialog.confirm_title')}</div>
          <div className="p-5 text-sm">{t('sessions:dialog.remove_session')}</div>
          <div className={consoleStructuredDialogFooterClass}>
            <button onClick={() => setDeleteConfirmSession(null)} className="h-9 px-4 border rounded-md">{t('common:action.cancel')}</button>
            <button onClick={() => handleDeleteSession(deleteConfirmSession.sessionId)} className="h-9 px-4 bg-red-600 text-white rounded-md">{t('sessions:action.remove')}</button>
          </div>
        </ConsoleInlineDialog>
      )}

      {deleteConfirmWorkspace && (
        <ConsoleInlineDialog
          onClose={() => setDeleteConfirmWorkspace(null)}
          panelClassName={`${consoleDialogPanelClass} w-full max-w-md shadow-sm`}
        >
          <div className={`${consoleStructuredDialogHeaderClass} flex items-center gap-3`}>
            <Trash2 className={`w-5 h-5 shrink-0 ${textPlaceholder}`} />
            <h3 className={`font-semibold text-sm ${textPrimary}`}>
              {deleteConfirmWorkspace.isOrphan ? t('sessions:dialog.clear_unassigned') : t('sessions:dialog.delete_workspace')}
            </h3>
          </div>
          <div className={`p-5 text-sm ${textSecondary}`}>
            {deleteConfirmWorkspace.isOrphan ? (
              <>
                {t('sessions:dialog.remove_all_sessions_in')} <span className={`font-medium ${textPrimary}`}>{t('sessions:label.unassigned')}</span>?
                {deleteConfirmWorkspace.sessionCount > 0 && (
                  <span>
                    {' '}
                    {t('sessions:dialog.this_will_remove')} {t('sessions:count', { count: deleteConfirmWorkspace.sessionCount })}
                    {deleteConfirmWorkspace.liveCount > 0 && (
                      <> ({t('sessions:dialog.including_running', { count: deleteConfirmWorkspace.liveCount })})</>
                    )}
                    .
                  </span>
                )}
                <p className={`mt-2 text-xs ${textPlaceholder}`}>{t('sessions:dialog.unassigned_description')}</p>
              </>
            ) : (
              <>
                {t('sessions:dialog.permanently_delete')} <span className={`font-medium ${textPrimary}`}>{deleteConfirmWorkspace.workspaceName}</span>?
                {deleteConfirmWorkspace.sessionCount > 0 && (
                  <span>
                    {' '}
                    {t('sessions:dialog.this_will_remove')} {t('sessions:count', { count: deleteConfirmWorkspace.sessionCount })}
                    {deleteConfirmWorkspace.liveCount > 0 && (
                      <> ({t('sessions:dialog.including_running', { count: deleteConfirmWorkspace.liveCount })})</>
                    )}
                    .
                  </span>
                )}
              </>
            )}
          </div>
          <div className={consoleStructuredDialogFooterClass}>
            <button
              type="button"
              onClick={() => setDeleteConfirmWorkspace(null)}
              className={`h-9 px-4 ${bgCanvas} border ${borderHairline} ${textPrimary} rounded-md text-sm font-medium ${hoverBgSecondary} ${transitionBase}`}
            >
              {t('common:action.cancel')}
            </button>
            <button
              type="button"
              disabled={deletingWorkspaceId === deleteConfirmWorkspace.workspaceId}
              onClick={() => handleDeleteWorkspace(deleteConfirmWorkspace.workspaceId)}
              className={`h-9 px-4 flex items-center justify-center gap-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50 ${transitionBase}`}
            >
              {deletingWorkspaceId === deleteConfirmWorkspace.workspaceId
                ? <><Loader2 className="w-4 h-4 animate-spin" /> {t('sessions:action.removing', { defaultValue: 'Removing…' })}</>
                : deleteConfirmWorkspace.isOrphan
                  ? t('sessions:action.clear_all', { defaultValue: 'Clear all' })
                  : t('sessions:dialog.delete_workspace', { defaultValue: 'Delete workspace' })}
            </button>
          </div>
        </ConsoleInlineDialog>
      )}

      {/* Session config dialog (running session) */}
      {showSessionConfigModal && activeSession?.agentId && (
        <ConsoleInlineDialog
          onClose={() => { setShowSessionConfigModal(false); setSessionConfigError(null); }}
          panelClassName={`${consoleDialogPanelClass} w-full max-w-lg shadow-sm`}
        >
          <div className={`${consoleStructuredDialogHeaderClass} flex items-center gap-2.5`}>
            <Settings2 className={`w-4 h-4 shrink-0 ${textPlaceholder}`} />
            <h3 className={`font-semibold text-sm ${textPrimary}`}>
              {t('sessions:dialog.agent_configuration', { defaultValue: 'Agent Configuration' })}{activeSession?.agentName ? ` - ${activeSession.agentName}` : ''}
            </h3>
          </div>
          <div className="p-4 space-y-3">
            {sessionConfigError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{sessionConfigError}</p>
            )}
            <ByokConfigForm
              agentId={activeSession.agentId}
              loading={false}
              onSave={() => { setShowSessionConfigModal(false); setSessionConfigError(null); showToast('success', t('sessions:toast.config_saved')); }}
            />
          </div>
          <div className={consoleStructuredDialogFooterClass}>
            <button
              type="button"
              onClick={() => { setShowSessionConfigModal(false); setSessionConfigError(null); }}
              className={`h-9 px-3 ${bgCanvas} border ${borderHairline} ${textPrimary} rounded-md text-sm font-medium ${hoverBgSecondary} ${transitionBase}`}
            >
              Close
            </button>
          </div>
        </ConsoleInlineDialog>
      )}

      {/* Restart prompt after config update */}
      {showRestartPrompt && (
        <ConsoleInlineDialog
          onClose={() => setShowRestartPrompt(false)}
          panelClassName={`${consoleDialogPanelClass} w-full max-w-sm shadow-sm`}
        >
          <div className={`${consoleStructuredDialogHeaderClass} flex items-center gap-2.5`}>
            <Power className={`w-4 h-4 shrink-0 ${textPlaceholder}`} />
            <h3 className={`font-semibold text-sm ${textPrimary}`}>{t('sessions:dialog.configuration_updated', { defaultValue: 'Configuration Updated' })}</h3>
          </div>
          <div className="p-4 space-y-2">
            <p className={`text-sm ${textSecondary}`}>
              {t('sessions:dialog.configuration_updated_desc', { defaultValue: 'Configuration has been updated. Restart this session for the changes to take effect.' })}
            </p>
          </div>
          <div className={consoleStructuredDialogFooterClass}>
            <button
              type="button"
              onClick={() => setShowRestartPrompt(false)}
              className={`h-9 px-3 ${bgCanvas} border ${borderHairline} ${textPrimary} rounded-md text-sm font-medium ${hoverBgSecondary} ${transitionBase}`}
            >
              {t('sessions:action.later', { defaultValue: 'Later' })}
            </button>
            <button
              type="button"
              onClick={() => { setShowRestartPrompt(false); handleRestartSession(); }}
              className={`h-9 px-3 flex items-center justify-center gap-2 bg-zinc-900 text-zinc-50 rounded-md text-sm font-medium hover:bg-zinc-700 ${transitionBase}`}
            >
              <Power className="w-4 h-4" /> {t('sessions:action.restart_now', { defaultValue: 'Restart Now' })}
            </button>
          </div>
        </ConsoleInlineDialog>
      )}

      {/* Main area */}
      <div className="flex min-h-0 flex-1 w-full flex-row items-stretch bg-surface">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
          <>
          {topbarEl && createPortal(
            <>
              <div className="flex items-center gap-2 min-w-0">
                <WorkspaceSwitcher
                  projects={projects}
                  activeWorkspaceId={activeWorkspaceId}
                  sessions={sessions}
                  onSelect={switchWorkspace}
                  onCreate={() => openLaunchModal('workspace')}
                  onDelete={requestDeleteWorkspace}
                />
              </div>
              <div className="flex items-center min-w-0 justify-center">
                {activeSession?.projectId && activeProject?.repoProvider && GIT_REPO_PROVIDERS.has(activeProject.repoProvider) && (
                  <BranchSwitcher projectId={activeSession.projectId} project={activeProject} git={gitChanges} />
                )}
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <LanguageToggle />
                {activeSession && (
                  <>
                    <div className="mx-0.5 h-5 w-px bg-zinc-200" />
                    {!sessionPending && !sessionFailed && (
                      <button
                        type="button"
                        onClick={() => handleRestartSession()}
                        disabled={sessionControlPending}
                        className={`${consoleIconButtonClass} disabled:opacity-50 disabled:cursor-not-allowed`}
                        title={restartingSession ? (sessionAlive ? t('sessions:action.restarting', { defaultValue: 'Restarting…' }) : t('sessions:action.starting', { defaultValue: 'Starting…' })) : (sessionAlive ? t('sessions:action.restart_session', { defaultValue: 'Restart session' }) : t('sessions:action.start_session', { defaultValue: 'Start session' }))}
                        aria-label={restartingSession ? (sessionAlive ? t('sessions:action.restarting_session', { defaultValue: 'Restarting session' }) : t('sessions:action.starting_session', { defaultValue: 'Starting session' })) : (sessionAlive ? t('sessions:action.restart_session', { defaultValue: 'Restart session' }) : t('sessions:action.start_session', { defaultValue: 'Start session' }))}
                      >
                        {restartingSession ? (
                          <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} />
                        ) : sessionAlive ? (
                          <RotateCw className="w-4 h-4" strokeWidth={1.75} />
                        ) : (
                          <Play className="w-4 h-4" strokeWidth={1.75} />
                        )}
                      </button>
                    )}
                  {activeSession.projectId ? (
                    <>
                      <div className="mx-0.5 h-5 w-px bg-zinc-200" />
                      <PreviewControlGroup {...preview} deployStatus={deployStatus} onCancelDeploy={handleCancelDeploy} onAnalyze={() => { setAbortRequested(false); panelRef.current?.addTab('deploy'); setDeployVersion((v) => v + 1); setTimeout(() => deployPanelRef.current?.requestDeploy?.(), 0); }} />
                    </>
                  ) : null}
                  {activeSession && (
                    <>
                      <div className="mx-0.5 h-5 w-px bg-zinc-200" />
                      <button
                        type="button"
                        onClick={() => setPanelOpen((p) => !p)}
                        title={panelOpen ? t('sessions:action.hide_side_panel', { defaultValue: 'Hide side panel' }) : t('sessions:action.show_side_panel', { defaultValue: 'Show side panel' })}
                        aria-label={panelOpen ? t('sessions:action.hide_side_panel', { defaultValue: 'Hide side panel' }) : t('sessions:action.show_side_panel', { defaultValue: 'Show side panel' })}
                        className={consoleIconButtonClass}
                      >
                        {panelOpen ? <PanelRightClose className="w-4 h-4" strokeWidth={1.75} /> : <PanelRightOpen className="w-4 h-4" strokeWidth={1.75} />}
                      </button>
                    </>
                  )}
                  </>
                )}
              </div>
            </>,
            topbarEl
          )}
          {activeSession && !workspaceCreating ? (
            (sessionPending && !skipPendingSpinner) ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-surface p-8 text-center">
                <Loader2 className="w-8 h-8 text-zinc-400 animate-spin mb-4" strokeWidth={1.5} />
                <h3 className="text-lg font-semibold text-zinc-900 mb-1.5">{t('sessions:state.preparing_environment', { defaultValue: 'Preparing your environment…' })}</h3>
                <p className="text-sm text-zinc-400 max-w-sm">
                  {t('sessions:state.preparing_environment_desc', { defaultValue: 'Pulling image and starting virtual machine. This usually takes less than a minute.' })}
                </p>
              </div>
            ) : sessionFailed ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-surface p-8 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 mb-5">
                  <X className="w-7 h-7 text-red-600" strokeWidth={1.5} />
                </div>
                <h3 className="text-lg font-semibold text-zinc-900 mb-1.5">{t('sessions:state.session_failed', { defaultValue: 'Session failed to start' })}</h3>
                <p className="text-sm text-zinc-400 max-w-md mb-5">
                  {activeSessionMeta?.provisioningError || t('sessions:state.provisioning_error', { defaultValue: 'An unexpected error occurred during provisioning.' })}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleDeleteSession(activeSession.sessionId)}
                    className="h-9 px-4 flex items-center gap-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" strokeWidth={1.75} />
                    {t('sessions:action.delete_session', { defaultValue: 'Delete session' })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveSession(null)}
                    className="h-9 px-4 flex items-center gap-2 bg-surface border border-zinc-200 text-zinc-900 rounded-md text-sm font-medium hover:bg-zinc-100 transition-colors"
                  >
                    {t('sessions:action.dismiss', { defaultValue: 'Dismiss' })}
                  </button>
                </div>
              </div>
            ) : (
<div ref={panelRowRef} className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <div
                  className="flex min-h-0 flex-1 flex-col overflow-hidden"
                  style={{ backgroundColor: preset.xterm.background }}
                >
                  <AgentConsole
                    key={activeSession.sessionId}
                    sessionId={activeSession.sessionId}
                    reconnectVersion={reconnectVersion}
                    onSessionEnd={handleSessionEnd}
                    onSessionConnected={handleSessionConnected}
                    sessionLive={sessionAlive || skipPendingSpinner}
                    sessionWakeable={sessionWakeable}
                  />
                </div>
                {!panelOpen && (
                  <button
                    type="button"
                    onClick={() => setPanelOpen(true)}
                    title={t('sessions:action.open_workspace_panel', { defaultValue: 'Open workspace panel' })}
                    aria-label={t('sessions:action.open_workspace_panel', { defaultValue: 'Open workspace panel' })}
                    className="absolute right-0 top-0 h-full w-1.5 shrink-0 bg-zinc-200/40 hover:bg-zinc-400 transition-colors z-10"
                  />
                )}
              </div>
              <div
                ref={panelContainerRef}
                className="flex min-h-0 shrink-0 overflow-hidden"
                style={{
                  width: panelOpen ? panelWidth + 4 : 0,
                  transition: panelDragging ? 'none' : 'width 150ms ease-out',
                }}
              >
                <div
                  onMouseDown={startPanelResize}
                  className="w-1 shrink-0 cursor-col-resize bg-zinc-200 hover:bg-zinc-900 transition-colors"
                  title={t('workspace:action.click_to_hide_drag_to_resize', { defaultValue: 'Click to hide · drag to resize' })}
                />
                <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-zinc-200 bg-surface">
                  <WorkspacePanel
                    ref={panelRef}
                    projectId={activeSession.projectId}
                    sessionId={activeSession.sessionId}
                    tabs={editorTabs.tabs}
                    activePath={editorTabs.activePath}
                    onSelectTab={editorTabs.selectTab}
                    onCloseTab={editorTabs.closeTab}
                    onSaveTab={handleSaveTab}
                    onOpenFile={handleEditorOpenFile}
                    onFetchDir={editorTabs.fetchDir}
                    onCreateFile={handleCreateFile}
                    onCreateDir={handleCreateDir}
                    onShowDiff={handleShowDiff}
                    diffView={editorTabs.diffView}
                    onCloseDiff={editorTabs.closeDiff}
                    gitChanges={gitChanges}
                    changesTabActiveRef={changesTabActiveRef}
                    onGitFileClick={handleGitFileClick}
                    gitDiffView={gitDiffView}
                    onCloseGitDiff={handleCloseGitDiff}
                    provider={activeProject?.repoProvider}
                    sessionLive={sessionAlive}
                    shellContent={<WorkspaceShell ref={shellRef} projectId={activeSession.projectId} sessionId={activeSession.sessionId} />}
                    deployContent={activeSession?.projectId ? (
                       <DeployPanel
                         key={`${activeSession.projectId}-${activeSession.sessionId}-${deployVersion}`}
                         ref={deployPanelRef}
                         projectId={activeSession.projectId}
                         sessionId={activeSession.sessionId}
                         onSuccess={onDeploySuccess}
                         onDeployStatus={setDeployStatus}
                         abortRequested={abortRequested}
                       />
                    ) : null}
                    refreshTrigger={editorTabs.treeRefreshTrigger}
                    onDeleteFile={handleDeleteFile}
                    onDeleteDir={handleDeleteDir}
                    onRenameFile={handleRenameFile}
                    onCopyPath={handleCopyPath}
                    panelOpen={panelOpen}
                    onTogglePanel={() => setPanelOpen((p) => !p)}
                  />
                </div>
              </div>
            </div>
            )
          ) : launchingSession ? (
            <div className="flex-1 bg-surface flex flex-col items-center justify-center">
              {workspaceCreating && creationStep ? (
                <CreationProgress
                  currentStep={creationStep}
                  error={launchModalError}
                  onDismiss={() => {
                    setWorkspaceCreating(false);
                    setCreationStep(null);
                    setLaunchingSession(false);
                    setLaunchModalError(null);
                  }}
                />
              ) : null}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center bg-surface p-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 mb-5">
                <TerminalSquare className="w-7 h-7 text-zinc-400" strokeWidth={1.25} />
              </div>
              <h3 className="text-lg font-semibold text-zinc-900 mb-1.5">{t('sessions:empty.no_active_session', { defaultValue: 'No active session' })}</h3>
              <p className="text-sm text-zinc-400 max-w-sm">
                {projects.length === 0
                  ? t('sessions:empty.create_workspace_hint', { defaultValue: 'Create a workspace, then use New Agent in the sidebar to get started.' })
                  : t('sessions:empty.select_session_hint', { defaultValue: 'Select a session from the sidebar, or use New Agent to start one in a workspace.' })}
              </p>
            </div>
          )}
          {showNewInstanceModal && (
            <OnboardingWizard
              mode={wizardMode}
              agents={agents}
              selectedAgentId={selectedAgentId}
              onSelectAgent={(id) => { setSelectedAgentId(id); setShowLaunchConfigModal(false); }}
              customImages={customImages}
              customImageId={customImageId}
              setCustomImageId={setCustomImageId}
              importedProject={importedProject}
              onRepoImported={handleRepoImported}
              onClose={closeOnboarding}
              onLaunch={handleLaunchFromModal}
              onLaunchSession={handleLaunchSessionInWorkspace}
              launching={launchingSession || isLoading || projectCreating}
              launchError={launchModalError}
            />
          )}
            </>
        </div>
      </div>

      {showImportDialog && (
        <RepoImportDialog
          open={showImportDialog}
          onClose={() => setShowImportDialog(false)}
          onImported={() => {
            fetchWorkspaces();
          }}
          fetchWorkspaces={fetchWorkspaces}
        />
      )}

      {viewingFile && (
        <ConsoleDialogShell
          onClose={() => {
            setViewingFile(null);
            setFileContent('');
          }}
          panelClassName={`${consoleDialogPanelClass} w-[min(900px,calc(100vw-2rem))] h-[min(80vh,calc(100vh-2rem))]`}
        >
          <div className={`flex items-center justify-between ${borderHairline} border-b bg-zinc-50 px-4 py-3 shrink-0`}>
            <div className="flex min-w-0 items-center gap-2">
              <FileText className={`w-4 h-4 shrink-0 ${textPlaceholder}`} />
              <span className={`truncate text-sm font-semibold ${textPrimary}`}>{viewingFile.name}</span>
              <span className={`truncate text-xs font-mono ${textPlaceholder}`}>{viewingFile.path}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setViewingFile(null);
                setFileContent('');
              }}
              className={`shrink-0 rounded-md p-1.5 ${textPlaceholder} ${hoverBgTertiary} ${hoverTextPrimary} ${transitionBase}`}
              aria-label={t('common:action.close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className={`${consoleStructuredDialogBodyClass} bg-zinc-50 text-sm font-mono ${textTertiary} whitespace-pre`}>
            {fileContent}
          </div>
        </ConsoleDialogShell>
      )}
    </div>
  );
});
