import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import AgentConsole from '../components/AgentConsole';
import WorkspaceSwitcher from '../components/WorkspaceSwitcher';
import WorkspaceShell from '../components/WorkspaceShell';
import WorkspacePanel from '../components/WorkspacePanel';
import RepoImportDialog from '../components/git/RepoImportDialog';
import OnboardingWizard from '../components/OnboardingWizard';
import BranchSwitcher, { GIT_REPO_PROVIDERS } from '../components/git/BranchSwitcher';
import { apiFetch } from '../lib/api';
import * as githubApi from '../lib/githubApi';
import * as gitApi from '../lib/gitApi';
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
  Settings2,
  X,
  Power,
  FileText,
  Loader2,
  Trash2,
} from 'lucide-react';
import ByokConfigForm from '../components/ByokConfigForm';
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => {
    const maxW = typeof window !== 'undefined' ? Math.max(720, window.innerWidth - 240) : 800;
    return Math.min(Math.floor(maxW / 2), maxW);
  });
  const panelRowRef = useRef(null);

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

  const editorTabs = useEditorTabs(activeSession?.projectId);
  // Changes 与 Files 共用同一 workspace attach 路径；不能再按 sessionAlive 关掉，
  // 否则编辑器已能保存、Changes 却一直空白（分支显示 —）。
  const changesTabActiveRef = useRef(false);
  const gitChanges = useGitChanges(activeSession?.projectId || null, changesTabActiveRef);
  const preview = usePreview(activeSession?.projectId, Boolean(activeSession?.projectId));
  const { showToast } = useToast();
  const panelRef = useRef(null);
  const shellRef = useRef(null);
  // 每次点小火箭自增，用于强制 DeployPanel remount（重新分析），而不是复用上次内容
  const [deployVersion, setDeployVersion] = useState(0);
  // 最近一次自动部署成功后的结果摘要，展示在 Preview 面板的"部署详情"里
  const [lastDeployInfo, setLastDeployInfo] = useState(null);
  // 自动部署成功 → 关闭 Deploy tab，跳转到 Preview tab（Preview 面板常驻，可展开部署详情）
  const onDeploySuccess = useCallback((info) => {
    setLastDeployInfo(info);
    panelRef.current?.addTab('preview');
    panelRef.current?.selectMainTab('preview');
    panelRef.current?.closeExtraTab('deploy');
    preview.loadDeployments();
  }, [preview.loadDeployments]);

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
    const onMove = (ev) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      const delta = startX - ev.clientX;
      const next = Math.min(maxW, Math.max(420, startW + delta));
      setPanelWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
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
    if (activeSession) setLaunchingSession(false);
  }, [activeSession]);

  useEffect(() => {
    if (!activeSession?.projectId) {
      setPanelOpen(false);
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

  const ensureAgentSecrets = async (agent) => {
    const required = agent?.env_required || [];
    if (required.length === 0 || agent?.llm_auth_mode === 'gateway') return true;
    try {
      const res = await apiFetch('/api/v1/secrets');
      const data = await res.json();
      if (!res.ok) return true;
      const missing = required.filter((k) => !data[k]);
      if (missing.length === 0) return true;
      showToast('warning', `${agent.name} requires API keys. Configure them in Settings > API Keys.`);
      return true;
    } catch {
      return true;
    }
  };

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
        if (res.status === 401 || data.error === 'Unauthorized') {
          throw new Error('Session expired, please log in again.');
        }
        if (data.error === 'quota_exceeded') {
          throw new Error(formatQuotaExceeded(data.dimension || 'max_projects', data.current, data.limit));
        }
        throw new Error(data.error || 'Failed to create workspace');
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
      setLaunchModalError('Could not create workspace for this session.');
      return false;
    }
    setIsLoading(true);
    setLaunchModalError(null);
    setError(null);
    try {
      const ready = await ensureAgentSecrets(selectedAgent);
      if (!ready) {
        setLaunchModalError('Configure required API keys before launching.');
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
        const msg = data.detail || data.error || data.message || 'Failed to start session';
        if (response.status === 401 || msg === 'Unauthorized') {
          setLaunchModalError('Session expired, please log in again.');
          return false;
        }
        if (data.error === 'agent_not_granted') {
          setLaunchModalError('You do not have permission to use this agent.');
          return false;
        }
        if (data.error === 'quota_exceeded') {
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
    setLaunchingSession(true);
    let started = false;
    try {
      if (importedProject?.repo) {
        const repo = importedProject.repo;
        const result = await gitApi.importRepo({
          provider: repo.provider,
          repo_full_name: repo.full_name,
          name: repo.name,
          branch: repo.default_branch,
          auto_create_branch: true,
          work_branch_name: `xensemble/${Date.now()}`,
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
                reject(new Error(res.clone_error || 'Clone failed.'));
              }
            } catch {
              /* keep polling */
            }
            if (attempts >= 150) {
              clearInterval(pollId);
              reject(new Error('Clone is taking longer than expected.'));
            }
          }, 2000);
        });
        started = await handleStartSession(result.id, repo.name, { closeLaunchModal: true });
        return;
      }
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
          setLaunchModalError('Select a workspace first.');
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
      if (!res.ok) throw new Error(data.error || 'Failed to save keys');
      setSavedConfigKeys((prev) => {
        const next = { ...prev };
        Object.keys(payload).forEach((k) => { next[k] = true; });
        return next;
      });
      showToast('success', 'Configuration saved.');
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
      const res = await apiFetch(`/api/v1/workspace/files?${qs}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load workspace files');
      }
    } catch (err) {
      if (notifyError) showToast('error', err.message);
    } finally {
      setIsLoadingFiles(false);
    }
  }, [activeSession?.projectId, showHiddenFiles, showToast]);

  const handleOpenFile = useCallback(async (file) => {
    if (!activeSession?.projectId || file?.type !== 'file') return;
    try {
      const res = await apiFetch(
        `/api/v1/workspace/file?project_id=${encodeURIComponent(activeSession.projectId)}&path=${encodeURIComponent(file.path)}`
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to read file');
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
      showToast('success', 'File deleted.');
    } catch (e) {
      showToast('error', e.message);
    }
  }, [editorTabs.deleteFile, editorTabs.closeTabByPath, editorTabs.bumpTreeRefresh, showToast, gitChanges]);

  const handleDeleteDir = useCallback(async (projectId, path) => {
    if (!path || path === '.' || path === '') {
      showToast('error', 'Cannot delete root directory.');
      return;
    }
    try {
      await editorTabs.deleteDir(projectId, path);
      editorTabs.bumpTreeRefresh();
      gitChanges?.fetchStatus?.({ silent: true });
      showToast('success', 'Folder deleted.');
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
      showToast('success', 'Renamed.');
    } catch (e) {
      showToast('error', e.message);
    }
  }, [editorTabs.moveFile, editorTabs.renameTabPath, editorTabs.bumpTreeRefresh, showToast, gitChanges]);

  const handleCopyPath = useCallback(async (path) => {
    try {
      await navigator.clipboard.writeText(path);
      showToast('success', 'Path copied.');
    } catch {
      showToast('error', 'Failed to copy path.');
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
      showToast('error', 'Cannot start: missing agent or workspace.');
      return;
    }
    const agent = agents.find((a) => a.id === agentId);
    const oldSessionId = sessionId;
    const sessionMeta = sessions.find((s) => s.id === oldSessionId);
    const targetAlive = sessionMeta?.alive === true;
    // Restarting a non-active sidebar session: switch the view to it first.
    if (sessionParam && activeSession?.sessionId !== sessionId) {
      setActiveSession({ sessionId, agentId, agentName: sess.agentName || agent?.name, projectId, projectName });
    }

    setRestartingSession(true);
    try {
      const ready = await ensureAgentSecrets(agent);
      if (!ready) {
        showToast('error', 'Configure required API keys before starting.');
        return;
      }

      if (sessionMeta?.recoverable) {
        if (targetAlive) {
          const stopRes = await apiFetch(`/api/v1/sessions/${encodeURIComponent(oldSessionId)}/stop`, { method: 'POST' });
          const stopData = await stopRes.json();
          if (!stopRes.ok) throw new Error(stopData.error || 'Failed to pause session');
          handleSessionIdle(oldSessionId);
        }
        const response = await apiFetch(`/api/v1/sessions/${encodeURIComponent(oldSessionId)}/resume`, {
          method: 'POST',
          body: JSON.stringify({ terminal_theme_id: themeId }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || 'Failed to resume session');
        setSessions((prev) => prev.map((s) => (
          s.id === oldSessionId ? { ...s, alive: true, status: 'running', memoryStatus: 'running' } : s
        )));
        setReconnectVersion((v) => v + 1);
        fetchWorkspaces();
        showToast('success', targetAlive ? 'Session restarted.' : 'Session resumed.');
        return;
      }

      const deleteRes = await apiFetch(`/api/v1/sessions/${encodeURIComponent(oldSessionId)}`, { method: 'DELETE' });
      if (!deleteRes.ok) throw new Error('Failed to release previous session');
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
      if (!response.ok) throw new Error(data.error || 'Failed to start session');

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
      showToast('success', 'Session started.');
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
      if (!res.ok) throw new Error('Failed to delete session');
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
      workspaceName: ws?.name || 'Unassigned',
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
          throw new Error(data.error || 'Failed to delete workspace');
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
      showToast('success', workspaceId === '_orphan' ? 'Unassigned sessions cleared.' : 'Workspace deleted.');
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

  const handleSessionConnected = useCallback((sessionId) => {
    setSessions((prev) => prev.map((s) => (
      s.id === sessionId ? { ...s, alive: true, status: 'running', memoryStatus: 'running' } : s
    )));
    fetchWorkspaces();
  }, [fetchWorkspaces, setSessions]);

  return (
    <div className={className || 'h-full w-full'}>
      {/* Simple delete confirm */}
      {deleteConfirmSession && (
        <ConsoleInlineDialog onClose={() => setDeleteConfirmSession(null)} panelClassName={`${consoleDialogPanelClass} w-full max-w-md`}>
          <div className={`${consoleStructuredDialogHeaderClass}`}>Confirm</div>
          <div className="p-5 text-sm">Remove this session?</div>
          <div className={consoleStructuredDialogFooterClass}>
            <button onClick={() => setDeleteConfirmSession(null)} className="h-9 px-4 border rounded-md">Cancel</button>
            <button onClick={() => handleDeleteSession(deleteConfirmSession.sessionId)} className="h-9 px-4 bg-red-600 text-white rounded-md">Remove</button>
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
              {deleteConfirmWorkspace.isOrphan ? 'Clear unassigned sessions' : 'Delete workspace'}
            </h3>
          </div>
          <div className={`p-5 text-sm ${textSecondary}`}>
            {deleteConfirmWorkspace.isOrphan ? (
              <>
                Remove all sessions in <span className={`font-medium ${textPrimary}`}>Unassigned</span>?
                {deleteConfirmWorkspace.sessionCount > 0 && (
                  <span>
                    {' '}
                    This will remove {deleteConfirmWorkspace.sessionCount} session
                    {deleteConfirmWorkspace.sessionCount === 1 ? '' : 's'}
                    {deleteConfirmWorkspace.liveCount > 0 && (
                      <> (including {deleteConfirmWorkspace.liveCount} running)</>
                    )}
                    .
                  </span>
                )}
                <p className={`mt-2 text-xs ${textPlaceholder}`}>Unassigned is not a workspace — it groups sessions without a project. Clearing it removes those sessions from history.</p>
              </>
            ) : (
              <>
                Permanently delete <span className={`font-medium ${textPrimary}`}>{deleteConfirmWorkspace.workspaceName}</span>?
                {deleteConfirmWorkspace.sessionCount > 0 && (
                  <span>
                    {' '}
                    This will remove {deleteConfirmWorkspace.sessionCount} session
                    {deleteConfirmWorkspace.sessionCount === 1 ? '' : 's'}
                    {deleteConfirmWorkspace.liveCount > 0 && (
                      <> (including {deleteConfirmWorkspace.liveCount} running)</>
                    )}
                    .
                  </span>
                )}
                <p className={`mt-2 text-xs ${textPlaceholder}`}>All workspace files on the server will be deleted. This frees your workspace quota.</p>
              </>
            )}
          </div>
          <div className={consoleStructuredDialogFooterClass}>
            <button
              type="button"
              onClick={() => setDeleteConfirmWorkspace(null)}
              className={`h-9 px-4 ${bgCanvas} border ${borderHairline} ${textPrimary} rounded-md text-sm font-medium ${hoverBgSecondary} ${transitionBase}`}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deletingWorkspaceId === deleteConfirmWorkspace.workspaceId}
              onClick={() => handleDeleteWorkspace(deleteConfirmWorkspace.workspaceId)}
              className={`h-9 px-4 flex items-center justify-center gap-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50 ${transitionBase}`}
            >
              {deletingWorkspaceId === deleteConfirmWorkspace.workspaceId
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Removing…</>
                : deleteConfirmWorkspace.isOrphan
                  ? 'Clear all'
                  : 'Delete workspace'}
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
              Agent Configuration{activeSession?.agentName ? ` - ${activeSession.agentName}` : ''}
            </h3>
          </div>
          <div className="p-4 space-y-3">
            {sessionConfigError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{sessionConfigError}</p>
            )}
            <ByokConfigForm
              agentId={activeSession.agentId}
              loading={false}
              onSave={() => { setShowSessionConfigModal(false); setSessionConfigError(null); showToast('success', 'Configuration saved.'); }}
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
            <h3 className={`font-semibold text-sm ${textPrimary}`}>Configuration Updated</h3>
          </div>
          <div className="p-4 space-y-2">
            <p className={`text-sm ${textSecondary}`}>
              Configuration has been updated. Restart this session for the changes to take effect.
            </p>
          </div>
          <div className={consoleStructuredDialogFooterClass}>
            <button
              type="button"
              onClick={() => setShowRestartPrompt(false)}
              className={`h-9 px-3 ${bgCanvas} border ${borderHairline} ${textPrimary} rounded-md text-sm font-medium ${hoverBgSecondary} ${transitionBase}`}
            >
              Later
            </button>
            <button
              type="button"
              onClick={() => { setShowRestartPrompt(false); handleRestartSession(); }}
              className={`h-9 px-3 flex items-center justify-center gap-2 bg-black text-white rounded-md text-sm font-medium hover:bg-zinc-700 ${transitionBase}`}
            >
              <Power className="w-4 h-4" /> Restart Now
            </button>
          </div>
        </ConsoleInlineDialog>
      )}

      {/* Main area */}
      <div className="flex min-h-0 flex-1 w-full flex-row items-stretch bg-white">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
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
                {activeSession && (
                  <>
                    <div className="mx-0.5 h-5 w-px bg-zinc-200" />
                    {!sessionPending && !sessionFailed && (
                    <>
                      {!sessionAlive && (
                        <button
                          type="button"
                          onClick={() => handleRestartSession()}
                          disabled={sessionControlPending}
                          className={`${consoleIconButtonClass} disabled:opacity-50 disabled:cursor-not-allowed`}
                          title={restartingSession ? 'Starting…' : 'Start session'}
                          aria-label={restartingSession ? 'Starting session' : 'Start session'}
                        >
                          {restartingSession ? (
                            <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} />
                          ) : (
                            <Play className="w-4 h-4" strokeWidth={1.75} />
                          )}
                        </button>
                      )}
                    </>
                  )}
                  {activeSession.projectId ? (
                    <>
                      <div className="mx-0.5 h-5 w-px bg-zinc-200" />
                      <PreviewControlGroup {...preview} onAnalyze={() => { panelRef.current?.addTab('deploy'); setDeployVersion((v) => v + 1); }} />
                    </>
                  ) : null}
                  </>
                )}
              </div>
            </>,
            topbarEl
          )}
          {activeSession ? (
            sessionPending ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-white p-8 text-center">
                <Loader2 className="w-8 h-8 text-zinc-400 animate-spin mb-4" strokeWidth={1.5} />
                <h3 className="text-lg font-semibold text-zinc-900 mb-1.5">Preparing your environment…</h3>
                <p className="text-sm text-zinc-400 max-w-sm">
                  Pulling image and starting virtual machine. This usually takes less than a minute.
                </p>
              </div>
            ) : sessionFailed ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-white p-8 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 mb-5">
                  <X className="w-7 h-7 text-red-600" strokeWidth={1.5} />
                </div>
                <h3 className="text-lg font-semibold text-zinc-900 mb-1.5">Session failed to start</h3>
                <p className="text-sm text-zinc-400 max-w-md mb-5">
                  {activeSessionMeta?.provisioningError || 'An unexpected error occurred during provisioning.'}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleDeleteSession(activeSession.sessionId)}
                    className="h-9 px-4 flex items-center gap-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" strokeWidth={1.75} />
                    Delete session
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveSession(null)}
                    className="h-9 px-4 flex items-center gap-2 bg-white border border-zinc-200 text-zinc-900 rounded-md text-sm font-medium hover:bg-zinc-100 transition-colors"
                  >
                    Dismiss
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
                    sessionLive={sessionAlive}
                    sessionWakeable={sessionWakeable}
                  />
                </div>
                {!panelOpen && (
                  <button
                    type="button"
                    onClick={() => setPanelOpen(true)}
                    title="Open workspace panel"
                    aria-label="Open workspace panel"
                    className="absolute right-0 top-0 h-full w-1.5 shrink-0 bg-zinc-200/40 hover:bg-zinc-400 transition-colors z-10"
                  />
                )}
              </div>
              {panelOpen && (
                <>
                <div
                  onMouseDown={startPanelResize}
                  className="w-1 shrink-0 cursor-col-resize bg-zinc-200 hover:bg-black transition-colors"
                  title="Click to hide · drag to resize"
                />
                <div className="flex min-h-0 shrink-0 flex-col border-l border-zinc-200 bg-white" style={{ width: panelWidth }}>
                  <WorkspacePanel
                    ref={panelRef}
                    projectId={activeSession.projectId}
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
                    shellContent={<WorkspaceShell ref={shellRef} projectId={activeSession.projectId} />}
                    deployContent={activeSession?.projectId ? (
                      <DeployPanel
                        key={`${activeSession.projectId}-${deployVersion}`}
                        projectId={activeSession.projectId}
                        onSuccess={onDeploySuccess}
                      />
                    ) : null}
                    previewDeployInfo={lastDeployInfo}
                    refreshTrigger={editorTabs.treeRefreshTrigger}
                    onDeleteFile={handleDeleteFile}
                    onDeleteDir={handleDeleteDir}
                    onRenameFile={handleRenameFile}
                    onCopyPath={handleCopyPath}
                    panelOpen={panelOpen}
                    onTogglePanel={() => setPanelOpen((p) => !p)}
                  />
                </div>
                </>
              )}
            </div>
            )
          ) : launchingSession ? (
            <div className="flex-1 bg-white" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center bg-white p-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 mb-5">
                <TerminalSquare className="w-7 h-7 text-zinc-400" strokeWidth={1.25} />
              </div>
              <h3 className="text-lg font-semibold text-zinc-900 mb-1.5">No active session</h3>
              <p className="text-sm text-zinc-400 max-w-sm">
                {projects.length === 0
                  ? 'Create a workspace, then use New Agent in the sidebar to get started.'
                  : 'Select a session from the sidebar, or use New Agent to start one in a workspace.'}
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
              aria-label="Close"
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
