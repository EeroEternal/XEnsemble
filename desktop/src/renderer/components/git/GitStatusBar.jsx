import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, GitBranch, GitPullRequest, Loader2, Pencil, Upload, Download, RefreshCw, Check, Plus } from 'lucide-react';
import { cn } from '../../lib/utils';
import * as githubApi from '../../lib/githubApi.js';
import CreatePRDialog from '../github/CreatePRDialog';
import {
  ConsoleInlineDialog,
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
} from '../../lib/consoleTheme';

const GIT_PROVIDERS = new Set(['github', 'gitlab', 'gitea', 'local_git']);

export default function GitStatusBar({ projectId, project, git, disabled = false }) {
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
  const [createPROpen, setCreatePROpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchMenuRect, setBranchMenuRect] = useState(null);
  const [branches, setBranches] = useState([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const branchBtnRef = useRef(null);
  const newBranchInputRef = useRef(null);

  const openBranchMenu = async () => {
    if (disabled) return;
    if (branchBtnRef.current) {
      const rect = branchBtnRef.current.getBoundingClientRect();
      setBranchMenuRect({ bottom: window.innerHeight - rect.top + 4, left: rect.left, width: 200 });
    }
    setBranchMenuOpen(true);
    setBranchesLoading(true);
    try {
      const data = await githubApi.listBranches(projectId);
      setBranches(data.branches || []);
    } catch {
      setBranches([]);
    } finally {
      setBranchesLoading(false);
    }
  };

  const handleSwitchBranch = async (name) => {
    if (disabled) return;
    setBranchMenuOpen(false);
    if (name === (status?.branch || project?.currentBranch)) return;
    await switchBranch?.(name);
  };

  const handleCreateBranch = async () => {
    if (disabled) return;
    const name = newBranchName.trim();
    if (!name) return;
    setNewBranchName('');
    setBranchMenuOpen(false);
    await createBranch?.(name);
  };

  useEffect(() => {
    if (!branchMenuOpen) return;
    const onClick = (e) => {
      if (branchBtnRef.current && !branchBtnRef.current.contains(e.target)) {
        setBranchMenuOpen(false);
      }
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
      await commit(commitMessage);
      setCommitMessage('');
      setShowCommitDialog(false);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <>
      <div className={cn('flex h-10 shrink-0 items-center justify-between border-t border-[#E8EAED] bg-[#FAFBFC] px-4', borderHairline)}>
        <div className="flex min-w-0 items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5 text-[#202124]">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#9AA0A6]" />
            <button
              ref={branchBtnRef}
              type="button"
              onClick={openBranchMenu}
              disabled={disabled || operation === 'switch'}
              title={disabled ? 'Branch switching is disabled in this session' : 'Switch branch'}
              className={`flex items-center gap-1 max-w-[12rem] truncate font-mono font-medium hover:text-[#5F6368] transition-colors disabled:opacity-50 disabled:cursor-default ${consoleButtonFocusClass}`}
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
            <div className="flex items-center gap-2 text-[#5F6368]">
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
          <div className="flex items-center gap-2 text-[#5F6368]">
            {status?.dirty ? (
              <>
                {status?.unstaged && <span>modified</span>}
                {status?.staged && <span>staged</span>}
                {status?.untracked && <span>untracked</span>}
              </>
            ) : (
              <span className="text-[#4A7C59]">clean</span>
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
            />
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

      <CreatePRDialog
        open={createPROpen}
        projectId={projectId}
        sourceBranch={status?.branch || project?.currentBranch}
        defaultTargetBranch={project?.repoDefaultBranch || 'main'}
        onClose={() => setCreatePROpen(false)}
      />

      {branchMenuOpen && branchMenuRect && createPortal(
        <div
          className={`fixed ${consoleMenuDropdownZClass} ${consoleDropdownPanelClass} py-1 max-h-64 overflow-auto`}
          style={{ bottom: branchMenuRect.bottom, left: branchMenuRect.left, width: branchMenuRect.width }}
        >
          {branchesLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-[#9AA0A6]" />
            </div>
          ) : branches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[#9AA0A6]">No branches</div>
          ) : (
            branches.map((b) => {
              const isCurrent = b.name === (status?.branch || project?.currentBranch);
              return (
                <button
                  key={b.name}
                  type="button"
                  onClick={() => handleSwitchBranch(b.name)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                    isCurrent ? 'bg-[#F4F5F6] text-[#202124] font-medium' : 'text-[#5F6368] hover:bg-[#F4F5F6]'
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
                className={`shrink-0 p-1 rounded text-[#5F6368] hover:text-[#202124] hover:bg-[#E8EAED] disabled:opacity-40 disabled:cursor-default ${consoleButtonFocusClass}`}
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
