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

  useEffect(() => {
    if (!open || !projectId) return;
    githubApi
      .listBranches(projectId)
      .then(({ branches: rows }) => {
        setBranches(Array.isArray(rows) ? rows : []);
        setBranchesError(null);
      })
      .catch((err) => {
        setBranches([]);
        setBranchesError(err.message || 'Failed to load branches');
      });
  }, [open, projectId]);

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
    }
  }, [open, defaultTargetBranch]);

  useEffect(() => {
    if (!open || !projectId || !sourceBranch) return;
    setDiffLoading(true);
    githubApi
      .getGitDiff(projectId, { base: targetBranch, head: sourceBranch })
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
  }, [open, projectId, sourceBranch, targetBranch]);

  useEffect(() => {
    if (!open || !projectId || !sourceBranch) return;
    if (aiLoadedRef.current) return;
    if (diffLoading) return;
    if (!diff || diffBinary) return;
    setAiLoading(true);
    githubApi
      .generatePRDescription(projectId, { sourceBranch, targetBranch })
      .then((data) => {
        if (data?.title) setTitle(data.title);
        if (data?.body) setBody(data.body);
      })
      .catch(() => {})
      .finally(() => setAiLoading(false));
    aiLoadedRef.current = true;
  }, [open, projectId, sourceBranch, diffLoading, diff, diffBinary]);

  const branchOptions = useMemo(
    () => branches.map((b) => ({ value: b.name, label: b.name })),
    [branches],
  );

  const handleCreate = async () => {
    if (!projectId || !sourceBranch || !title.trim() || sourceBranch === targetBranch) return;
    setCreating(true);
    try {
      const pr = await githubApi.createPullRequest(projectId, {
        title: title.trim(),
        body: body.trim(),
        source_branch: sourceBranch,
        target_branch: targetBranch,
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
        subtitle={`From ${sourceBranch || 'current branch'}`}
      />
      <ConsoleStructuredDialogBody>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FormLabel htmlFor="pr-source">Source branch</FormLabel>
            <Input
              id="pr-source"
              value={sourceBranch || ''}
              readOnly
              className="mt-1.5 bg-zinc-100"
            />
          </div>
          <div>
            <FormLabel htmlFor="pr-target">Target branch</FormLabel>
            {branchesError ? (
              <p className="mt-1.5 text-xs text-red-600">{branchesError}</p>
            ) : (
              <SelectMenu
                id="pr-target"
                value={targetBranch}
                onChange={setTargetBranch}
                options={branchOptions}
                placeholder="Select target branch"
                className="mt-1.5"
              />
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <FormLabel htmlFor="pr-title">Title</FormLabel>
            {(diffLoading || aiLoading) && (
              <span className="flex items-center gap-1 text-[10px] text-zinc-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                {diffLoading
                  ? t('git:pr.loading_diff', { defaultValue: 'Loading diff…' })
                  : t('git:pr.ai_generating', { defaultValue: 'AI generating…' })}
              </span>
            )}
          </div>
          <Input
            id="pr-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={aiLoading
              ? t('git:pr.ai_filling', { defaultValue: 'AI is generating…' })
              : 'feat: describe the change'}
            className="mt-1.5"
            autoFocus
          />
        </div>

        <div>
          <FormLabel htmlFor="pr-body">Description</FormLabel>
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
            {showDiff ? 'Hide diff preview' : 'Show diff preview'}
          </button>
          {showDiff && (
            <div className="mt-2 max-h-48 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-3">
              {diffLoading ? (
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading diff…
                </div>
              ) : diffBinary ? (
                <p className="text-xs text-zinc-500" data-testid="pr-diff-binary">Binary files are omitted from this preview.</p>
              ) : diff ? (
                <>
                  <pre className="whitespace-pre-wrap font-mono text-xs text-zinc-700">{diff}</pre>
                  {diffTruncated && (
                    <p className="mt-2 text-xs text-amber-700" data-testid="pr-diff-truncated">Diff truncated due to size.</p>
                  )}
                </>
              ) : (
                <p className="text-xs text-zinc-500">No diff available.</p>
              )}
            </div>
          )}
        </div>
      </ConsoleStructuredDialogBody>
      {sourceBranch === targetBranch && (
        <div className="px-5 py-1.5 text-[11px] text-amber-700 bg-amber-50 border-t border-amber-200">
          Source and target branches must be different.
        </div>
      )}
      <ConsoleStructuredDialogFooter>
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!title.trim() || !sourceBranch || sourceBranch === targetBranch || creating}
          onClick={handleCreate}
        >
          {creating ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Creating…
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
