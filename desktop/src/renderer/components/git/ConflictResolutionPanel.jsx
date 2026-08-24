import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, FileWarning, Loader2, RefreshCw } from 'lucide-react';
import Button from '../Button';
import SelectMenu from '../SelectMenu';
import { useToast } from '../Toast';
import * as gitApi from '../../lib/gitApi.js';
import {
  consoleIconButtonClass,
  textPrimary,
  textSecondary,
  textPlaceholder,
  borderHairline,
  bgCanvas,
} from '../../lib/consoleTheme';
import { useTranslation } from 'react-i18next';

export function ConflictFileItem({ file, projectId, onResolved }) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const STRATEGY_OPTIONS = [
    { value: 'ours', label: t('git:strategy.keep_ours', { defaultValue: 'Keep ours' }) },
    { value: 'theirs', label: t('git:strategy.keep_theirs', { defaultValue: 'Keep theirs' }) },
    { value: 'manual', label: t('git:strategy.manual_merge', { defaultValue: 'Manual merge' }) },
  ];

  const STRATEGY_DESCRIPTIONS = {
    ours: t('git:strategy.ours_desc', { defaultValue: 'Accept the current branch version' }),
    theirs: t('git:strategy.theirs_desc', { defaultValue: 'Accept the incoming branch version' }),
    manual: t('git:strategy.manual_desc', { defaultValue: 'Mark as manually resolved' }),
  };
  const [expanded, setExpanded] = useState(false);
  const [oursContent, setOursContent] = useState(null);
  const [theirsContent, setTheirsContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [strategy, setStrategy] = useState('ours');

  const loadContents = useCallback(async () => {
    if (!expanded || !projectId || !file) return;
    setLoading(true);
    try {
      const [oursRes, theirsRes] = await Promise.all([
        gitApi.getFileAtRef(projectId, file.path, 'HEAD').catch(() => ({ content: t('git:empty.unable_to_load', { defaultValue: '(unable to load)' }) })),
        gitApi.getFileAtRef(projectId, file.path, 'MERGE_HEAD').catch(() => ({ content: t('git:empty.unable_to_load', { defaultValue: '(unable to load)' }) })),
      ]);
      setOursContent(oursRes.content || '');
      setTheirsContent(theirsRes.content || '');
    } catch {
      showToast('error', t('git:toast.load_content_failed', { path: file.path, defaultValue: 'Failed to load file content for {{path}}' }));
    } finally {
      setLoading(false);
    }
  }, [expanded, projectId, file, showToast, t]);

  useEffect(() => {
    if (expanded) loadContents();
  }, [expanded, loadContents]);

  const handleResolve = async () => {
    setResolving(true);
    try {
      await gitApi.resolveConflict(projectId, file.path, strategy);
      showToast('success', t('git:toast.resolved_strategy', { path: file.path, strategy, defaultValue: 'Resolved {{path}} using "{{strategy}}" strategy.' }));
      onResolved?.(file.path);
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className={`border ${borderHairline} rounded-lg overflow-hidden`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${bgCanvas} hover:bg-[#F4F5F6] transition-colors`}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#5F6368]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#5F6368]" />
        )}
        <FileWarning className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="font-mono text-xs truncate">{file.path}</span>
      </button>

      {expanded && (
        <div className="border-t border-[#E8EAED]">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-4 text-xs text-[#5F6368]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('git:state.loading_file_contents', { defaultValue: 'Loading file contents…' })}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 divide-x divide-[#E8EAED] max-h-64 overflow-auto">
                <div>
                  <div className="sticky top-0 bg-[#F4F5F6] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] border-b border-[#E8EAED]">
                    {t('git:label.ours_current', { defaultValue: 'Ours (current branch)' })}
                  </div>
                  <pre className="p-2 text-xs font-mono whitespace-pre-wrap text-[#202124] overflow-auto">
                    {oursContent || t('git:empty.empty_content', { defaultValue: '(empty)' })}
                  </pre>
                </div>
                <div>
                  <div className="sticky top-0 bg-[#F4F5F6] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5F6368] border-b border-[#E8EAED]">
                    {t('git:label.theirs_incoming', { defaultValue: 'Theirs (incoming)' })}
                  </div>
                  <pre className="p-2 text-xs font-mono whitespace-pre-wrap text-[#202124] overflow-auto">
                    {theirsContent || t('git:empty.empty_content', { defaultValue: '(empty)' })}
                  </pre>
                </div>
              </div>

              <div className="flex items-center gap-3 px-3 py-2 border-t border-[#E8EAED] bg-[#FAFBFC]">
                <SelectMenu
                  value={strategy}
                  onChange={setStrategy}
                  options={STRATEGY_OPTIONS}
                  className="min-w-[130px]"
                />
                <span className={`text-[10px] ${textPlaceholder}`}>
                  {STRATEGY_DESCRIPTIONS[strategy]}
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleResolve}
                  disabled={resolving}
                  className="ml-auto"
                >
                  {resolving ? (
                    <>
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      {t('git:state.resolving', { defaultValue: 'Resolving…' })}
                    </>
                  ) : (
                    <>
                      <Check className="mr-1 h-3 w-3" />
                      {t('git:resolve')}
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function ConflictResolutionPanel({ projectId, targetBranch }) {
  const { showToast } = useToast();
  const { t } = useTranslation();
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
        showToast('warning', t('git:toast.conflicts_detected', { count: result.conflictFiles?.length || 0, defaultValue: '{{count}} conflict(s) detected.' }));
      } else {
        showToast('success', t('git:toast.no_conflicts_clean', { defaultValue: 'No conflicts — branches can be merged cleanly.' }));
      }
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setChecking(false);
    }
  }, [projectId, targetBranch, showToast, t]);

  useEffect(() => {
    fetchConflicts();
  }, [fetchConflicts]);

  const handleResolved = (resolvedPath) => {
    setConflicts((prev) => prev.filter((f) => f.path !== resolvedPath));
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between border-b border-[#E8EAED] px-4 py-2.5 shrink-0">
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
                  {t('git:state.checking', { defaultValue: 'Checking…' })}
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
            title={t('common:action.refresh')}
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
        <div className={`px-4 py-2 border-b border-[#E8EAED] text-xs ${bgCanvas}`}>
          <div className="flex items-center gap-3">
            <span className={checkResult.canMerge ? 'text-green-700' : 'text-amber-700'}>
              {checkResult.canMerge ? t('git:state.clean_merge', { defaultValue: '✓ Clean merge possible' }) : t('git:state.conflicts_found', { count: checkResult.conflictFiles?.length || 0, defaultValue: '✗ {{count}} conflict(s)' })}
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
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#5F6368]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('git:state.loading_conflicts', { defaultValue: 'Loading conflicts…' })}
          </div>
        ) : conflicts.length === 0 ? (
          <div className="text-center py-8">
            <Check className="mx-auto h-8 w-8 text-green-500 mb-2" />
            <p className={`text-sm ${textSecondary}`}>{t('git:empty.no_conflicts_working', { defaultValue: 'No conflicts in the working tree.' })}</p>
            <p className={`text-xs mt-1 ${textPlaceholder}`}>
              {t('git:hint.check_conflicts_dryrun', { defaultValue: 'Use "Check conflicts" to dry-run merge against a target branch.' })}
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