import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { GitBranch, Loader2, Check, Plus } from 'lucide-react';
import * as githubApi from '../../lib/githubApi';
import {
  consoleButtonFocusClass,
  consoleDropdownPanelClass,
  consoleMenuDropdownZClass,
  consoleInputClass,
  borderHairline,
  bgSecondary,
  textPrimary,
  hoverBgTertiary,
  transitionBase,
} from '../../lib/consoleTokens';

export const GIT_REPO_PROVIDERS = new Set(['github', 'gitlab', 'gitea', 'local_git']);

export default function BranchSwitcher({ projectId, project, git }) {
  const { t } = useTranslation();
  const branch = git?.branch;
  const operation = git?.operation;
  const switchBranch = git?.switchBranch;
  const createBranch = git?.createBranch;

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');
  const btnRef = useRef(null);
  const newInputRef = useRef(null);

  const openMenu = async () => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuRect({ top: rect.bottom + 4, left: rect.left, width: 220 });
    }
    setMenuOpen(true);
    setLoading(true);
    setError(null);
    try {
      const data = await githubApi.listBranches(projectId);
      setBranches(data.branches || []);
    } catch (err) {
      setBranches([]);
      setError(err.message || t('git:error.load_branches_failed', { defaultValue: 'Failed to load branches' }));
    } finally {
      setLoading(false);
    }
  };

  const handleSwitch = async (name) => {
    setMenuOpen(false);
    if (name === (branch || project?.currentBranch)) return;
    await switchBranch?.(name);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setNewName('');
    setMenuOpen(false);
    await createBranch?.(name);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      const menu = document.getElementById('branch-switcher-menu');
      if (menu?.contains(e.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  useEffect(() => {
    if (menuOpen) {
      setNewName('');
      const focusTimer = setTimeout(() => newInputRef.current?.focus(), 50);
      return () => clearTimeout(focusTimer);
    }
  }, [menuOpen]);

  const current = branch || project?.currentBranch || 'unknown';

  return (
    <>
      <div className="flex items-center gap-1.5 min-w-0">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <button
          ref={btnRef}
          type="button"
          onClick={openMenu}
          disabled={operation === 'switch'}
          title={t('git:switch_branch', { defaultValue: 'Switch branch' })}
          className={`flex items-center gap-1 max-w-[14rem] truncate rounded-md px-2 py-1 text-[13px] font-medium ${transitionBase} ${consoleButtonFocusClass} ${
            menuOpen ? `${bgSecondary} ${textPrimary}` : `text-zinc-700 ${hoverBgTertiary}`
          } disabled:opacity-50`}
        >
          {operation === 'switch' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          <span className="truncate">{current}</span>
        </button>
      </div>

      {menuOpen && menuRect && createPortal(
        <div
          id="branch-switcher-menu"
          className={`fixed ${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} py-1 max-h-72 overflow-auto`}
          style={{ top: menuRect.top, left: menuRect.left, width: menuRect.width }}
        >
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
            </div>
          ) : branches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-400">
              {error || t('git:no_branches', { defaultValue: 'No branches' })}
              {error && (
                <button
                  type="button"
                  onClick={openMenu}
                  className={`ml-2 text-black hover:text-zinc-800 ${consoleButtonFocusClass}`}
                >
                  Retry
                </button>
              )}
            </div>
          ) : (
            branches.map((b) => {
              const isCurrent = b.name === current;
              return (
                <button
                  key={b.name}
                  type="button"
                  onClick={() => handleSwitch(b.name)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                    isCurrent ? 'bg-zinc-100 text-zinc-900 font-medium' : 'text-zinc-500 hover:bg-zinc-100'
                  } ${consoleButtonFocusClass}`}
                >
                  <span className="w-3.5 shrink-0 flex items-center justify-center">
                    {isCurrent && <Check className="h-3 w-3" strokeWidth={2.5} />}
                  </span>
                  <span className="truncate">{b.name}</span>
                </button>
              );
            })
          )}
          <div className={`border-t ${borderHairline} mt-1 pt-1 px-2 pb-1`}>
            <div className="flex items-center gap-1">
              <input
                ref={newInputRef}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                placeholder={t('git:new_branch_placeholder', { defaultValue: 'New branch…' })}
                className={`flex-1 min-w-0 ${consoleInputClass} text-xs font-mono`}
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={!newName.trim() || operation === 'switch'}
                title={t('git:create_branch', { defaultValue: 'Create branch' })}
                className={`shrink-0 p-1 rounded text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-default ${consoleButtonFocusClass}`}
              >
                {operation === 'switch' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
