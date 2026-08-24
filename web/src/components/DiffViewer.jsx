import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, X } from 'lucide-react';
import { DiffEditor } from '@monaco-editor/react';
import { consoleButtonFocusClass } from '@/lib/consoleTokens';
import '@/lib/monacoSetup'; // Configure Monaco to load from local bundle, not CDN
import { useTranslation } from 'react-i18next';

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

export default function DiffViewer({
  original,
  modified,
  path,
  loading,
  onClose,
  binary = false,
  truncated = false,
}) {
  const { t } = useTranslation();
  const displayName = path ? path.split('/').pop() : '';
  const language = inferLanguage(path);
  const [diffReady, setDiffReady] = useState(false);
  const editorRef = useRef(null);

  // Reset diffReady when content changes so the loading overlay shows
  // until Monaco finishes computing the new diff decorations.
  useEffect(() => {
    setDiffReady(false);
    // For new files (empty original), Monaco computes the diff synchronously
    // during mount, before onMount can register the onDidUpdateDiff listener.
    // A short timeout (300ms) covers this case.  For modified files, the diff
    // is computed asynchronously; onDidUpdateDiff fires and sets diffReady
    // early.  The timeout is a last-resort fallback only.
    const isEmptyOriginal = !original || original.length === 0;
    const delay = isEmptyOriginal ? 300 : 5000;
    const timer = setTimeout(() => setDiffReady(true), delay);
    return () => clearTimeout(timer);
  }, [original, modified]);

  const handleMount = useCallback((editor) => {
    editorRef.current = editor;
    // Monaco computes diffs asynchronously. Listen for the completion
    // event so we can hide the loading overlay only after decorations
    // are applied (file text + diff markers appear simultaneously).
    if (editor && typeof editor.onDidUpdateDiff === 'function') {
      editor.onDidUpdateDiff(() => {
        setDiffReady(true);
      });
    } else {
      // Fallback: if the API is unavailable, show immediately.
      setDiffReady(true);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col h-full w-full">
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-200 bg-zinc-50">
            <span className="text-sm text-zinc-600">{t('workspace:label.compare', { defaultValue: 'Compare: {{name}}', name: displayName })}</span>
          <button
            aria-label={t('workspace:aria.close_compare', { defaultValue: 'Close compare' })}
            onClick={onClose}
            className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center" data-testid="diff-loading">
          <Loader2 className="animate-spin h-6 w-6 text-zinc-400" />
        </div>
      </div>
    );
  }

  const noDiff = !binary && original === modified;
  // Show loading overlay until Monaco's async diff computation completes.
  // This ensures the file text and diff markers (red/green) appear together
  // instead of text first, markers 1-2s later.
  const showOverlay = !binary && !noDiff && !diffReady;

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-200 bg-zinc-50">
        <span className="text-sm text-zinc-600">{t('workspace:label.compare', { defaultValue: 'Compare: {{name}}', name: displayName })}</span>
        <button
          aria-label={t('workspace:aria.close_compare', { defaultValue: 'Close compare' })}
          onClick={onClose}
          className={`p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 ${consoleButtonFocusClass}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {binary ? (
        <div className="flex-1 flex items-center justify-center text-sm text-zinc-400" data-testid="diff-binary">
          {t('workspace:label.binary_diff', { defaultValue: 'Binary file, cannot display text diff' })}
        </div>
      ) : noDiff ? (
        <div className="flex-1 flex items-center justify-center text-sm text-zinc-400">
          {t('workspace:label.no_differences', { defaultValue: 'No differences' })}
        </div>
      ) : (
        <div className="flex-1 min-h-0 relative">
          <DiffEditor
            height="100%"
            language={language}
            original={original}
            modified={modified}
            theme="vs"
            onMount={handleMount}
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
          {showOverlay && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10" data-testid="diff-computing">
              <Loader2 className="animate-spin h-6 w-6 text-zinc-400" />
            </div>
          )}
          {truncated && (
            <div className="absolute bottom-3 left-3 right-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2" data-testid="diff-truncated">
              {t('workspace:label.content_too_large', { defaultValue: 'Content too large, truncated' })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}