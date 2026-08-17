import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, GitBranch, GitPullRequest, Loader2, Pencil, Upload, Download, RefreshCw, Check, Plus, User } from 'lucide-react';
import { cn } from '../../lib/utils';
import * as githubApi from '../../lib/githubApi';
import CreatePRDialog from './CreatePRDialog';
import {
  ConsoleInlineDialog,
  ConsoleDialogShell,
} from '../ConsoleDialog';
import Input from '../Input';
import Button from '../Button';
import {
  consoleIconButtonClass,
  consoleButtonFocusClass,
  consoleDropdownPanelClass,
  consoleMenuDropdownZClass,
  consoleInputClass,
  consoleStructuredDialogHeaderClass,
  consoleStructuredDialogFooterClass,
  borderHairline,
  bgCanvas,
  textPrimary,
  textPlaceholder,
} from '../../lib/consoleTokens';
import { apiFetch } from '../../lib/api';
import { buttonClass } from '../../lib/buttonStyles';

const GIT_PROVIDERS = new Set(['github', 'gitlab', 'gitea', 'local_git']);

export default function GitStatusBar({ projectId, project, git }) {
  const isGitProject = Boolean(projectId && project?.repoProvider && GIT_PROVIDERS.has(project.repoProvider));
  // Use the shared git state passed from the parent (merged useGitStatus)
  // instead of mounting a second useGitStatus instance (which would double
  // the 15s polling timer and DB/git load).
  const status = git ? {
    branch: git.branch,
    ahead: git.ahead,
    behind: git.behind,
    dirty: git.dirty,
    staged: git.staged,
    unstaged: git.unstaged,
    untracked: git.untracked,
  } : null;
  const operation = git?.operation;
  const commit = git?.commit;
  const push = git?.push;
  const pull = git?.pull;
  const fetchRemote = git?.fetchRemote;
  const switchBranch = git?.switchBranch;
  const createBranch = git?.createBranch;
  const stage = git?.stage;
  const stagedFiles = git?.stagedFiles || [];
  const unstagedFiles = git?.unstagedFiles || [];
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [showAuthorDialog, setShowAuthorDialog] = useState(false);
  const [authorName, setAuthorName] = useState(() => localStorage.getItem('xe_git_author_name') || '');
  const [authorEmail, setAuthorEmail] = useState(() => localStorage.getItem('xe_git_author_email') || '');
  const [createPROpen, setCreatePROpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/v1/user/preferences')
      .then((res) => res.ok ? res.json() : null)
      .then((prefs) => {
        if (cancelled || !prefs) return;
        if (prefs.git_author_name) { setAuthorName(prefs.git_author_name); localStorage.setItem('xe_git_author_name', prefs.git_author_name); }
        if (prefs.git_author_email) { setAuthorEmail(prefs.git_author_email); localStorage.setItem('xe_git_author_email', prefs.git_author_email); }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchMenuRect, setBranchMenuRect] = useState(null);
  const [branches, setBranches] = useState([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState(null);
  const [newBranchName, setNewBranchName] = useState('');
  const branchBtnRef = useRef(null);
  const newBranchInputRef = useRef(null);

  const openBranchMenu = async () => {
    if (branchBtnRef.current) {
      const rect = branchBtnRef.current.getBoundingClientRect();
      setBranchMenuRect({ bottom: window.innerHeight - rect.top + 4, left: rect.left, width: 200 });
    }
    setBranchMenuOpen(true);
    setBranchesLoading(true);
    setBranchesError(null);
    try {
      const data = await githubApi.listBranches(projectId);
      setBranches(data.branches || []);
    } catch (err) {
      setBranches([]);
      setBranchesError(err.message || 'Failed to load branches');
    } finally {
      setBranchesLoading(false);
    }
  };

  const handleSwitchBranch = async (name) => {
    setBranchMenuOpen(false);
    if (name === (status?.branch || project?.currentBranch)) return;
    await switchBranch?.(name);
  };

  const handleCreateBranch = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setNewBranchName('');
    setBranchMenuOpen(false);
    await createBranch?.(name);
  };

  useEffect(() => {
    if (!branchMenuOpen) return;
    const onClick = (e) => {
      if (branchBtnRef.current && branchBtnRef.current.contains(e.target)) return;
      const menu = document.getElementById('git-branch-menu');
      if (menu && menu.contains(e.target)) return;
      setBranchMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [branchMenuOpen]);

  useEffect(() => {
    if (branchMenuOpen) {
      setNewBranchName('');
      const t = setTimeout(() => newBranchInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [branchMenuOpen]);

  if (!isGitProject) return null;

  const handleCommit = async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    try {
      if (stagedFiles.length === 0 && unstagedFiles.length > 0) {
        const paths = unstagedFiles.map((f) => f.path).filter(Boolean);
        if (paths.length > 0) {
          await stage(paths);
        }
      }
      const author = authorName && authorEmail ? { name: authorName, email: authorEmail } : undefined;
      await commit(commitMessage, author);
      setCommitMessage('');
      setShowCommitDialog(false);
    } catch (err) {
      if (err.code === 'AUTHOR_REQUIRED') {
        setShowAuthorDialog(true);
        return;
      }
    } finally {
      setCommitting(false);
    }
  };

  const handleAuthorConfirm = useCallback(async () => {
    if (!authorName.trim() || !authorEmail.trim()) return;
    localStorage.setItem('xe_git_author_name', authorName.trim());
    localStorage.setItem('xe_git_author_email', authorEmail.trim());
    apiFetch('/api/v1/user/preferences', {
      method: 'PUT',
      body: JSON.stringify({ git_author_name: authorName.trim(), git_author_email: authorEmail.trim() }),
    }).catch(() => {});
    setShowAuthorDialog(false);
    setCommitting(true);
    try {
      const author = { name: authorName.trim(), email: authorEmail.trim() };
      await commit(commitMessage, author);
      setCommitMessage('');
      setShowCommitDialog(false);
    } catch (_) {
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, commit, authorName, authorEmail]);

  return (
    <>
      <div className={cn('flex h-10 shrink-0 items-center justify-between border-t border-zinc-200 bg-zinc-50 px-4', borderHairline)}>
        <div className="flex min-w-0 items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5 text-zinc-900">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <button
              ref={branchBtnRef}
              type="button"
              onClick={openBranchMenu}
              disabled={operation === 'switch'}
              title="Switch branch"
              className={`flex items-center gap-1 max-w-[12rem] truncate font-mono font-medium hover:text-zinc-500 transition-colors ${consoleButtonFocusClass}`}
            >
              {operation === 'switch' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : null}
              <span className="truncate">
                {status?.branch || project?.currentBranch || 'unknown'}
              </span>
            </button>
          </div>
          {(status?.ahead > 0 || status?.behind > 0) && (
            <div className="flex items-center gap-2 text-zinc-500">
              {status?.ahead > 0 && (
                <span className="flex items-center gap-0.5" title={`${status.ahead} commit(s) ahead`}>
                  <ArrowUp className="h-3 w-3" />
                  {status.ahead}
                </span>
              )}
              {status?.behind > 0 && (
                <span className="flex items-center gap-0.5" title={`${status.behind} commit(s) behind`}>
                  <ArrowDown className="h-3 w-3" />
                  {status.behind}
                </span>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 text-zinc-500">
            {status?.dirty ? (
              <>
                {status?.unstaged && <span>modified</span>}
                {status?.staged && <span>staged</span>}
                {status?.untracked && <span>untracked</span>}
              </>
            ) : (
              <span className="text-emerald-600">clean</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowCommitDialog(true)}
            disabled={!status?.dirty || operation === 'commit'}
            title="Commit all changes"
            aria-label="Commit all changes"
            className={consoleIconButtonClass}
          >
            {operation === 'commit' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Pencil className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={push}
            disabled={!status?.ahead || operation === 'push'}
            title="Push branch"
            aria-label="Push branch"
            className={consoleIconButtonClass}
          >
            {operation === 'push' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={fetchRemote}
            disabled={operation === 'fetch'}
            title="Fetch from remote"
            aria-label="Fetch from remote"
            className={consoleIconButtonClass}
          >
            {operation === 'fetch' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={pull}
            disabled={operation === 'pull'}
            title="Pull latest changes"
            aria-label="Pull latest changes"
            className={consoleIconButtonClass}
          >
            {operation === 'pull' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
          </button>
          {project?.repoProvider !== 'local_git' && (
            <button
              type="button"
              onClick={() => setCreatePROpen(true)}
              disabled={!status?.branch}
              title={project?.repoProvider === 'gitlab' ? 'Create merge request' : 'Create pull request'}
              aria-label={project?.repoProvider === 'gitlab' ? 'Create merge request' : 'Create pull request'}
              className={consoleIconButtonClass}
            >
              <GitPullRequest className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {showCommitDialog && (
        <ConsoleInlineDialog
          onClose={() => setShowCommitDialog(false)}
          panelClassName={`${bgCanvas} border ${borderHairline} rounded-lg w-full max-w-sm shadow-sm`}
        >
          <div className={consoleStructuredDialogHeaderClass}>
            <h3 className={`font-semibold text-sm ${textPrimary}`}>Commit all changes</h3>
          </div>
          <div className="p-5 space-y-3">
            <label className={`block text-xs font-semibold uppercase tracking-wider ${textPlaceholder}`}>
              Commit message
            </label>
            <Input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Describe your changes"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleCommit();
                }
              }}
            />
            <div className="flex items-center gap-1.5">
              <User className="h-3 w-3 text-zinc-400 shrink-0" />
              <span className="text-xs text-zinc-500 truncate">
                {authorName && authorEmail
                  ? `${authorName} <${authorEmail}>`
                  : 'No author identity set'}
              </span>
              <button
                type="button"
                onClick={() => setShowAuthorDialog(true)}
                className={`text-xs text-black hover:text-zinc-800 shrink-0 ${consoleButtonFocusClass}`}
              >
                {authorName ? 'Edit' : 'Set'}
              </button>
            </div>
          </div>
          <div className={consoleStructuredDialogFooterClass}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowCommitDialog(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!commitMessage.trim() || committing}
              onClick={handleCommit}
            >
              {committing ? 'Committing…' : 'Commit'}
            </Button>
          </div>
        </ConsoleInlineDialog>
      )}

      {showAuthorDialog && (
        <ConsoleDialogShell onClose={() => setShowAuthorDialog(false)} panelClassName="w-80">
          <div className="px-5 pt-5 pb-2">
            <h3 className="text-sm font-semibold text-zinc-900">Set Git author info</h3>
          </div>
          <div className="px-5 pb-5 flex flex-col gap-3">
            <input
              type="text"
              placeholder="Name"
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              autoFocus
              className={`w-full ${consoleInputClass} text-xs`}
            />
            <input
              type="email"
              placeholder="Email"
              value={authorEmail}
              onChange={(e) => setAuthorEmail(e.target.value)}
              className={`w-full ${consoleInputClass} text-xs`}
            />
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-200">
            <button
              onClick={() => setShowAuthorDialog(false)}
              className={buttonClass('secondary', 'sm')}
            >
              Cancel
            </button>
            <button
              onClick={handleAuthorConfirm}
              disabled={!authorName.trim() || !authorEmail.trim()}
              className={buttonClass('primary', 'sm')}
            >
              Confirm
            </button>
          </div>
        </ConsoleDialogShell>
      )}

      <CreatePRDialog
        open={createPROpen}
        projectId={projectId}
        sourceBranch={status?.branch || project?.currentBranch}
        defaultTargetBranch={project?.repoDefaultBranch || 'main'}
        onClose={() => setCreatePROpen(false)}
        onCreated={() => { setCreatePROpen(false); fetchRemote?.(); }}
      />

      {branchMenuOpen && branchMenuRect && createPortal(
        <div
          id="git-branch-menu"
          className={`fixed ${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} py-1 max-h-64 overflow-auto`}
          style={{ bottom: branchMenuRect.bottom, left: branchMenuRect.left, width: branchMenuRect.width }}
        >
          {branchesLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
            </div>
          ) : branches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-400">
              {branchesError || 'No branches'}
              {branchesError && (
                <button
                  type="button"
                  onClick={openBranchMenu}
                  className={`ml-2 text-black hover:text-zinc-800 ${consoleButtonFocusClass}`}
                >
                  Retry
                </button>
              )}
            </div>
          ) : (
            branches.map((b) => {
              const isCurrent = b.name === (status?.branch || project?.currentBranch);
              return (
                <button
                  key={b.name}
                  type="button"
                  onClick={() => handleSwitchBranch(b.name)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                    isCurrent ? 'bg-zinc-100 text-zinc-900 font-medium' : 'text-zinc-500 hover:bg-zinc-100'
                  } ${consoleButtonFocusClass}`}
                >
                  <span className="w-3.5 shrink-0 flex items-center justify-center">
                    {isCurrent && <Check className="h-3 w-3" strokeWidth={2.5} />}
                  </span>
                  <span className="truncate font-mono">{b.name}</span>
                </button>
              );
            })
          )}
          <div className={`border-t ${borderHairline} mt-1 pt-1 px-2 pb-1`}>
            <div className="flex items-center gap-1">
              <input
                ref={newBranchInputRef}
                type="text"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateBranch(); }}
                placeholder="New branch…"
                className={`flex-1 min-w-0 ${consoleInputClass} text-xs font-mono`}
              />
              <button
                type="button"
                onClick={handleCreateBranch}
                disabled={!newBranchName.trim() || operation === 'switch'}
                title="Create branch"
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
