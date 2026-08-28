import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Check, X, GitMerge } from 'lucide-react';
import { ConsoleDialogShell, ConsoleStructuredDialogFooter } from '../ConsoleDialog';
import { buttonClass } from '../../lib/buttonStyles';
import { consoleButtonFocusClass, textPlaceholder } from '../../lib/consoleTokens';
import { Editor } from '@monaco-editor/react';
import '@/lib/monacoSetup';
import * as gitApi from '../../lib/gitApi';
import { useToast } from '../Toast';
import { useTheme } from '../../hooks/useTheme';

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

/**
 * Simple LCS-based line diff.
 * Returns array of { type: 'equal'|'added'|'removed', origLine, modLine }
 */
function computeLineDiff(original, modified) {
  const a = original.split('\n');
  const b = modified.split('\n');
  const m = a.length;
  const n = b.length;

  // Cap to avoid O(n*m) blowup on very large files
  if (m > 2000 || n > 2000) return [];

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'equal', origLine: i, modLine: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'added', origLine: null, modLine: j });
      j--;
    } else {
      result.unshift({ type: 'removed', origLine: i, modLine: null });
      i--;
    }
  }
  return result;
}

function diffToDecorations(diff, side) {
  // side='orig' → red for removed lines; side='mod' → green for added lines
  const decorations = [];
  for (const item of diff) {
    if (side === 'orig' && item.type === 'removed' && item.origLine) {
      decorations.push({
        range: { startLineNumber: item.origLine, endLineNumber: item.origLine, startColumn: 1, endColumn: 1 },
        options: { isWholeLine: true, className: 'merge-diff-removed', marginClassName: 'merge-diff-removed-margin' },
      });
    }
    if (side === 'mod' && item.type === 'added' && item.modLine) {
      decorations.push({
        range: { startLineNumber: item.modLine, endLineNumber: item.modLine, startColumn: 1, endColumn: 1 },
        options: { isWholeLine: true, className: 'merge-diff-added', marginClassName: 'merge-diff-added-margin' },
      });
    }
  }
  return decorations;
}

const MONACO_OPTIONS_BASE = {
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: 'on',
  fontSize: 13,
  fontFamily: "'Noto Sans Mono', 'Fira Code', monospace",
  automaticLayout: true,
  lineNumbers: 'on',
  renderWhitespace: 'none',
  scrollbar: { vertical: 'auto', horizontal: 'auto', verticalScrollbarSize: 8 },
};

