import { useCallback, useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronDown, ChevronRight, FileWarning, Loader2, RefreshCw, Pencil, GitMerge } from 'lucide-react';
import Button from '../Button';
import SelectMenu from '../SelectMenu';
import { useToast } from '../Toast';
import * as gitApi from '../../lib/gitApi';
import { DiffEditor, Editor } from '@monaco-editor/react';
import '@/lib/monacoSetup';
import {
  consoleIconButtonClass,
  consoleButtonFocusClass,
  textPrimary,
  textSecondary,
  textPlaceholder,
  borderHairline,
  bgCanvas,
} from '../../lib/consoleTokens';

const LANG_MAP = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', css: 'css', html: 'html', md: 'markdown', py: 'python',
  rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp',
  sh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql',
  scss: 'scss', less: 'less', xml: 'xml', graphql: 'graphql',
};

function inferLanguage(path) {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop().toLowerCase();
  return LANG_MAP[ext] || 'plaintext';
}

const STRATEGY_OPTIONS = [
  { value: 'ours', label: 'Keep ours' },
  { value: 'theirs', label: 'Keep theirs' },
  { value: 'manual', label: 'Manual merge' },
];

const STRATEGY_DESCRIPTIONS = {
  ours: 'Accept the current branch version',
  theirs: 'Accept the incoming branch version',
  manual: 'Edit the final content manually',
};

export function ConflictFileItem({ file, projectId, onResolved }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [oursContent, setOursContent] = useState(null);
  const [theirsContent, setTheirsContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [strategy, setStrategy] = useState('ours');
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeContent, setMergeContent] = useState('');
  const [saving, setSaving] = useState(false);

  const language = useMemo(() => inferLanguage(file?.path), [file?.path]);

  const loadContents = useCallback(async () => {
    if (!expanded || !projectId || !file) return;
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
  }, [expanded, projectId, file, showToast]);

  useEffect(() => {
    if (expanded) loadContents();
  }, [expanded, loadContents]);

  const startManualMerge = useCallback(() => {
    setStrategy('manual');
    setMergeMode(true);
    setMergeContent(oursContent || '');
  }, [oursContent]);

  const handleResolve = async () => {
    if (strategy === 'manual' && mergeMode) {
      setSaving(true);
      try {
        await gitApi.writeWorkspaceFile(projectId, file.path, mergeContent);
        await gitApi.resolveConflict(projectId, file.path, 'manual');
        showToast('success', t('git:toast.conflict_resolved'));
        onResolved?.(file.path);
      } catch (err) {
        showToast('error', err.message);
      } finally {
        setSaving(false);
      }
      return;
    }
    setResolving(true);
    try {
      await gitApi.resolveConflict(projectId, file.path, strategy);
      showToast('success', t('git:toast.conflict_resolved'));
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
        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${bgCanvas} hover:bg-zinc-100 transition-colors`}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        )}
        <FileWarning className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="font-mono text-xs truncate">{file.path}</span>
      </button>

      {expanded && (
        <div className="border-t border-zinc-200">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-4 text-xs text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('git:loading_file_contents', { defaultValue: 'Loading file contents…' })}
            </div>
          ) : mergeMode ? (
            <>
              <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-100 border-b border-zinc-200">
                <div className="flex items-center gap-2">
                  <Pencil className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                    {t('git:manual_merge_editor', { defaultValue: 'Manual merge — edit the final content' })}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => { setMergeMode(false); setStrategy('ours'); }}
                  className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
                  title={t('common:action.back', { defaultValue: 'Back to diff' })}
                >
                  <ChevronRight className="h-3.5 w-3.5 rotate-180" />
                </button>
              </div>
              <div className="h-64">
                <Editor
                  height="100%"
                  language={language}
                  value={mergeContent}
                  theme="vs"
                  onChange={(val) => setMergeContent(val ?? '')}
                  options={{
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    fontSize: 13,
                    fontFamily: "'Noto Sans Mono', 'Fira Code', monospace",
                    automaticLayout: true,
                  }}
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-100 border-b border-zinc-200">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  {t('git:conflict_diff', { defaultValue: 'Conflict diff — ours vs theirs' })}
                </span>
                <button
                  type="button"
                  onClick={startManualMerge}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
                  title={t('git:manual_merge_hint', { defaultValue: 'Edit the final merged content yourself' })}
                >
                  <GitMerge className="h-3 w-3" />
                  {t('git:manual_merge', { defaultValue: 'Manual merge' })}
                </button>
              </div>
              <div className="h-64">
                <DiffEditor
                  height="100%"
                  language={language}
                  original={oursContent || ''}
                  modified={theirsContent || ''}
                  theme="vs"
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    fontSize: 13,
                    fontFamily: "'Noto Sans Mono', 'Fira Code', monospace",
                    automaticLayout: true,
                    renderSideBySide: true,
                  }}
                />
              </div>
            </>
          )}

          <div className="flex items-center gap-3 px-3 py-2 border-t border-zinc-200 bg-zinc-50">
            {!mergeMode && (
              <>
                <SelectMenu
                  value={strategy}
                  onChange={setStrategy}
                  options={STRATEGY_OPTIONS}
                  className="min-w-[130px]"
                />
                <span className={`text-[10px] ${textPlaceholder}`}>
                  {STRATEGY_DESCRIPTIONS[strategy]}
                </span>
              </>
            )}
            {mergeMode && (
              <span className={`text-[10px] ${textPlaceholder}`}>
                {t('git:manual_merge_save_hint', { defaultValue: 'Save will write the file and mark conflict as resolved' })}
              </span>
            )}
            <Button
              type="button"
              size="sm"
              onClick={handleResolve}
              disabled={resolving || saving}
              className="ml-auto"
            >
              {(resolving || saving) ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  {t('common:action.resolving', { defaultValue: 'Resolving…' })}
                </>
              ) : (
                <>
                  <Check className="mr-1 h-3 w-3" />
                  {mergeMode
                    ? t('git:save_and_resolve', { defaultValue: 'Save & resolve' })
                    : t('git:resolve', { defaultValue: 'Resolve' })}
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
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
