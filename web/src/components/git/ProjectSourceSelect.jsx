import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Search, Loader2, Check, GitBranch, Plus, Link2 } from 'lucide-react';
import { useGitProvider } from '../../hooks/useGitProvider';
import { useToast } from '../Toast';
import * as gitApi from '../../lib/gitApi';
import { getProviderLabel } from '../../lib/gitLabels';
import { computeSelectionState, toggleRepo, prefixOf } from '../../lib/repoSelection';
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
  // 多选勾选（多仓库导入）：勾选第一个仓库后按 full_name 前缀锁定组（含 provider 隔离跨源）
  const [selectedIds, setSelectedIds] = useState([]);
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

  // 多选状态计算：id/前缀计算用含 provider 的 key（隔离跨源同前缀组），行数据保持原始字段
  const selection = useMemo(() => {
    const states = computeSelectionState(
      allRepos.map((r) => ({ id: repoKey(r.provider, r.full_name), full_name: repoKey(r.provider, r.full_name) })),
      selectedIds,
    );
    const stateById = new Map(states.map((s) => [s.id, s]));
    return allRepos.map((r) => {
      const key = repoKey(r.provider, r.full_name);
      const s = stateById.get(key);
      return { ...r, selId: key, enabled: s?.enabled ?? true, checked: s?.checked ?? false };
    });
  }, [allRepos, selectedIds]);
  const selectedRepos = useMemo(
    () => selection.filter((r) => r.checked),
    [selection],
  );

  const handleToggle = (repo) => {
    // 跨前缀仓库不可勾选（enabled=false 时点击无效）
    if (!repo.enabled && !selectedIds.includes(repo.selId)) return;
    setSelectedIds(toggleRepo(selectedIds, repo));
  };

  const submitMultiImport = () => {
    if (selectedRepos.length === 0) return;
    // 单仓库保持原形态；多仓库携带 repos[]（上游 handleRepoImported 兼容两种形态）
    if (selectedRepos.length === 1) {
      onImported?.(selectedRepos[0]);
    } else {
      // 多仓库工作空间命名：用所有仓库名以 "+" 连接（如 repoA+repoB+repoC）
      onImported?.({
        name: selectedRepos.map((r) => r.name).filter(Boolean).join('+'),
        repos: selectedRepos.map((r) => ({ ...r })),
      });
    }
    setSelectedIds([]);
    setOpen(false);
  };

  const submitUrlImport = () => {
    const raw = urlInput.trim();
    if (!raw) {
      setUrlError(t('git:url_required', { defaultValue: 'Repository URL is required' }));
      return;
    }
    // 支持分号 ";" 分隔多个仓库 URL，一次导入多个仓库
    const urls = raw.split(';').map((s) => s.trim()).filter(Boolean);
    const parsed = urls.map((u) => ({ url: u, name: repoNameFromUrl(u) }));
    if (parsed.length === 0 || parsed.some((p) => !p.name)) {
      setUrlError(t('git:invalid_repo_url', { defaultValue: 'Invalid repository URL' }));
      return;
    }
    setUrlError(null);
    if (parsed.length > 1) {
      // 多仓库：与多选勾选一致的多仓库形态 { name, repos[] }（上游 handleRepoImported 兼容）；
      // 不填 default_branch，后端对每个 URL 探测真实默认分支
      const usedSubPaths = new Set();
      const repos = parsed.map((p, idx) => {
        let subPath = p.name;
        if (usedSubPaths.has(subPath)) subPath = `${subPath}-${idx + 1}`;
        usedSubPaths.add(subPath);
        return {
          provider: 'url',
          repo_url: p.url,
          name: p.name,
          full_name: p.name,
          sub_path: subPath,
          default_branch: undefined,
        };
      });
      onImported?.({
        name: parsed.map((p) => p.name).filter(Boolean).join('+'),
        repos,
      });
    } else {
      // 单仓库：保持原扁平形态（handleRepoImported 读取 repo.repo_url 构建导入 payload）
      const { url, name } = parsed[0];
      onImported?.({
        provider: 'url',
        repo_url: url,
        name,
        full_name: name,
        default_branch: 'main',
      });
    }
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

  const multiCount = importedProject?.repos?.length || 0;
  const triggerLabel = multiCount > 1
    ? t('git:import_multi_selected', { count: multiCount, defaultValue: '{{count}} repositories selected' })
    : (importedProject ? importedProject.name : t('git:select_repository'));

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
                  const state = selection.find((s) => s.selId === key)
                    || { enabled: true, checked: false };
                  const toggle = () => handleToggle({ ...r, id: key, selId: key, enabled: state.enabled });
                  // 锁定组提示走 title 悬停（不插入元素，避免下拉高度跳动）
                  const lockedHint = !state.enabled
                    ? t('git:import_multi_locked_row', {
                        defaultValue: 'Locked to group "{{prefix}}" — only repositories under the same group can be selected.',
                        prefix: prefixOf(selectedRepos[0]?.full_name || ''),
                      })
                    : undefined;
                  return (
                    <button
                      key={key}
                      type="button"
                      data-testid={`pss-repo-row-${r.full_name}`}
                      disabled={!state.enabled}
                      onClick={toggle}
                      title={lockedHint}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
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
                      <span className="min-w-0 flex-1 truncate text-zinc-700">{r.full_name}</span>
                      <span className="shrink-0 text-[10px] text-zinc-400">{getProviderLabel(r.provider)}</span>
                      {state.checked && <Check className="w-3.5 h-3.5 shrink-0 text-zinc-900" />}
                    </button>
                  );
                })}
                {/* 常驻确认按钮：未勾选时 disabled 占位，避免勾选后按钮突然出现导致高度跳动 */}
                <button
                  type="button"
                  data-testid="pss-import-submit"
                  onClick={submitMultiImport}
                  disabled={selectedIds.length === 0}
                  className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium ${
                    selectedIds.length > 0
                      ? 'bg-zinc-900 text-white hover:bg-zinc-800'
                      : 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
                  }`}
                >
                  {selectedIds.length > 1
                    ? t('git:import_multi_submit', { count: selectedIds.length, defaultValue: 'Import {{count}} repositories' })
                    : selectedIds.length === 1
                      ? t('git:import_repository', { defaultValue: 'Import Repository' })
                      : t('git:import_multi_pick_hint', { defaultValue: 'Select repositories to import' })}
                </button>
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
                    placeholder="https://github.com/owner/repo;https://gitlab.com/owner/repo"
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
