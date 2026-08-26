import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronDown, ChevronRight, FileWarning, Loader2, RefreshCw, GitMerge } from 'lucide-react';
import Button from '../Button';
import { useToast } from '../Toast';
import * as gitApi from '../../lib/gitApi';
import MergeEditorDialog from './MergeEditorDialog';
import {
  consoleIconButtonClass,
  textPrimary,
  textSecondary,
  textPlaceholder,
  borderHairline,
  bgCanvas,
} from '../../lib/consoleTokens';

export function ConflictFileItem({ file, projectId, onResolved }) {
  const { showToast } = useToast();
  const [mergeOpen, setMergeOpen] = useState(false);
  const [oursContent, setOursContent] = useState(null);
  const [theirsContent, setTheirsContent] = useState(null);
  const [loading, setLoading] = useState(false);

  const openMerge = useCallback(async () => {
    setMergeOpen(true);
    setLoading(true);
    try {
      const [oursRes, theirsRes] = await Promise.all([
        gitApi.getFileAtRef(projectId, file.path, 'HEAD').catch(() => ({ content: '(unable to load)' })),
        gitApi.getFileAtRef(projectId, file.path, 'MERGE_HEAD').catch(() => ({ content: '(unable to load)' })),
      ]);
      setOursContent(oursRes.content || '');
      setTheirsContent(theirsRes.content || '');
    } catch {
      showToast('error', `Failed to load file content for ${file.path}`);
    } finally {
      setLoading(false);
    }
  }, [projectId, file, showToast]);

  return (
    <>
      <div className={`border ${borderHairline} rounded-lg overflow-hidden`}>
        <button
          type="button"
          onClick={openMerge}
          className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${bgCanvas} hover:bg-zinc-100 transition-colors`}
        >
          <GitMerge className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="font-mono text-xs truncate flex-1">{file.path}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        </button>
      </div>
      <MergeEditorDialog
        open={mergeOpen}
        file={file}
        projectId={projectId}
        oursContent={oursContent}
        theirsContent={theirsContent}
        loading={loading}
        onClose={() => setMergeOpen(false)}
        onResolved={onResolved}
      />
    </>
  );
}

export default function ConflictResolutionPanel({ projectId, targetBranch }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const [checking, setChecking] = useState(false);

  const fetchConflicts = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await gitApi.listConflicts(projectId);
      setConflicts(data.conflicts || []);
    } catch (err) {
      if (!err.message?.includes('No conflicts')) {
        showToast('error', err.message);
      }
      setConflicts([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, showToast]);

  const checkConflicts = useCallback(async () => {
    if (!projectId || !targetBranch) return;
    setChecking(true);
    try {
      const result = await gitApi.conflictCheck(projectId, targetBranch);
      setCheckResult(result);
      if (!result.canMerge) {
        showToast('warning', `${result.conflictFiles?.length || 0} conflict(s) detected.`);
      } else {
        showToast('success', 'No conflicts — branches can be merged cleanly.');
      }
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setChecking(false);
    }
  }, [projectId, targetBranch, showToast]);

  useEffect(() => {
    fetchConflicts();
  }, [fetchConflicts]);

  const handleResolved = (resolvedPath) => {
    setConflicts((prev) => prev.filter((f) => f.path !== resolvedPath));
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <h3 className={`text-sm font-semibold ${textPrimary}`}>{t('git:conflict_resolution')}</h3>
          {conflicts.length > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
              {conflicts.length} file{conflicts.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {targetBranch && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={checkConflicts}
              disabled={checking}
            >
              {checking ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  {t('common:action.checking', { defaultValue: 'Checking…' })}
                </>
              ) : (
                t('git:check_conflicts', { defaultValue: 'Check conflicts' })
              )}
            </Button>
          )}
          <button
            type="button"
            onClick={fetchConflicts}
            disabled={loading}
            title={t('common:action.refresh', { defaultValue: 'Refresh' })}
            className={consoleIconButtonClass}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {checkResult && (
        <div className={`px-4 py-2 border-b border-zinc-200 text-xs ${bgCanvas}`}>
          <div className="flex items-center gap-3">
            <span className={checkResult.canMerge ? 'text-green-700' : 'text-amber-700'}>
              {checkResult.canMerge ? '✓ Clean merge possible' : `✗ ${checkResult.conflictFiles?.length || 0} conflict(s)`}
            </span>
            {checkResult.aheadBehind && (
              <span className={textSecondary}>
                ↑{checkResult.aheadBehind.ahead} ↓{checkResult.aheadBehind.behind}
              </span>
            )}
          </div>
          {!checkResult.canMerge && checkResult.conflictFiles?.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {checkResult.conflictFiles.map((f) => (
                <span key={f} className="inline-block rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700">
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('git:loading_conflicts', { defaultValue: 'Loading conflicts…' })}
          </div>
        ) : conflicts.length === 0 ? (
          <div className="text-center py-8">
            <Check className="mx-auto h-8 w-8 text-green-500 mb-2" />
            <p className={`text-sm ${textSecondary}`}>{t('git:no_conflicts', { defaultValue: 'No conflicts in the working tree.' })}</p>
            <p className={`text-xs mt-1 ${textPlaceholder}`}>
              {t('git:no_conflicts_hint', { defaultValue: 'Use "Check conflicts" to dry-run merge against a target branch.' })}
            </p>
          </div>
        ) : (
          conflicts.map((file) => (
            <ConflictFileItem
              key={file.path}
              file={file}
              projectId={projectId}
              onResolved={handleResolved}
            />
          ))
        )}
      </div>
    </div>
  );
}
