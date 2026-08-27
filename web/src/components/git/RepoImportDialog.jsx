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

  const selectedRepo = useMemo(
    () => repos.find((r) => r.full_name === selectedFullName) || null,
    [repos, selectedFullName],
  );

  const resetForm = () => {
    setRepos([]);
    setQuery('');
    setSelectedFullName('');
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
      setName(selectedRepo.name || '');
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
    if (!q) return repos;
    return repos.filter((r) => r.full_name?.toLowerCase().includes(q));
  }, [repos, query]);

  const handleImport = async () => {
    if (!selectedFullName) return;
    setImporting(true);
    try {
      const result = await gitApi.importRepo({
        provider,
        repo_full_name: selectedFullName,
        name: name.trim() || selectedRepo?.name,
        branch: branch.trim() || selectedRepo?.default_branch || 'main',
        auto_create_branch: autoCreateBranch,
        work_branch_name: workBranchName.trim() || generateWorkBranchName(''),
      });
      setImportedProjectId(result.id);
      setCloneStatus(result.status || 'cloning');
      showToast('success', 'Import started. Cloning repository…');
    } catch (err) {
      showToast('error', err.message);
      setImporting(false);
    }
  };

  const canImport = Boolean(
    selectedFullName && name.trim() && branch.trim() && (!autoCreateBranch || workBranchName.trim()),
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
                ? 'bg-black text-white'
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
                  ? `An administrator must configure ${providerLabel} OAuth before you can connect.`
                  : `Connect your ${providerLabel} account to import repositories.`}
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
                  <span className="text-sm font-medium">Connect {providerLabel}</span>
                  <span className="text-[11px] text-zinc-400">via OAuth</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPatSectionOpen(true)}
                  className={`flex-1 flex flex-col items-center gap-1.5 px-4 py-3 rounded-lg border-2 border-zinc-200 hover:border-zinc-900 hover:bg-zinc-50 transition-colors ${consoleButtonFocusClass}`}
                >
                  <Link2 className="h-5 w-5" />
                  <span className="text-sm font-medium">{t('git:personal_access_token', { defaultValue: 'Personal Access Token' })}</span>
                  <span className="text-[11px] text-zinc-400">via PAT</span>
                </button>
              </div>
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
              Disconnect
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => switchMode('browse')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${mode === 'browse' ? 'bg-black text-white' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'}`}
            >
              <Search className="h-3 w-3" />
              Browse
            </button>
            <button
              type="button"
              onClick={() => switchMode('url')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${mode === 'url' ? 'bg-black text-white' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'}`}
            >
              <Link2 className="h-3 w-3" />
              Paste URL
            </button>
          </div>

          {mode === 'url' ? (
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
            <FormLabel htmlFor="repo-search">Search repositories</FormLabel>
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
                {filteredRepos.map((repo) => (
                  <li key={repo.id || repo.full_name}>
                    <button
                      type="button"
                      onClick={() => setSelectedFullName(repo.full_name)}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                        selectedFullName === repo.full_name ? 'bg-zinc-100' : 'hover:bg-zinc-50'
                      }`}
                    >
                      <span className="min-w-0 truncate font-medium text-zinc-900">
                        {repo.full_name}
                      </span>
                      <span className="shrink-0 text-xs text-zinc-500">
                        {repo.private ? 'Private' : 'Public'}
                        {repo.language ? ` · ${repo.language}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
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
                  className="rounded border-zinc-300 text-zinc-900 focus:ring-black"
                />
                Auto-create work branch
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
              {cloneError || 'Cloning repository, please wait…'}
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
              Connecting…
            </>
          ) : 'Connect'}
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
              Fetching…
            </>
          ) : 'Fetch repository'}
        </Button>
      )}
      {connection && (selectedRepo || mode === 'browse') && (
        <Button
          type="button"
          size="sm"
          disabled={!canImport || importing}
          onClick={handleImport}
        >
          {importing ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Importing…
            </>
          ) : (
            'Import repository'
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
        title={t('git:import_repository', { defaultValue: 'Import Repository' })}
        subtitle={connection ? 'Select a repository to import as a workspace.' : 'Connect a Git provider to import repositories.'}
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
