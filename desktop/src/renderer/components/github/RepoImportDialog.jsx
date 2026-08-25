import React, { useEffect, useMemo, useState } from 'react';
import { Github, Loader2, RefreshCw, Search } from 'lucide-react';
import {
  ConsoleDialogShell,
  ConsoleStructuredDialogHeader,
  ConsoleStructuredDialogBody,
  ConsoleStructuredDialogFooter,
} from '../ConsoleDialog';
import Input, { FormLabel } from '../Input';
import Button from '../Button';
import GitHubConnectButton from './GitHubConnectButton';
import { useGitHub } from '../../hooks/useGitHub';
import { useToast } from '../Toast';
import * as githubApi from '../../lib/githubApi.js';
import {
  consoleDialogLgClass,
  textPlaceholder,
  textPrimary,
  textSecondary,
  borderHairline,
} from '../../lib/consoleTheme';
import { useTranslation } from 'react-i18next';

const CLONE_POLL_INTERVAL_MS = 2000;
const MAX_CLONE_POLL_ATTEMPTS = 300; // 10 minutes

function formatUpdatedAt(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  return isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

export default function RepoImportDialog({ open, onClose, onImported, fetchWorkspaces }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { connection, loading: connectionLoading, connect, disconnect } = useGitHub();

  const [repos, setRepos] = useState([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedFullName, setSelectedFullName] = useState('');

  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [workBranchName, setWorkBranchName] = useState(`xensemble/${Date.now()}`);
  const [autoCreateBranch, setAutoCreateBranch] = useState(true);

  const [importing, setImporting] = useState(false);
  const [importedProjectId, setImportedProjectId] = useState(null);
  const [cloneStatus, setCloneStatus] = useState(null);
  const [cloneError, setCloneError] = useState(null);

  const selectedRepo = useMemo(
    () => repos.find((r) => r.full_name === selectedFullName) || null,
    [repos, selectedFullName],
  );

  useEffect(() => {
    if (!open) {
      resetForm();
      return;
    }
    if (connection) {
      loadRepos();
    }
  }, [open, connection]);

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
        const res = await githubApi.getGitStatus(importedProjectId);
        if (res?.branch) {
          setCloneStatus('ready');
          clearInterval(id);
          showToast('success', t('git:toast.imported_ready', { defaultValue: 'Repository imported and ready.' }));
          onImported?.(importedProjectId);
          handleClose();
        }
      } catch {
        // Still cloning; keep polling.
      }
      if (attempts >= MAX_CLONE_POLL_ATTEMPTS) {
        clearInterval(id);
        setCloneError(t('git:error.clone_timeout_background', { defaultValue: 'Clone is taking longer than expected. It will continue in the background.' }));
      }
    }, CLONE_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [importedProjectId, cloneStatus, fetchWorkspaces, onImported, showToast]);

  const resetForm = () => {
    setRepos([]);
    setQuery('');
    setSelectedFullName('');
    setName('');
    setBranch('');
    setWorkBranchName(`xensemble/${Date.now()}`);
    setAutoCreateBranch(true);
    setImporting(false);
    setImportedProjectId(null);
    setCloneStatus(null);
    setCloneError(null);
  };

  const handleClose = () => {
    if (importing && !cloneStatus) return;
    resetForm();
    onClose();
  };

  const loadRepos = async () => {
    setReposLoading(true);
    try {
      const { repos: rows } = await githubApi.listGitHubRepos({ per_page: 100 });
      setRepos(Array.isArray(rows) ? rows : []);
    } catch (err) {
      showToast('error', err.message);
      setRepos([]);
    } finally {
      setReposLoading(false);
    }
  };

  const filteredRepos = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.full_name?.toLowerCase().includes(q));
  }, [repos, query]);

  const handleImport = async () => {
    if (!selectedFullName) return;
    setImporting(true);
    try {
      const result = await githubApi.importGitHubRepo({
        github_repo_full_name: selectedFullName,
        name: name.trim() || selectedRepo?.name,
        branch: branch.trim() || selectedRepo?.default_branch || 'main',
        auto_create_branch: autoCreateBranch,
        work_branch_name: workBranchName.trim() || `xensemble/${Date.now()}`,
      });
      setImportedProjectId(result.id);
      setCloneStatus(result.status || 'cloning');
      showToast('success', t('git:toast.import_started', { defaultValue: 'Import started. Cloning repository…' }));
    } catch (err) {
      showToast('error', err.message);
      setImporting(false);
    }
  };

  const canImport = Boolean(
    selectedFullName && name.trim() && branch.trim() && (!autoCreateBranch || workBranchName.trim()),
  );

  return (
    <ConsoleDialogShell
      onClose={handleClose}
      panelClassName={`${consoleDialogLgClass} max-h-[calc(100vh-2rem)]`}
    >
      <ConsoleStructuredDialogHeader
        title={t('git:dialog.import_github_title', { defaultValue: 'Import from GitHub' })}
        subtitle={connection ? t('git:dialog.import_select_repo', { defaultValue: 'Select a repository to import as a workspace.' }) : t('git:dialog.connect_to_import', { defaultValue: 'Connect your GitHub account to import repositories.' })}
      />
      <ConsoleStructuredDialogBody>
        {!connection ? (
          <div className="space-y-4">
            <p className={textSecondary}>
              {t('git:dialog.import_description', { defaultValue: 'Importing a GitHub repository creates a new workspace and clones the code so an agent can work on it.' })}
            </p>
            <GitHubConnectButton
              connection={connection}
              loading={connectionLoading}
              onConnect={connect}
              onDisconnect={disconnect}
            />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Github className="h-4 w-4 text-zinc-500" />
                <span className={`text-sm font-medium ${textPrimary}`}>
                  {connection.github_username || connection.githubUsername}
                </span>
              </div>
              <button
                type="button"
                onClick={disconnect}
                disabled={connectionLoading}
                className="text-xs text-zinc-500 hover:text-zinc-900"
              >
                {t('common:action.disconnect')}
              </button>
            </div>

            <div>
              <FormLabel htmlFor="repo-search">{t('git:dialog.search_repositories', { defaultValue: 'Search repositories' })}</FormLabel>
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
                  {t('git:state.loading_repositories', { defaultValue: 'Loading repositories…' })}
                </div>
              ) : filteredRepos.length === 0 ? (
                <div className="p-4 text-center text-sm text-zinc-500">
                  {repos.length === 0 ? t('git:empty.no_repositories', { defaultValue: 'No repositories found.' }) : t('common:select.no_matches')}
                </div>
              ) : (
                <ul className="divide-y divide-zinc-100">
                  {filteredRepos.map((repo) => (
                    <li key={repo.id || repo.full_name}>
                      <button
                        type="button"
                        onClick={() => setSelectedFullName(repo.full_name)}
                        className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                          selectedFullName === repo.full_name ? 'bg-zinc-100' : 'hover:bg-[#FAFBFC]'
                        }`}
                      >
                        <span className="min-w-0 truncate font-medium text-zinc-900">
                          {repo.full_name}
                        </span>
                        <span className="shrink-0 text-xs text-zinc-500">
                          {repo.private ? t('git:repo.private', { defaultValue: 'Private' }) : t('git:repo.public', { defaultValue: 'Public' })}
                          {repo.language ? ` · ${repo.language}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {selectedRepo && (
              <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50/70 p-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <FormLabel htmlFor="import-name">Project name</FormLabel>
                    <Input
                      id="import-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="my-project"
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <FormLabel htmlFor="import-branch">Base branch</FormLabel>
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
                    className="rounded border-zinc-300 text-black focus:ring-black"
                  />
                  Auto-create work branch
                </label>

                {autoCreateBranch && (
                  <div>
                    <FormLabel htmlFor="import-work-branch">Work branch name</FormLabel>
                    <Input
                      id="import-work-branch"
                      value={workBranchName}
                      onChange={(e) => setWorkBranchName(e.target.value)}
                      placeholder="xensemble/dev"
                      className="mt-1.5"
                    />
                  </div>
                )}
              </div>
            )}

            {importedProjectId && (
              <div className="flex items-center gap-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {cloneError || 'Cloning repository, please wait…'}
              </div>
            )}
          </div>
        )}
      </ConsoleStructuredDialogBody>
      <ConsoleStructuredDialogFooter>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleClose}
          disabled={importing && !cloneStatus}
        >
          Cancel
        </Button>
        {connection && (
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
      </ConsoleStructuredDialogFooter>
    </ConsoleDialogShell>
  );
}