export default function MergeEditorDialog({ open, file, projectId, oursContent, theirsContent, loading, onClose, onResolved }) {
  const { t } = useTranslation();
  const { isDark } = useTheme();
  const { showToast } = useToast();
  const [mergedContent, setMergedContent] = useState('');
  const [saving, setSaving] = useState(false);

  const oursEditorRef = useRef(null);
  const mergedEditorRef = useRef(null);
  const theirsEditorRef = useRef(null);
  const syncingRef = useRef(false);

  const language = inferLanguage(file?.path);

  useEffect(() => {
    if (open && oursContent != null) {
      setMergedContent(oursContent);
    }
  }, [open, oursContent]);

  // Compute diff decorations
  const diff = useRef(null);
  useEffect(() => {
    if (oursContent != null && theirsContent != null) {
      diff.current = computeLineDiff(oursContent, theirsContent);
    } else {
      diff.current = null;
    }
  }, [oursContent, theirsContent]);

  // Apply decorations when editors are ready
  const applyDecorations = useCallback(() => {
    if (!diff.current) return;
    const origDecos = diffToDecorations(diff.current, 'orig');
    const modDecos = diffToDecorations(diff.current, 'mod');
    try { oursEditorRef.current?.deltaDecorations([], origDecos); } catch { /* */ }
    try { theirsEditorRef.current?.deltaDecorations([], modDecos); } catch { /* */ }
  }, []);

  // Scroll sync between all three editors
  const syncScroll = useCallback((source, scrollTop) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      if (source !== 'ours' && oursEditorRef.current) oursEditorRef.current.setScrollTop(scrollTop);
      if (source !== 'merged' && mergedEditorRef.current) mergedEditorRef.current.setScrollTop(scrollTop);
      if (source !== 'theirs' && theirsEditorRef.current) theirsEditorRef.current.setScrollTop(scrollTop);
    } finally {
      syncingRef.current = false;
    }
  }, []);

  const handleOursMount = useCallback((editor) => {
    oursEditorRef.current = editor;
    editor.onDidScrollChange((e) => { if (e.scrollTopChanged) syncScroll('ours', e.scrollTop); });
    setTimeout(applyDecorations, 100);
  }, [syncScroll, applyDecorations]);

  const handleMergedMount = useCallback((editor) => {
    mergedEditorRef.current = editor;
    editor.onDidScrollChange((e) => { if (e.scrollTopChanged) syncScroll('merged', e.scrollTop); });
  }, [syncScroll]);

  const handleTheirsMount = useCallback((editor) => {
    theirsEditorRef.current = editor;
    editor.onDidScrollChange((e) => { if (e.scrollTopChanged) syncScroll('theirs', e.scrollTop); });
    setTimeout(applyDecorations, 100);
  }, [syncScroll, applyDecorations]);

  const handleSave = useCallback(async () => {
    if (!file || !projectId) return;
    setSaving(true);
    try {
      await gitApi.writeWorkspaceFile(projectId, file.path, mergedContent);
      await gitApi.resolveConflict(projectId, file.path, 'manual');
      showToast('success', t('git:toast.conflict_resolved'));
      onResolved?.(file.path);
      onClose();
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setSaving(false);
    }
  }, [file, projectId, mergedContent, showToast, t, onResolved, onClose]);

  const handleUseTheirs = useCallback(() => {
    setMergedContent(theirsContent || '');
  }, [theirsContent]);

  const handleUseOurs = useCallback(() => {
    setMergedContent(oursContent || '');
  }, [oursContent]);

  if (!open) return null;

  const editorHeight = 'h-[60vh]';

  return (
    <ConsoleDialogShell
      onClose={onClose}
      panelClassName="w-[calc(100vw-3rem)] max-w-[1400px] bg-surface border border-zinc-200 shadow-lg rounded-lg flex flex-col max-h-[90vh] overflow-hidden p-0"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 bg-zinc-50 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <GitMerge className="h-4 w-4 text-amber-500 shrink-0" />
          <span className="text-sm font-semibold text-zinc-900 truncate">
            {t('git:merge_conflict_title', { defaultValue: 'Resolve Conflict' })}
          </span>
          <span className="text-xs font-mono text-zinc-500 truncate">{file?.path}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`p-1 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
          title={t('common:action.close', { defaultValue: 'Close' })}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Quick actions */}
      <div className="flex items-center gap-2 px-5 py-2 border-b border-zinc-200 shrink-0">
        <button
          type="button"
          onClick={handleUseOurs}
          className={`px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 rounded ${consoleButtonFocusClass}`}
        >
          {t('git:use_ours', { defaultValue: 'Use ours' })}
        </button>
        <button
          type="button"
          onClick={handleUseTheirs}
          className={`px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 rounded ${consoleButtonFocusClass}`}
        >
          {t('git:use_theirs', { defaultValue: 'Use theirs' })}
        </button>
        <span className={`text-[10px] ${textPlaceholder} ml-2`}>
          {t('git:merge_editor_hint', { defaultValue: 'Edit the middle panel to compose the final file. Red = removed from theirs, green = added in theirs.' })}
        </span>
      </div>

      {/* 3-way editor */}
      {loading ? (
        <div className="flex items-center justify-center h-[60vh]">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : (
        <div className="grid grid-cols-3 divide-x divide-zinc-200 flex-1 min-h-0">
          {/* Ours */}
          <div className="flex flex-col min-w-0">
            <div className="px-3 py-1.5 bg-blue-50 border-b border-zinc-200 shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-700">
                {t('git:ours_current', { defaultValue: 'Ours (current branch)' })}
              </span>
            </div>
            <div className={editorHeight}>
              <Editor
                height="100%"
                language={language}
                value={oursContent || ''}
                theme={isDark ? 'vs-dark' : 'vs'}
                onMount={handleOursMount}
                options={{ ...MONACO_OPTIONS_BASE, readOnly: true }}
              />
            </div>
          </div>

          {/* Merged result (editable) */}
          <div className="flex flex-col min-w-0 ring-2 ring-amber-200 ring-inset">
            <div className="px-3 py-1.5 bg-amber-50 border-b border-zinc-200 shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                {t('git:merged_result', { defaultValue: 'Result (editable)' })}
              </span>
            </div>
            <div className={editorHeight}>
              <Editor
                height="100%"
                language={language}
                value={mergedContent}
                theme={isDark ? 'vs-dark' : 'vs'}
                onMount={handleMergedMount}
                onChange={(val) => setMergedContent(val ?? '')}
                options={MONACO_OPTIONS_BASE}
              />
            </div>
          </div>

          {/* Theirs */}
          <div className="flex flex-col min-w-0">
            <div className="px-3 py-1.5 bg-emerald-50 border-b border-zinc-200 shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                {t('git:theirs_incoming', { defaultValue: 'Theirs (incoming)' })}
              </span>
            </div>
            <div className={editorHeight}>
              <Editor
                height="100%"
                language={language}
                value={theirsContent || ''}
                theme={isDark ? 'vs-dark' : 'vs'}
                onMount={handleTheirsMount}
                options={{ ...MONACO_OPTIONS_BASE, readOnly: true }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <ConsoleStructuredDialogFooter>
        <div className="flex items-center justify-end gap-2 w-full">
          <button
            type="button"
            onClick={onClose}
            className={`${buttonClass('secondary', 'sm')} ${consoleButtonFocusClass}`}
          >
            {t('common:action.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className={`${buttonClass('primary', 'sm')} ${consoleButtonFocusClass}`}
          >
            {saving ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                {t('common:action.saving', { defaultValue: 'Saving…' })}
              </>
            ) : (
              <>
                <Check className="mr-1 h-3 w-3" />
                {t('git:save_and_resolve', { defaultValue: 'Save & resolve' })}
              </>
            )}
          </button>
        </div>
      </ConsoleStructuredDialogFooter>

      {/* CSS for diff decorations */}
      <style>{`
        .merge-diff-added { background-color: rgb(220, 252, 231) !important; }
        .merge-diff-added-margin { background-color: rgb(167, 243, 208) !important; }
        .merge-diff-removed { background-color: rgb(254, 226, 226) !important; }
        .merge-diff-removed-margin { background-color: rgb(254, 202, 202) !important; }
      `}</style>
    </ConsoleDialogShell>
  );
}
