import { useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Loader2, Search, AlertCircle, Link2 } from 'lucide-react';
import {
  ConsoleDialogShell,
  ConsoleStructuredDialogHeader,
  ConsoleStructuredDialogBody,
  ConsoleStructuredDialogFooter,
} from '../ConsoleDialog';
import Input, { FormLabel } from '../Input';
import Button from '../Button';
import GitConnectButton from './GitConnectButton';
import GitOAuthAlert from './GitOAuthAlert';
import { useGitProvider } from '../../hooks/useGitProvider';
import { formatGitOAuthError } from '../../lib/gitLabels';
import { useToast } from '../Toast';
import * as gitApi from '../../lib/gitApi';
import { generateWorkBranchName } from '../../lib/gitApi';
import { computeSelectionState, toggleRepo, prefixOf } from '../../lib/repoSelection';
import * as githubApi from '../../lib/githubApi';
import {
  consoleDialogLgClass,
  consoleButtonFocusClass,
  textPlaceholder,
  textPrimary,
  textSecondary,
  borderHairline,
} from '../../lib/consoleTokens';

const CLONE_POLL_INTERVAL_MS = 2000;
const MAX_CLONE_POLL_ATTEMPTS = 300;

function parseRepoUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let path = trimmed;
  // Only treat as URL if it starts with http(s) or contains a dot in the
  // first segment (e.g. github.com/owner/repo). Otherwise it's likely a
  // bare owner/repo path and new URL would misinterpret "owner" as hostname.
  const looksLikeUrl = /^https?:\/\//i.test(trimmed) || /^[^/]+\.[^/]+\//.test(trimmed);
  if (looksLikeUrl) {
    try {
      const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
      path = url.pathname;
    } catch {
      path = trimmed;
    }
  }
  path = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/(tree|blob)\/.*$/, '').replace(/\/+$/, '');
  return path || null;
}

function normalizeRepo(repo) {
  const fullName = repo.full_name || repo.fullName || '';
  return {
    ...repo,
    full_name: fullName,
    name: repo.name || fullName.split('/').pop() || '',
    default_branch: repo.default_branch || repo.defaultBranch || 'main',
  };
}

const PROVIDER_OPTIONS = [
  { id: 'github', label: 'GitHub' },
  { id: 'gitlab', label: 'GitLab' },
  { id: 'gitea', label: 'Gitea' },
];

