import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Search, Loader2, Check, GitBranch, Plus, Link2 } from 'lucide-react';
import { useGitProvider } from '../../hooks/useGitProvider';
import { useToast } from '../Toast';
import * as gitApi from '../../lib/gitApi';
import { getProviderLabel } from '../../lib/gitLabels';
import {
  consoleButtonFocusClass,
  consoleDropdownPanelClass,
  consoleMenuDropdownZClass,
} from '../../lib/consoleTokens';

const PROVIDERS = ['github', 'gitlab', 'gitea'];

function repoKey(provider, fullName) {
  return `${provider}:${fullName}`;
}

/** Parse a repo name from a URL (last path segment, strip .git). */
function repoNameFromUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withoutScheme = raw.replace(/^https?:\/\//i, '').replace(/^git@/, '').replace(/^ssh:\/\//i, '');
  const path = withoutScheme.split(/[/:]/).filter(Boolean).pop() || '';
  return path.replace(/\.git$/, '') || null;
}

export default function ProjectSourceSelect({
  importedProject,
  onImported,
  disabled,
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const gh = useGitProvider('github');
  const gl = useGitProvider('gitlab');
  const gt = useGitProvider('gitea');
  const providers = { github: gh, gitlab: gl, gitea: gt };

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [oauthConfigured, setOauthConfigured] = useState({});
  const [reposByProvider, setReposByProvider] = useState({});
  const [loadingRepos, setLoadingRepos] = useState({});
  const [urlMode, setUrlMode] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlError, setUrlError] = useState(null);
  const urlInputRef = useRef(null);
  const rootRef = useRef(null);

  // OAuth-configured status (per provider) - controls whether connect is allowed.
  useEffect(() => {
    gitApi.listProviders()
      .then((data) => {
        const map = {};
        for (const p of data.providers || []) {
          map[p.name] = p.oauth_configured ?? p.oauthConfigured ?? false;
        }
        setOauthConfigured(map);
      })
      .catch(() => setOauthConfigured({}));
  }, []);

  // Fetch repos for a connected provider.
  const fetchRepos = useCallback(async (provider) => {
    setLoadingRepos((prev) => ({ ...prev, [provider]: true }));
    try {
      const data = await gitApi.listRepos(provider, { per_page: '100' });
      const rows = data.repos || (Array.isArray(data) ? data : []);
      setReposByProvider((prev) => ({ ...prev, [provider]: rows }));
    } catch {
      setReposByProvider((prev) => ({ ...prev, [provider]: [] }));
    } finally {
      setLoadingRepos((prev) => ({ ...prev, [provider]: false }));
    }
  }, []);

  // When a provider becomes connected (or the popover opens), fetch its repos.
  useEffect(() => {
    if (!open) return;
    for (const p of PROVIDERS) {
      if (providers[p].connection && !reposByProvider[p] && !loadingRepos[p]) {
        fetchRepos(p);
      }
    }
  }, [open, gh.connection, gl.connection, gt.connection]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Flatten connected providers' repos into a single list with provider label.
  const allRepos = useMemo(() => {
    const list = [];
    for (const p of PROVIDERS) {
      if (providers[p].connection) {
        for (const r of reposByProvider[p] || []) {
          list.push({
            provider: p,
            full_name: r.full_name || r.fullName,
            name: r.name || (r.full_name || r.fullName || '').split('/').pop(),
            default_branch: r.default_branch || r.defaultBranch || 'main',
            private: r.private,
            language: r.language,
          });
        }
      }
    }
    return list;
  }, [reposByProvider, gh.connection, gl.connection, gt.connection]);

  const isLoading = PROVIDERS.some((p) =>
    providers[p].connection && loadingRepos[p] && !reposByProvider[p]
  );

  const filteredRepos = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allRepos;
    return allRepos.filter((r) => r.full_name?.toLowerCase().includes(q));
  }, [allRepos, query]);

  const handleSelectRepo = (repo) => {
    onImported?.(repo);
    setOpen(false);
  };

  const submitUrlImport = () => {
    const url = urlInput.trim();
    if (!url) {
      setUrlError(t('git:url_required', { defaultValue: 'Repository URL is required' }));
      return;
    }
    const name = repoNameFromUrl(url);
    if (!name) {
      setUrlError(t('git:invalid_repo_url', { defaultValue: 'Invalid repository URL' }));
      return;
    }
    setUrlError(null);
    // Record the URL selection with the same flat repo shape as
    // handleSelectRepo. handleRepoImported wraps it as { name, repo }, and
    // handleLaunchFromModal reads repo.repo_url to build the import payload.
    onImported?.({
      provider: 'url',
      repo_url: url,
      name,
      full_name: name,
      default_branch: 'main',
    });
    setOpen(false);
    setUrlMode(false);
    setUrlInput('');
  };

  const handleConnect = async (provider) => {
    if (oauthConfigured[provider] === false) {
      showToast('error', `${getProviderLabel(provider)} OAuth is not configured. Ask an admin.`);
      return;
    }
    await providers[provider].connect();
  };

  const triggerLabel = importedProject ? importedProject.name : t('git:select_repository');

  return (
    <div className="relative" ref={rootRef}>
      {open ? (
        <div className={`w-full flex items-center gap-2 h-9 px-3 rounded-md border border-zinc-300 bg-surface ${consoleButtonFocusClass}`}>
          <Search className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('git:search_repositories', { defaultValue: 'Search repositories…' })}
            autoFocus
            className="flex-1 bg-transparent text-sm text-zinc-700 placeholder:text-zinc-400 outline-none"
          />
          <button
            type="button"
            onClick={() => { setOpen(false); setQuery(''); }}
            aria-label="Close"
            className="text-zinc-400 hover:text-zinc-600"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className={`w-full flex items-center justify-between gap-2 h-9 px-3 text-sm rounded-md border border-zinc-300 bg-surface text-left transition-colors hover:bg-zinc-50 disabled:opacity-50 ${consoleButtonFocusClass}`}
        >
          <span className="flex items-center gap-2 min-w-0 truncate">
            <GitBranch className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
            <span className={`truncate ${importedProject ? 'text-zinc-900 font-medium' : 'text-zinc-400'}`}>{triggerLabel}</span>
          </span>
          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
        </button>
      )}

      {open && (
        <div className={`absolute left-0 right-0 top-full z-40 mt-1 ${consoleDropdownPanelClass} ${consoleMenuDropdownZClass} max-h-80 flex flex-col overflow-hidden shadow-lg`}>
          {/* Unified scroll: repos + divider + connect links */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {/* Upper tier: repos from connected providers */}
            {isLoading && allRepos.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-zinc-400">
                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
                {t('git:loading_repositories', { defaultValue: 'Loading repositories…' })}
              </div>
            ) : allRepos.length === 0 ? (
              filteredRepos.length === 0 ? null : (
                <p className="px-3 py-3 text-xs text-zinc-400">{t('git:no_matches', { defaultValue: 'No matches.' })}</p>
              )
            ) : filteredRepos.length === 0 ? (
              <p className="px-3 py-3 text-xs text-zinc-400">{t('git:no_matches', { defaultValue: 'No matches.' })}</p>
            ) : (
              <>
                {filteredRepos.map((r) => {
                  const key = repoKey(r.provider, r.full_name);
                  const isSelected = importedProject && importedProject.name === r.name;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleSelectRepo(r)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-50"
                    >
                      <GitBranch className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
                      <span className="min-w-0 flex-1 truncate text-zinc-700">{r.full_name}</span>
                      <span className="shrink-0 text-[10px] text-zinc-400">{getProviderLabel(r.provider)}</span>
                      {isSelected && <Check className="w-3.5 h-3.5 shrink-0 text-zinc-900" />}
                    </button>
                  );
                })}
                {isLoading && (
                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-400">
                    <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
                    {t('git:loading_more', { defaultValue: 'Loading more…' })}
                  </div>
                )}
              </>
            )}

            {/* Divider */}
            <div className="h-px bg-zinc-200 my-1" />

            {/* Lower tier: connect links */}
            {PROVIDERS.map((p) => {
              const conn = providers[p].connection;
              const connecting = providers[p].loading;
              const configured = oauthConfigured[p] !== false;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => handleConnect(p)}
                  disabled={connecting || !configured}
                  title={configured ? `Connect ${getProviderLabel(p)}` : `${getProviderLabel(p)} OAuth not configured`}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"
                >
                  {connecting ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-zinc-400" /> : <Plus className="w-3.5 h-3.5 shrink-0 text-zinc-400" />}
                  <span className="flex-1 truncate">
                    {getProviderLabel(p)}
                  </span>
                  {conn && <span className="shrink-0 text-[10px] text-emerald-600">Connected</span>}
                </button>
              );
            })}

            {/* Import by URL (no account connection needed) */}
            <div className="h-px bg-zinc-200 my-1" />
            {urlMode ? (
              <div className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <input
                    ref={urlInputRef}
                    type="text"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); submitUrlImport(); }
                      if (e.key === 'Escape') { setUrlMode(false); setUrlInput(''); setUrlError(null); }
                    }}
                    placeholder="https://github.com/owner/repo"
                    autoFocus
                    className="min-w-0 flex-1 text-sm px-2.5 py-1.5 rounded-md border border-zinc-300 outline-none focus:border-zinc-500 text-zinc-700 placeholder:text-zinc-400"
                  />
                  <button
                    type="button"
                    onClick={submitUrlImport}
                    disabled={!urlInput.trim()}
                    className="shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40"
                  >
                    {t('git:import_url_confirm', { defaultValue: 'Confirm' })}
                  </button>
                </div>
                {urlError && (
                  <p className="text-[11px] text-red-600 mt-1.5">{urlError}</p>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setUrlMode(true); setUrlError(null); requestAnimationFrame(() => urlInputRef.current?.focus()); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-50"
              >
                <Link2 className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
                <span className="flex-1 truncate">{t('git:import_by_url', { defaultValue: 'Import by URL' })}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
