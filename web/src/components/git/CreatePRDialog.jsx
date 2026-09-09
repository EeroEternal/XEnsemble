import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2 } from 'lucide-react';
import {
  ConsoleDialogShell,
  ConsoleStructuredDialogHeader,
  ConsoleStructuredDialogBody,
  ConsoleStructuredDialogFooter,
} from '../ConsoleDialog';
import Input, { FormLabel, Textarea } from '../Input';
import Button from '../Button';
import SelectMenu from '../SelectMenu';
import { useToast } from '../Toast';
import * as githubApi from '../../lib/githubApi';
import { useProjectRepos } from '../../hooks/useProjectRepos';
import { consoleDialogMdClass } from '../../lib/consoleTokens';

export default function CreatePRDialog({
  open,
  projectId,
  sourceBranch,
  defaultTargetBranch,
  onClose,
  onCreated,
}) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const { repos } = useProjectRepos(projectId);
  // 多仓库：提 PR 前先选仓库（默认 primary），各 API 都带 repo_id
  const multiRepos = repos.length > 1 ? repos : [];
  const [repoId, setRepoId] = useState(null);
  const activeRepo = multiRepos.find((r) => r.id === repoId) || multiRepos.find((r) => r.isPrimary) || null;
  // 目标仓库的当前分支（source branch 只对该仓库有效）
  const [repoSourceBranch, setRepoSourceBranch] = useState('');
  const [branches, setBranches] = useState([]);
  const [branchesError, setBranchesError] = useState(null);
  const [targetBranch, setTargetBranch] = useState(defaultTargetBranch || 'main');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [diff, setDiff] = useState('');
  const [diffBinary, setDiffBinary] = useState(false);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const aiLoadedRef = useRef(false);

  // 生效的 source branch：多仓库用所选仓库当前分支；单仓库用父级传入的分支
  const effectiveSourceBranch = (activeRepo ? repoSourceBranch : sourceBranch) || sourceBranch || '';

  useEffect(() => {
    if (!open || !projectId) return;
    githubApi
      .listBranches(projectId, activeRepo?.id)
      .then(({ branches: rows }) => {
        setBranches(Array.isArray(rows) ? rows : []);
        setBranchesError(null);
        const cur = (Array.isArray(rows) ? rows : []).find((b) => b.current)?.name || '';
        setRepoSourceBranch(cur);
      })
      .catch((err) => {
        setBranches([]);
        setRepoSourceBranch('');
        setBranchesError(err.message || t('git:error.load_branches_failed', { defaultValue: 'Failed to load branches' }));
      });
  }, [open, projectId, activeRepo?.id, t]);

  useEffect(() => {
    if (!open) {
      setTitle('');
      setBody('');
      setDiff('');
      setDiffBinary(false);
      setDiffTruncated(false);
      setShowDiff(false);
      setTargetBranch(defaultTargetBranch || 'main');
      aiLoadedRef.current = false;
      setRepoId(null);
      setRepoSourceBranch('');
    }
  }, [open, defaultTargetBranch]);

  useEffect(() => {
    if (!open || !projectId || !effectiveSourceBranch) return;
    setDiffLoading(true);
    githubApi
      .getGitDiff(projectId, { base: targetBranch, head: effectiveSourceBranch, repoId: activeRepo?.id })
      .then((data) => {
        setDiff(data?.diff || '');
        setDiffBinary(Boolean(data?.binary));
        setDiffTruncated(Boolean(data?.truncated));
      })
      .catch(() => {
        setDiff('');
        setDiffBinary(false);
        setDiffTruncated(false);
      })
      .finally(() => setDiffLoading(false));
  }, [open, projectId, effectiveSourceBranch, targetBranch, activeRepo?.id]);

  useEffect(() => {
    if (!open || !projectId || !effectiveSourceBranch) return;
    if (aiLoadedRef.current) return;
    if (diffLoading) return;
    if (!diff || diffBinary) return;
    setAiLoading(true);
    githubApi
      .generatePRDescription(projectId, { sourceBranch: effectiveSourceBranch, targetBranch, repoId: activeRepo?.id })
      .then((data) => {
        if (data?.title) setTitle(data.title);
        if (data?.body) setBody(data.body);
      })
      .catch(() => {})
      .finally(() => setAiLoading(false));
    aiLoadedRef.current = true;
  }, [open, projectId, effectiveSourceBranch, diffLoading, diff, diffBinary, targetBranch, activeRepo?.id]);

  const branchOptions = useMemo(
    () => branches.map((b) => ({ value: b.name, label: b.name })),
    [branches],
  );

  const handleCreate = async () => {
    if (!projectId || !effectiveSourceBranch || !title.trim() || effectiveSourceBranch === targetBranch) return;
    setCreating(true);
    try {
      const pr = await githubApi.createPullRequest(projectId, {
        title: title.trim(),
        body: body.trim(),
        source_branch: effectiveSourceBranch,
        target_branch: targetBranch,
        repo_id: activeRepo?.id,
      });
      showToast('success', t('git:toast.pr_created'));
      if (pr?.remoteMrUrl || pr?.remote_mr_url || pr?.github_pr_url || pr?.githubPrUrl) {
        githubApi.openExternal(pr.remoteMrUrl || pr.remote_mr_url || pr.github_pr_url || pr.githubPrUrl);
      }
      onCreated?.();
      onClose();
    } catch (err) {
      if (err.code === 'REAUTH_REQUIRED') {
        showToast('warning', err.message);
        onClose();
        window.dispatchEvent(new CustomEvent('xe:open-settings'));
      } else if (err.code === 'rebase_conflict') {
        showToast('error', t('git:toast.rebase_conflict', { defaultValue: 'Rebase failed: conflicts with target branch. Please resolve locally and push again.' }));
      } else {
        showToast('error', err.message);
      }
    } finally {
      setCreating(false);
    }
  };

  if (!open) return null;

  return (
    <ConsoleDialogShell onClose={onClose} panelClassName={`${consoleDialogMdClass} max-h-[calc(100vh-2rem)]`}>
      <ConsoleStructuredDialogHeader
        title={t('git:create_pull_request')}
        subtitle={t('git:pr.from_source', { branch: effectiveSourceBranch || t('git:pr.current_branch', { defaultValue: 'current branch' }) })}
      />
      <ConsoleStructuredDialogBody>
        {multiRepos.length > 0 && (
          <div className="mb-3">
            <FormLabel htmlFor="pr-repo">{t('git:repository', { defaultValue: 'Repository' })}</FormLabel>
            <SelectMenu
              id="pr-repo"
              value={activeRepo?.id}
              onChange={setRepoId}
              options={multiRepos.map((r) => ({ value: r.id, label: r.subPath }))}
              placeholder={t('git:select_repository', { defaultValue: 'Select repository' })}
              className="mt-1.5"
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FormLabel htmlFor="pr-source">{t('git:source_branch')}</FormLabel>
            <Input
              id="pr-source"
              value={effectiveSourceBranch || ''}
              readOnly
              className="mt-1.5 bg-zinc-100"
            />
          </div>
          <div>
            <FormLabel htmlFor="pr-target">{t('git:target_branch')}</FormLabel>
            {branchesError ? (
              <p className="mt-1.5 text-xs text-red-600">{branchesError}</p>
            ) : (
              <SelectMenu
                id="pr-target"
                value={targetBranch}
                onChange={setTargetBranch}
                options={branchOptions}
                placeholder={t('git:select_target_branch', { defaultValue: 'Select target branch' })}
                className="mt-1.5"
              />
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <FormLabel htmlFor="pr-title">{t('git:title', { defaultValue: 'Title' })}</FormLabel>
          </div>
          <Input
            id="pr-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={aiLoading
              ? t('git:pr.ai_filling', { defaultValue: 'AI is generating…' })
              : t('git:pr.title_placeholder', { defaultValue: 'feat: describe the change' })}
            className="mt-1.5"
            autoFocus
          />
        </div>

        <div>
          <FormLabel htmlFor="pr-body">{t('git:description')}</FormLabel>
          <Textarea
            id="pr-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={aiLoading
              ? t('git:pr.ai_filling', { defaultValue: 'AI is generating…' })
              : t('git:pr.body_placeholder', { defaultValue: 'What changed and why' })}
            className="mt-1.5 min-h-[6rem]"
          />
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowDiff((v) => !v)}
            className="text-xs font-medium text-zinc-500 hover:text-zinc-900"
          >
            {showDiff ? t('git:pr.hide_diff_preview', { defaultValue: 'Hide diff preview' }) : t('git:pr.show_diff_preview', { defaultValue: 'Show diff preview' })}
          </button>
          {showDiff && (
            <div className="mt-2 max-h-48 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3">
              {diffLoading ? (
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('git:pr.loading_diff', { defaultValue: 'Loading diff…' })}
                </div>
              ) : diffBinary ? (
                <p className="text-xs text-zinc-500" data-testid="pr-diff-binary">{t('git:pr.binary_omitted', { defaultValue: 'Binary files are omitted from this preview.' })}</p>
              ) : diff ? (
                <>
                  <pre className="whitespace-pre-wrap font-mono text-xs text-zinc-700">{diff}</pre>
                  {diffTruncated && (
                    <p className="mt-2 text-xs text-amber-700" data-testid="pr-diff-truncated">{t('git:pr.diff_truncated', { defaultValue: 'Diff truncated due to size.' })}</p>
                  )}
                </>
              ) : (
                <p className="text-xs text-zinc-500">{t('git:pr.no_diff', { defaultValue: 'No diff available.' })}</p>
              )}
            </div>
          )}
        </div>
      </ConsoleStructuredDialogBody>
      {effectiveSourceBranch === targetBranch && (
        <div className="px-5 py-1.5 text-[11px] text-amber-700 bg-amber-50 border-t border-amber-200">
          {t('git:pr.same_branch_error', { defaultValue: 'Source and target branches must be different.' })}
        </div>
      )}
      <ConsoleStructuredDialogFooter>
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          {t('common:action.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!title.trim() || !effectiveSourceBranch || effectiveSourceBranch === targetBranch || creating}
          onClick={handleCreate}
        >
          {creating ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {t('git:pr.creating', { defaultValue: 'Creating…' })}
            </>
          ) : (
            <>
              {t('git:create_pull_request_btn')}
              <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </>
          )}
        </Button>
      </ConsoleStructuredDialogFooter>
    </ConsoleDialogShell>
  );
}