export default function RepoImportDialog({ open, onClose, onImported, fetchWorkspaces, inline = false, forceProvider = null }) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [provider, setProvider] = useState(forceProvider || 'github');
  const [providerButtonsVisible, setProviderButtonsVisible] = useState(!forceProvider);
  const { connection, loading: connectionLoading, error: connectError, connect, connectWithPat, disconnect } = useGitProvider(provider);
  const [providerOAuthConfigured, setProviderOAuthConfigured] = useState(null);

  const [repos, setRepos] = useState([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedFullName, setSelectedFullName] = useState('');
  // 多选勾选（多仓库导入）：勾选第一个仓库后按 full_name 前缀锁定组
  const [selectedIds, setSelectedIds] = useState([]);
  const [mode, setMode] = useState('browse');
  const [urlInput, setUrlInput] = useState('');
  const [urlFetching, setUrlFetching] = useState(false);
  const [urlError, setUrlError] = useState(null);
  const urlInputRef = useRef(null);
  const repoReqIdRef = useRef(0);

  const [patToken, setPatToken] = useState('');
  const [patConnecting, setPatConnecting] = useState(false);
  const [patError, setPatError] = useState(null);
  const [patSectionOpen, setPatSectionOpen] = useState(false);

  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [workBranchName, setWorkBranchName] = useState(() => generateWorkBranchName(''));
  const [autoCreateBranch, setAutoCreateBranch] = useState(true);

  const [importing, setImporting] = useState(false);
  const [importedProjectId, setImportedProjectId] = useState(null);
  const [cloneStatus, setCloneStatus] = useState(null);
  const [cloneError, setCloneError] = useState(null);
  // URL-only import (no provider connection required)
  const [urlOnly, setUrlOnly] = useState(false);
  const [urlOnlyInput, setUrlOnlyInput] = useState('');
  const [urlOnlyName, setUrlOnlyName] = useState('');
  const [urlOnlyBranch, setUrlOnlyBranch] = useState('');
  const [urlOnlyImporting, setUrlOnlyImporting] = useState(false);
  const [urlOnlyError, setUrlOnlyError] = useState(null);
  const urlOnlyInputRef = useRef(null);

  // 仓库 id 兜底（URL fetch 的仓库可能无 id，用 full_name 作为稳定 key）
  const reposWithIds = useMemo(
    () => repos.map((r) => ({ ...r, id: r.id ?? r.full_name })),
    [repos],
  );
  const selection = useMemo(
    () => computeSelectionState(reposWithIds, selectedIds),
    [reposWithIds, selectedIds],
  );
  const selectedRepos = useMemo(
    () => selection.filter((r) => selectedIds.includes(r.id)),
    [selection, selectedIds],
  );

  const selectedRepo = useMemo(
    () => selectedRepos[0] || reposWithIds.find((r) => r.full_name === selectedFullName) || null,
    [selectedRepos, reposWithIds, selectedFullName],
  );

  const resetForm = () => {
    setRepos([]);
    setQuery('');
    setSelectedFullName('');
    setSelectedIds([]);
    setMode('browse');
    setUrlInput('');
    setUrlFetching(false);
    setUrlError(null);
    setName('');
    setBranch('');
    setWorkBranchName(generateWorkBranchName(''));
    setAutoCreateBranch(true);
    setImporting(false);
    setImportedProjectId(null);
    setCloneStatus(null);
    setCloneError(null);
    setPatToken('');
    setPatConnecting(false);
    setPatError(null);
    setPatSectionOpen(false);
    setUrlOnly(false);
    setUrlOnlyInput('');
    setUrlOnlyName('');
    setUrlOnlyBranch('');
    setUrlOnlyImporting(false);
    setUrlOnlyError(null);
  };

  const handleConnectPat = async () => {
    setPatConnecting(true);
    setPatError(null);
    try {
      const ok = await connectWithPat(patToken.trim());
      if (ok) {
        setPatToken(''); // Do not keep the token in the dialog after connecting.
        setPatSectionOpen(false);
      }
    } catch (err) {
      setPatError(err.message);
    } finally {
      setPatConnecting(false);
    }
  };

  const handleClose = () => {
    if (importing && !cloneStatus) return;
    resetForm();
    onClose();
  };

  const loadRepos = async () => {
    const reqId = ++repoReqIdRef.current;
    setReposLoading(true);
    try {
      const data = await gitApi.listRepos(provider, { per_page: '100' });
      if (reqId !== repoReqIdRef.current) return;
      const rows = data.repos || data;
      setRepos(Array.isArray(rows) ? rows.map(normalizeRepo) : []);
    } catch (err) {
      if (reqId !== repoReqIdRef.current) return;
      showToast('error', err.message);
      setRepos([]);
    } finally {
      if (reqId === repoReqIdRef.current) setReposLoading(false);
    }
  };

  const handleFetchUrl = async () => {
    const repoPath = parseRepoUrl(urlInput);
    if (!repoPath) {
      setUrlError('Invalid URL. Use owner/repo or https://github.com/owner/repo');
      return;
    }
    setUrlFetching(true);
    setUrlError(null);
    try {
      const data = await gitApi.getRepo(provider, repoPath);
      const repo = normalizeRepo(data.repo || data);
      setRepos((prev) => prev.some((r) => r.full_name === repo.full_name) ? prev : [...prev, repo]);
      setSelectedFullName(repo.full_name);
    } catch (err) {
      setUrlError(err.message || 'Repository not found or no access');
    } finally {
      setUrlFetching(false);
    }
  };

  const switchMode = (next) => {
    setMode(next);
    setUrlError(null);
    if (next === 'url') {
      requestAnimationFrame(() => urlInputRef.current?.focus());
    }
  };

  useEffect(() => {
    if (!open && !inline) {
      resetForm();
      setProviderOAuthConfigured(null);
      return;
    }
    gitApi.listProviders()
      .then((data) => {
        const map = {};
        for (const p of data.providers || []) {
          map[p.name] = p.oauth_configured ?? p.oauthConfigured ?? false;
        }
        setProviderOAuthConfigured(map);
      })
      .catch(() => setProviderOAuthConfigured({}));
    if (connection) loadRepos();
  }, [open, inline, connection, provider]);

  const oauthNotConfigured = providerOAuthConfigured?.[provider] === false;
  const oauthAlertMessage = connectError
    || (oauthNotConfigured ? `${provider} OAuth is not configured` : null);

  useEffect(() => {
    if (selectedRepo) {
      // 多选时 name 由 handleToggle 以 "repoA+repoB" 连接填充，这里只锚定单选
      if (selectedIds.length <= 1) setName(selectedRepo.name || '');
      setBranch(selectedRepo.default_branch || 'main');
    }
  }, [selectedRepo]);

  useEffect(() => {
    if (!importedProjectId || cloneStatus === 'ready' || cloneStatus === 'failed') return;
    let attempts = 0;
    const id = setInterval(async () => {
      attempts += 1;
      try {
        await fetchWorkspaces?.();
        const res = await githubApi.getCloneStatus(importedProjectId);
        if (res?.clone_status === 'ready') {
          setCloneStatus('ready');
          clearInterval(id);
          showToast('success', 'Repository imported and ready.');
          onImported?.(importedProjectId);
          if (!inline) handleClose();
        } else if (res?.clone_status === 'failed') {
          setCloneStatus('failed');
          setCloneError(res.clone_error || 'Clone failed. Please check your repository URL and credentials.');
          clearInterval(id);
        }
      } catch {
        // Still cloning or endpoint temporarily unavailable
      }
      if (attempts >= MAX_CLONE_POLL_ATTEMPTS) {
        clearInterval(id);
        setCloneError('Clone is taking longer than expected. It will continue in the background.');
      }
    }, CLONE_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [importedProjectId, cloneStatus, fetchWorkspaces, onImported, showToast]);

  const filteredRepos = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reposWithIds;
    return reposWithIds.filter((r) => r.full_name?.toLowerCase().includes(q));
  }, [reposWithIds, query]);

  const handleToggle = (repo) => {
    // 跨前缀仓库不可勾选（enabled=false 时点击无效）
    if (!repo.enabled && !selectedIds.includes(repo.id)) return;
    const next = toggleRepo(selectedIds, repo);
    setSelectedIds(next);
    // 锚定第一个勾选仓库，驱动 name/branch 默认值
    const first = next.length > 0 ? reposWithIds.find((r) => r.id === next[0]) : null;
    setSelectedFullName(first ? first.full_name : '');
    // 多仓库：默认名称 = 所选仓库名以 "+" 连接（保持仓库列表顺序）；
    // 单选恢复为该仓库名
    if (next.length > 1) {
      const joined = reposWithIds
        .filter((r) => next.includes(r.id))
        .map((r) => r.name)
        .filter(Boolean)
        .join('+');
      if (joined) setName(joined);
    } else if (next.length === 1 && first) {
      setName(first.name || '');
    }
  };

  const handleImport = async () => {
    if (!selectedRepo) return;
    setImporting(true);
    try {
      let result;
      if (selectedIds.length > 1) {
        // 多仓库：一次 import-git repos[] → 1 个 project + N 条 project_repos
        result = await gitApi.importRepo({
          provider,
          name: name.trim() || undefined,
          repos: selectedRepos.map((r, idx) => ({
            repo_full_name: r.full_name,
            role: 'custom',
            sub_path: r.name,
            branch: r.default_branch || 'main',
            is_primary: idx === 0,
          })),
        });
      } else {
        // 单仓库：原逻辑（向后兼容）
        result = await gitApi.importRepo({
          provider,
          repo_full_name: selectedRepo.full_name,
          name: name.trim() || selectedRepo.name,
          branch: branch.trim() || selectedRepo.default_branch || 'main',
          auto_create_branch: autoCreateBranch,
          work_branch_name: workBranchName.trim() || generateWorkBranchName(''),
        });
      }
      setImportedProjectId(result.id);
      setCloneStatus(result.status || 'cloning');
      showToast('success', t('git:import_started', { defaultValue: 'Import started. Cloning repositories…' }));
    } catch (err) {
      showToast('error', err.message);
      setImporting(false);
    }
  };

  const handleImportByUrl = async () => {
    const raw = urlOnlyInput.trim();
    if (!raw) {
      setUrlOnlyError(t('git:url_required', { defaultValue: 'Repository URL is required' }));
      return;
    }
    // 支持分号 ";" 分隔多个仓库 URL，一次导入多个仓库
    const urls = raw.split(';').map((s) => s.trim()).filter(Boolean);
    if (urls.length === 0) {
      setUrlOnlyError(t('git:url_required', { defaultValue: 'Repository URL is required' }));
      return;
    }
    setUrlOnlyImporting(true);
    setUrlOnlyError(null);
    try {
      let result;
      if (urls.length > 1) {
        // 多仓库：构造 repos[]（后端多仓库分支已支持每项 repo_url），
        // 项目名留空时后端自动以 "仓库a+仓库b" 命名
        const baseBranch = urlOnlyBranch.trim() || undefined;
        const usedSubPaths = new Set();
        const repos = urls.map((u, idx) => {
          let subPath = (parseRepoUrl(u) || u).split('/').filter(Boolean).pop().replace(/\.git$/, '') || `repo-${idx + 1}`;
          if (usedSubPaths.has(subPath)) subPath = `${subPath}-${idx + 1}`;
          usedSubPaths.add(subPath);
          return {
            repo_url: u,
            role: 'custom',
            sub_path: subPath,
            branch: baseBranch,
            is_primary: idx === 0,
          };
        });
        result = await gitApi.importRepo({
          name: urlOnlyName.trim() || undefined,
          repos,
        });
      } else {
        // 单仓库：原逻辑（顶层 repo_url，向后兼容）
        result = await gitApi.importRepo({
          repo_url: urls[0],
          name: urlOnlyName.trim() || undefined,
          branch: urlOnlyBranch.trim() || undefined,
          auto_create_branch: false,
        });
      }
      setImportedProjectId(result.id);
      setCloneStatus(result.status || 'cloning');
      showToast('success', t('git:import_started', { defaultValue: 'Import started. Cloning repositories…' }));
    } catch (err) {
      setUrlOnlyError(err.message || 'Import failed. Please check the repository URL.');
      setUrlOnlyImporting(false);
    }
  };

  const canImport = Boolean(
    selectedIds.length > 0 && selectedRepo && name.trim() && branch.trim() && (!autoCreateBranch || workBranchName.trim()),
  );

  const username = connection?.remote_username || connection?.remoteUsername
    || connection?.github_username || connection?.githubUsername || '';
  const providerLabel = PROVIDER_OPTIONS.find((p) => p.id === provider)?.label || provider;

  const patSection = (
    <div className="space-y-2">
      <FormLabel htmlFor="pat-token">{t('git:personal_access_token', { defaultValue: 'Personal Access Token' })}</FormLabel>
      <Input
        id="pat-token"
        type="password"
        value={patToken}
        onChange={(e) => setPatToken(e.target.value)}
        placeholder={`Paste a ${providerLabel} personal access token`}
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
      />
      {patError && (
        <div className="flex items-center gap-1.5 text-xs text-red-600">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {patError}
        </div>
      )}
    </div>
  );

  if (!open && !inline) return null;

  const urlOnlyForm = (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className={textSecondary}>
          {t('git:import_by_url_hint', { defaultValue: 'Paste any git repository URL. No account connection needed.' })}
        </p>
        <button
          type="button"
          onClick={() => { setUrlOnly(false); setUrlOnlyError(null); }}
          className="text-xs text-zinc-500 hover:text-zinc-900"
        >
          {connection ? t('git:back_to_browse', { defaultValue: 'Back' }) : t('git:back_to_connect', { defaultValue: 'Connect account' })}
        </button>
      </div>
      <div>
        <FormLabel htmlFor="url-only-repo">{t('git:repository_url', { defaultValue: 'Repository URL' })}</FormLabel>
        <Input
          ref={urlOnlyInputRef}
          id="url-only-repo"
          value={urlOnlyInput}
          onChange={(e) => setUrlOnlyInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !urlOnlyImporting) handleImportByUrl(); }}
          placeholder="https://github.com/owner/repo;https://gitlab.com/owner/repo"
          className="mt-1.5 font-mono"
          disabled={urlOnlyImporting}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FormLabel htmlFor="url-only-name">{t('git:project_name', { defaultValue: 'Project name' })}</FormLabel>
          <Input
            id="url-only-name"
            value={urlOnlyName}
            onChange={(e) => setUrlOnlyName(e.target.value)}
            placeholder={t('git:optional_placeholder', { defaultValue: 'optional' })}
            className="mt-1.5"
          />
        </div>
        <div>
          <FormLabel htmlFor="url-only-branch">{t('git:base_branch', { defaultValue: 'Base branch' })}</FormLabel>
          <Input
            id="url-only-branch"
            value={urlOnlyBranch}
            onChange={(e) => setUrlOnlyBranch(e.target.value)}
            placeholder="main"
            className="mt-1.5"
          />
        </div>
      </div>
      {urlOnlyError && (
        <div className="flex items-center gap-1.5 text-xs text-red-600">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {urlOnlyError}
        </div>
      )}
      {importedProjectId && (
        <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${cloneStatus === 'failed' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
          {cloneStatus === 'failed' ? (
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          )}
          {cloneError || t('git:cloning_repository')}
        </div>
      )}
    </div>
  );

  const dialogBody = (
    <>
      {providerButtonsVisible && (
      <div className="flex items-center gap-2 mb-4">
        {PROVIDER_OPTIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => { setProvider(p.id); setRepos([]); setSelectedFullName(''); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              provider === p.id
                ? 'bg-zinc-900 text-zinc-50'
                : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900'
            }`}
          >
            {p.label}
            {providerOAuthConfigured?.[p.id] === false && (
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  provider === p.id ? 'bg-red-100' : 'bg-red-600'
                }`}
                title={t('git:oauth_not_configured_title', { defaultValue: 'OAuth not configured' })}
              />
            )}
          </button>
        ))}
      </div>
      )}

      {!connection ? (
        <div className="space-y-4">
          {urlOnly ? urlOnlyForm : (
            <>
              {oauthAlertMessage && (
                <GitOAuthAlert message={oauthAlertMessage} provider={provider} />
              )}
              {patSectionOpen ? (
                <div className="space-y-3">
                  {patSection}
                </div>
              ) : (
                <>
                  <p className={textSecondary}>
                    {oauthNotConfigured
                      ? t('git:oauth_admin_required', { label: providerLabel })
                      : t('git:connect_account_hint', { label: providerLabel })}
                  </p>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={connect}
                      disabled={connectionLoading || oauthNotConfigured}
                      className={`flex-1 flex flex-col items-center gap-1.5 px-4 py-3 rounded-lg border-2 transition-colors ${consoleButtonFocusClass} ${
                        oauthNotConfigured
                          ? 'border-zinc-200 bg-zinc-100 text-zinc-400 cursor-not-allowed'
                          : 'border-zinc-200 hover:border-zinc-900 hover:bg-zinc-50'
                      }`}
                    >
                      <GitBranch className="h-5 w-5" />
                      <span className="text-sm font-medium">{t('git:connect_to', { label: providerLabel })}</span>
                      <span className="text-[11px] text-zinc-400">{t('git:via_oauth')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPatSectionOpen(true)}
                      className={`flex-1 flex flex-col items-center gap-1.5 px-4 py-3 rounded-lg border-2 border-zinc-200 hover:border-zinc-900 hover:bg-zinc-50 transition-colors ${consoleButtonFocusClass}`}
                    >
                      <Link2 className="h-5 w-5" />
                      <span className="text-sm font-medium">{t('git:personal_access_token')}</span>
                      <span className="text-[11px] text-zinc-400">{t('git:via_pat')}</span>
                    </button>
                  </div>
                  <div className="relative flex items-center gap-3 py-1">
                    <div className="h-px flex-1 bg-zinc-200" />
                    <span className="text-[10px] uppercase tracking-wider text-zinc-400">{t('git:or_import_by_url', { defaultValue: 'or import by URL' })}</span>
                    <div className="h-px flex-1 bg-zinc-200" />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setUrlOnly(true);
                      setUrlOnlyError(null);
                      requestAnimationFrame(() => urlOnlyInputRef.current?.focus());
                    }}
                    className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-zinc-300 hover:border-zinc-900 hover:bg-zinc-50 transition-colors text-sm font-medium text-zinc-600 hover:text-zinc-900 ${consoleButtonFocusClass}`}
                  >
                    <Link2 className="h-4 w-4" />
                    {t('git:import_by_url', { defaultValue: 'Import by URL' })}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-zinc-400" />
              <span className={`text-sm font-medium ${textPrimary}`}>{username}</span>
              <span className="text-xs text-zinc-400">
                ({provider}
                {connection.connection_type === 'pat' ? ' · PAT' : ''})
              </span>
            </div>
            <button
              type="button"
              onClick={disconnect}
              disabled={connectionLoading}
              className="text-xs text-zinc-500 hover:text-zinc-900"
            >
              {t('git:disconnect', { label: providerLabel })}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => switchMode('browse')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${mode === 'browse' && !urlOnly ? 'bg-zinc-900 text-zinc-50' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'}`}
            >
              <Search className="h-3 w-3" />
              {t('git:browse')}
            </button>
            <button
              type="button"
              onClick={() => switchMode('url')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${mode === 'url' && !urlOnly ? 'bg-zinc-900 text-zinc-50' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'}`}
            >
              <Link2 className="h-3 w-3" />
              {t('git:paste_url')}
            </button>
            <button
              type="button"
              onClick={() => { setUrlOnly(true); setMode('browse'); setUrlOnlyError(null); requestAnimationFrame(() => urlOnlyInputRef.current?.focus()); }}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${urlOnly ? 'bg-zinc-900 text-zinc-50' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'}`}
            >
              <Link2 className="h-3 w-3" />
              {t('git:import_by_url', { defaultValue: 'Import by URL' })}
            </button>
          </div>

          {urlOnly ? (
            urlOnlyForm
          ) : mode === 'url' ? (
            <div className="space-y-2">
              <div>
                <FormLabel htmlFor="repo-url">{t('git:repository_url', { defaultValue: 'Repository URL' })}</FormLabel>
                <div className="relative mt-1.5">
                  <Link2 className={`pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 ${textPlaceholder}`} />
                  <Input
                    ref={urlInputRef}
                    id="repo-url"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !urlFetching) handleFetchUrl(); }}
                    placeholder="https://github.com/owner/repo"
                    className="pl-8"
                    disabled={urlFetching}
                  />
                </div>
              </div>
              {urlError && (
                <div className="flex items-center gap-1.5 text-xs text-red-600">
                  <AlertCircle className="h-3 w-3 shrink-0" />
                  {urlError}
                </div>
              )}
              {selectedRepo && mode === 'url' && (
                <div className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
                  <span className="min-w-0 truncate text-sm font-medium text-zinc-900">{selectedRepo.full_name}</span>
                  <span className="shrink-0 text-xs text-zinc-500">{selectedRepo.private ? 'Private' : 'Public'}{selectedRepo.language ? ` · ${selectedRepo.language}` : ''}</span>
                </div>
              )}
            </div>
          ) : (
          <>
          <div>
            <FormLabel htmlFor="repo-search">{t('git:search_repositories_label')}</FormLabel>
            <div className="relative mt-1.5">
              <Search className={`pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 ${textPlaceholder}`} />
              <Input
                id="repo-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="owner/repo"
                className="pl-8"
              />
            </div>
          </div>

          <div className={`max-h-48 overflow-auto rounded-lg border ${borderHairline}`}>
            {reposLoading ? (
              <div className="flex items-center justify-center gap-2 p-4 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('git:loading_repositories', { defaultValue: 'Loading repositories…' })}
              </div>
            ) : filteredRepos.length === 0 ? (
              <div className="p-4 text-center text-sm text-zinc-500">
                {repos.length === 0 ? t('git:no_repositories', { defaultValue: 'No repositories found.' }) : t('git:no_matches', { defaultValue: 'No matches.' })}
              </div>
            ) : (
              <ul className="divide-y divide-zinc-200">
                {filteredRepos.map((repo) => {
                  const state = selection.find((s) => s.id === repo.id)
                    || { enabled: true, checked: false };
                  const toggle = () => handleToggle({ ...repo, enabled: state.enabled });
                  // 锁定组提示走 title 悬停（不插入元素，避免列表高度跳动）
                  const lockedHint = !state.enabled
                    ? t('git:import_multi_locked_row', {
                        defaultValue: 'Locked to group "{{prefix}}" — only repositories under the same group can be selected.',
                        prefix: prefixOf(selectedRepos[0]?.full_name || ''),
                      })
                    : undefined;
                  return (
                    <li key={repo.id ?? repo.full_name}>
                      <button
                        type="button"
                        disabled={!state.enabled}
                        onClick={toggle}
                        title={lockedHint}
                        data-testid={`repo-row-${repo.full_name}`}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                          state.checked ? 'bg-zinc-100' : 'hover:bg-zinc-50'
                        } ${!state.enabled ? 'cursor-not-allowed opacity-40' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={state.checked}
                          disabled={!state.enabled}
                          onChange={toggle}
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                        />
                        <span className="min-w-0 truncate font-medium text-zinc-900">
                          {repo.full_name}
                        </span>
                        <span className="shrink-0 text-xs text-zinc-500">
                          {repo.private ? 'Private' : 'Public'}
                          {repo.language ? ` · ${repo.language}` : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          </>
          )}

          {selectedRepo && (
            <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FormLabel htmlFor="import-name">{t('git:project_name', { defaultValue: 'Project name' })}</FormLabel>
                  <Input
                    id="import-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="my-project"
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <FormLabel htmlFor="import-branch">{t('git:base_branch', { defaultValue: 'Base branch' })}</FormLabel>
                  <Input
                    id="import-branch"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="main"
                    className="mt-1.5"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={autoCreateBranch}
                  onChange={(e) => setAutoCreateBranch(e.target.checked)}
                  className="rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                />
                {t('git:auto_create_work_branch')}
              </label>

              {autoCreateBranch && (
                <div>
                  <FormLabel htmlFor="import-work-branch">{t('git:work_branch_name', { defaultValue: 'Work branch name' })}</FormLabel>
                  <Input
                    id="import-work-branch"
                    value={workBranchName}
                    onChange={(e) => setWorkBranchName(e.target.value)}
                    placeholder="agentharness/my-repo-a1b2"
                    className="mt-1.5"
                  />
                </div>
              )}
            </div>
          )}

          {importedProjectId && (
            <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${cloneStatus === 'failed' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
              {cloneStatus === 'failed' ? (
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              )}
              {cloneError || t('git:cloning_repository')}
            </div>
          )}
        </div>
      )}
    </>
  );

  const dialogFooter = (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={patSectionOpen ? () => { setPatSectionOpen(false); setPatError(null); } : handleClose}
        disabled={importing && !cloneStatus}
      >
        {patSectionOpen ? t('common:action.back') : t('common:action.cancel')}
      </Button>
      {patSectionOpen && !connection && (
        <Button
          type="button"
          size="sm"
          disabled={!patToken.trim() || patConnecting}
          onClick={handleConnectPat}
        >
          {patConnecting ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {t('git:connecting')}
            </>
          ) : t('git:connect')}
        </Button>
      )}
      {urlOnly && !connection && (
        <Button
          type="button"
          size="sm"
          disabled={urlOnlyImporting || !urlOnlyInput.trim() || Boolean(importedProjectId && cloneStatus !== 'failed')}
          onClick={handleImportByUrl}
        >
          {urlOnlyImporting ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {t('git:importing')}
            </>
          ) : t('git:import_repository')}
        </Button>
      )}
      {connection && mode === 'url' && !selectedRepo && (
        <Button
          type="button"
          size="sm"
          disabled={urlFetching || !urlInput.trim()}
          onClick={handleFetchUrl}
        >
          {urlFetching ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {t('git:fetching_repository')}
            </>
          ) : t('git:fetch_repository')}
        </Button>
      )}
      {connection && (selectedRepo || mode === 'browse') && (
        <Button
          type="button"
          size="sm"
          disabled={!canImport || importing}
          onClick={handleImport}
          data-testid="import-submit"
        >
          {importing ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {t('git:importing')}
            </>
          ) : selectedIds.length > 1 ? (
            t('git:import_multi_submit', { count: selectedIds.length, defaultValue: 'Import {{count}} repositories' })
          ) : (
            t('git:import_repository')
          )}
        </Button>
      )}
    </>
  );

  if (inline) {
    return (
      <div className="space-y-4">
        {dialogBody}
        <div className="flex items-center justify-end gap-2">
          {dialogFooter}
        </div>
      </div>
    );
  }

  return (
    <ConsoleDialogShell
      onClose={handleClose}
      panelClassName={`${consoleDialogLgClass} max-h-[calc(100vh-2rem)]`}
    >
      <ConsoleStructuredDialogHeader
        title={t('git:import_repository')}
        subtitle={connection ? t('git:import_subtitle') : t('git:connect_subtitle')}
      />
      <ConsoleStructuredDialogBody>
        {dialogBody}
      </ConsoleStructuredDialogBody>
      <ConsoleStructuredDialogFooter>
        {dialogFooter}
      </ConsoleStructuredDialogFooter>
    </ConsoleDialogShell>
  );
}
